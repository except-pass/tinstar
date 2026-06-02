import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// Stub the tmux backend so session-related routes don't spawn real processes.
vi.mock('../../sessions', async (importActual) => {
  const actual = await importActual<typeof import('../../sessions')>()
  return {
    ...actual,
    tmuxBackend: {
      ...actual.tmuxBackend,
      findPort: vi.fn(async () => 6123),
      createTmuxSession: vi.fn(async () => ({ port: 6123, ttydPid: 4242 })),
      onTtydRestart: vi.fn(),
    },
  }
})

import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import type { BrowserWidget, Run } from '../../../domain/types'

const SPACE_ID = 'space-1'
const SESSION_ID = 'sess-1'

function makeCtx(root: string): RouteContext {
  const cfg = {
    sessions: { prefix: 'tinstar' },
    cliTemplates: [],
    editor: 'vim',
    ports: { ttyd: 7681, hostStart: 5273 },
    dirs: { root, secrets: join(root, 'secrets'), sessions: join(root, 'sessions') },
    files: { config: join(root, 'config.json'), projects: join(root, 'projects.json') },
    git: { taskMarkerRegex: '#([A-Za-z0-9_-]+)', reconciliationRepos: [], reconciliationBranchScope: 'local' },
    nats: { channelServerPackage: '', bunPath: '', jetstream: false },
    uploadMaxBytes: 100 * 1024 * 1024,
    ui: { promptComposerDefault: false, showEmptyEntities: true, layouts: {}, telemetryPanels: { cost: true, tokens: true, cacheHit: false, duty: true, turnLength: true } },
  }
  const docStore = new DocumentStore()
  docStore.upsertSpace(SPACE_ID, { id: SPACE_ID, name: 'Test Space', createdAt: new Date().toISOString() })
  docStore.activeSpaceId = SPACE_ID
  const run: Run = {
    id: 'run-R1', status: 'idle', sessionId: SESSION_ID, taskId: 'task-1',
    initiative: 'init', epic: 'epic', task: 'task', repo: 'repo', worktree: 'wt',
    touchedFiles: [], recapEntries: [], rawLogs: '', port: null, backend: null,
    worktreeId: 'wt-1', createdAt: new Date().toISOString(), spaceId: SPACE_ID, color: '#abc',
  }
  docStore.upsertRun(run.id, run)

  return {
    sessionConfig: cfg,
    docStore,
    bus: { emit: vi.fn() },
    readyQueue: { onStatusChange: vi.fn(), getQueue: () => [] },
    sse: { setReadyQueue: vi.fn(), broadcastReadyQueueUpdate: vi.fn(), addClient: vi.fn() },
    natsTraffic: undefined,
    natsHealth: undefined,
  } as unknown as RouteContext
}

interface TestCtx {
  docStore: DocumentStore
  configFile: string
  fetch(path: string, init?: RequestInit): Promise<Response>
  close(): Promise<void>
}

function createTestServer(root: string): TestCtx {
  const ctx = makeCtx(root)
  const server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(handled => {
      if (!handled) { res.statusCode = 404; res.end() }
    })
  })
  let port: number
  const ready = new Promise<void>(resolve => server.listen(0, () => {
    port = (server.address() as AddressInfo).port
    resolve()
  }))
  return {
    docStore: ctx.docStore,
    configFile: ctx.sessionConfig!.files.config,
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      await ready
      const headers = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) }
      return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers })
    },
    close(): Promise<void> {
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

let tmpRoot: string
let testCtx: TestCtx

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-bw-placement-test-'))
  testCtx = createTestServer(tmpRoot)
})

