import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// Stub the tmux backend so session-related routes don't spawn real processes.
const { createTmuxSessionMock } = vi.hoisted(() => ({
  createTmuxSessionMock: vi.fn(async (_cfg: unknown, _opts: unknown) => ({ port: 6123, ttydPid: 4242 })),
}))
vi.mock('../../sessions', async (importActual) => {
  const actual = await importActual<typeof import('../../sessions')>()
  return {
    ...actual,
    tmuxBackend: {
      ...actual.tmuxBackend,
      findPort: vi.fn(async () => 6123),
      createTmuxSession: createTmuxSessionMock,
      onTtydRestart: vi.fn(),
    },
  }
})

import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import { emptyGraph, addSnap } from '../../../domain/constellationGraph'

const SPACE_ID = 'space-1'

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
  createTmuxSessionMock.mockClear()
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-constellation-route-test-'))
  testCtx = createTestServer(tmpRoot)
})

afterEach(async () => {
  await testCtx.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('PUT /api/constellation-graph/:spaceId', () => {
  it('stores the graph and returns { ok: true }', async () => {
    const graph = addSnap(emptyGraph(SPACE_ID), 'pw-a', 'run-R1')

    const res = await testCtx.fetch(`/api/constellation-graph/${SPACE_ID}`, {
      method: 'PUT',
      body: JSON.stringify(graph),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as unknown
    expect(body).toMatchObject({ ok: true })

    const stored = testCtx.docStore.getConstellationGraph(SPACE_ID)
    expect(stored).toBeDefined()
    expect(stored).toEqual(graph)
  })

  it('uses the path spaceId even if body contains a different spaceId', async () => {
    const graph = addSnap(emptyGraph('other-space'), 'pw-b', 'run-R2')

    const res = await testCtx.fetch(`/api/constellation-graph/${SPACE_ID}`, {
      method: 'PUT',
      body: JSON.stringify(graph),
    })

    expect(res.status).toBe(200)

    const stored = testCtx.docStore.getConstellationGraph(SPACE_ID)
    expect(stored).toBeDefined()
    expect(stored!.spaceId).toBe(SPACE_ID)
  })

  it('handles URL-encoded spaceId', async () => {
    const encodedSpaceId = 'space%2F1'
    const decodedSpaceId = 'space/1'
    const graph = emptyGraph(decodedSpaceId)

    const res = await testCtx.fetch(`/api/constellation-graph/${encodedSpaceId}`, {
      method: 'PUT',
      body: JSON.stringify(graph),
    })

    expect(res.status).toBe(200)

    const stored = testCtx.docStore.getConstellationGraph(decodedSpaceId)
    expect(stored).toBeDefined()
    expect(stored!.spaceId).toBe(decodedSpaceId)
  })
})