afterEach(async () => {
  await testCtx.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('POST /api/browser-widgets — placement', () => {
  it('places at an explicit position with a default size', async () => {
    const res = await testCtx.fetch('/api/browser-widgets', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID, url: 'http://x', position: { x: 100, y: 200 } }),
    })
    expect(res.status).toBe(200)
    const { data } = await res.json() as { data: BrowserWidget }
    expect(data.position).toEqual({ x: 100, y: 200 })
    expect(data.size).toEqual({ width: 800, height: 600 })
  })

  it('honors an explicit size alongside position', async () => {
    const res = await testCtx.fetch('/api/browser-widgets', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID, position: { x: 1, y: 2 }, size: { width: 400, height: 300 } }),
    })
    const { data } = await res.json() as { data: BrowserWidget }
    expect(data.size).toEqual({ width: 400, height: 300 })
  })

  it('resolves nearNodeId from config.ui.layouts (places to its right)', async () => {
    // Seed a persisted layout for a reference node in the active space's storage key.
    writeFileSync(testCtx.configFile, JSON.stringify({
      ui: { layouts: { [`tinstar-layouts-v3-${SPACE_ID}`]: { 'pw-bridge': { x: 50, y: 60, width: 300, height: 200 } } } },
    }))

    const res = await testCtx.fetch('/api/browser-widgets', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID, nearNodeId: 'pw-bridge' }),
    })
    const { data } = await res.json() as { data: BrowserWidget }
    // x = 50 + 300 + GAP(20) = 370, y = 60 (same top edge)
    expect(data.position).toEqual({ x: 370, y: 60 })
  })

  it('omits position when nearNodeId has no persisted layout', async () => {
    const res = await testCtx.fetch('/api/browser-widgets', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID, nearNodeId: 'does-not-exist' }),
    })
    const { data } = await res.json() as { data: BrowserWidget }
    expect(data.position).toBeUndefined()
  })

  it('assigns the widget to a constellation slot', async () => {
    const res = await testCtx.fetch('/api/browser-widgets', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID, slot: 3 }),
    })
    const { data } = await res.json() as { data: BrowserWidget }
    const graph = testCtx.docStore.getConstellationGraph(SPACE_ID)
    expect(graph?.members).toContainEqual({ widget: data.id, slot: '3' })
  })

  it('ignores an out-of-range slot', async () => {
    const res = await testCtx.fetch('/api/browser-widgets', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID, slot: 42, snapToSession: false }),
    })
    const { data } = await res.json() as { data: BrowserWidget }
    // Out-of-range slot is ignored — the widget has no slot assignment
    const graph = testCtx.docStore.getConstellationGraph(SPACE_ID)
    if (graph) expect(graph.members.some(m => m.widget === data.id)).toBe(false)
    else expect(graph).toBeUndefined()
  })

  it('still creates a plain widget with no placement fields', async () => {
    const res = await testCtx.fetch('/api/browser-widgets', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID, url: 'http://plain' }),
    })
    const { data } = await res.json() as { data: BrowserWidget }
    expect(data.position).toBeUndefined()
    expect(data.size).toBeUndefined()
    expect(data.url).toBe('http://plain')
  })

  it('creates a browser widget with no sessionId (standalone)', async () => {
    const res = await testCtx.fetch('/api/browser-widgets', {
      method: 'POST',
      body: JSON.stringify({
        url: 'http://example.com',
        position: { x: 100, y: 200 },
        size: { width: 640, height: 480 },
      }),
    })
    const body = await res.json() as { ok: boolean; data: BrowserWidget }
    expect(res.ok).toBe(true)
    expect(body.data.id).toMatch(/^browser-/)
    expect(body.data.sessionId).toBeUndefined()
    expect(body.data.position).toEqual({ x: 100, y: 200 })
    expect(body.data.color).toBe('#5b6b7a') // neutral default when unattached
  })
})

describe('PATCH /api/browser-widgets/:id — placement', () => {
  it('updates position/size and assigns a slot on an existing widget', async () => {
    const created = await (await testCtx.fetch('/api/browser-widgets', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID, url: 'http://x' }),
    })).json() as { data: BrowserWidget }

    const res = await testCtx.fetch(`/api/browser-widgets/${created.data.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ position: { x: 10, y: 20 }, size: { width: 200, height: 150 }, slot: 5 }),
    })
    expect(res.status).toBe(200)
    const { data } = await res.json() as { data: BrowserWidget }
    expect(data.position).toEqual({ x: 10, y: 20 })
    expect(data.size).toEqual({ width: 200, height: 150 })
    const graph = testCtx.docStore.getConstellationGraph(SPACE_ID)
    expect(graph?.members).toContainEqual({ widget: created.data.id, slot: '5' })
  })

  it('does not persist transient placement keys onto the widget', async () => {
    const created = await (await testCtx.fetch('/api/browser-widgets', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID }),
    })).json() as { data: BrowserWidget }

    await testCtx.fetch(`/api/browser-widgets/${created.data.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Renamed', nearNodeId: 'whatever', slot: 2 }),
    })
    const stored = testCtx.docStore.getAllBrowserWidgets().find(w => w.id === created.data.id)
    expect(stored?.title).toBe('Renamed')
    expect((stored as unknown as Record<string, unknown>).nearNodeId).toBeUndefined()
    expect((stored as unknown as Record<string, unknown>).slot).toBeUndefined()
  })
})
