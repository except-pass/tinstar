import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// Stub the tmux backend so POST /api/sessions doesn't spawn real tmux/ttyd.
// Everything else in the '../../sessions' barrel (createWorktree, loadSecrets,
// getProject, listSessions, …) stays real so the route exercises its true path.
const { createTmuxSessionMock, startTmuxSessionMock } = vi.hoisted(() => ({
  createTmuxSessionMock: vi.fn(async (_cfg: unknown, _opts: unknown) => ({ port: 6123, ttydPid: 4242 })),
  startTmuxSessionMock: vi.fn(async (_cfg: unknown, _opts: unknown) => ({ port: 6123, ttydPid: 4242 })),
}))
vi.mock('../../sessions', async (importActual) => {
  const actual = await importActual<typeof import('../../sessions')>()
  return {
    ...actual,
    tmuxBackend: {
      ...actual.tmuxBackend,
      findPort: vi.fn(async () => 6123),
      createTmuxSession: createTmuxSessionMock,
      startTmuxSession: startTmuxSessionMock,
      onTtydRestart: vi.fn(),
    },
  }
})

import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import type { Run } from '../../../domain/types'

const SPACE_ID = 'spc-create-fixture'
const TASK_ID = 'task-create-fixture'

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
  docStore.upsertSpace(SPACE_ID, { id: SPACE_ID, name: 'Create Space', createdAt: new Date().toISOString() })
  docStore.activeSpaceId = SPACE_ID
  docStore.upsertTask(TASK_ID, {
    id: TASK_ID,
    name: 'Make Widget',
    spaceId: SPACE_ID,
    epicId: '',
    initiativeId: '',
    status: 'open',
  })

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
  startTmuxSessionMock.mockClear()
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-create-route-test-'))
  testCtx = createTestServer(tmpRoot)
})

afterEach(async () => {
  await testCtx.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('POST /api/sessions', () => {
  it('lands computed natsSubscriptions on the run projection (not just the session file)', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'widget-worker', taskId: TASK_ID, nats: { enabled: true } }),
    })

    expect(res.status).toBe(201)

    const run = testCtx.docStore.getRun('widget-worker') as Run
    expect(run).toBeTruthy()
    expect(run.natsEnabled).toBe(true)
    // The bug: the inline create path persisted subscriptions to the session
    // file but omitted them from the run, so the Saloon panel (which reads the
    // run) showed a green dot with no topics. The run must carry them.
    expect(Array.isArray(run.natsSubscriptions)).toBe(true)
    expect(run.natsSubscriptions!.length).toBeGreaterThan(0)
    // Two-tier: broadcast + direct, both rooted at the task token.
    expect(run.natsSubscriptions!.some(s => s.includes('make-widget'))).toBe(true)
  })

  it('forwards a resolved hand\'s prompt to the tmux backend as appendSystemPrompt', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'marshal-worker', hand: 'marshal' }),
    })

    expect(res.status).toBe(201)
    expect(createTmuxSessionMock).toHaveBeenCalledTimes(1)
    const opts = createTmuxSessionMock.mock.calls[0]![1] as unknown as { appendSystemPrompt?: string | null }
    expect(opts.appendSystemPrompt).toBeTruthy()
    expect(opts.appendSystemPrompt!.toLowerCase()).toContain('marshal')
  })

  it('re-threads a hand-created session\'s prompt into startTmuxSession on restart', async () => {
    const created = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'marshal-restart', hand: 'marshal' }),
    })
    expect(created.status).toBe(201)

    // A later /start recreates the tmux process. The hand prompt must be
    // re-injected from persisted session metadata, not silently dropped.
    const restarted = await testCtx.fetch('/api/sessions/marshal-restart/start', { method: 'POST' })
    expect(restarted.status).toBe(200)
    expect(startTmuxSessionMock).toHaveBeenCalledTimes(1)
    const opts = startTmuxSessionMock.mock.calls[0]![1] as unknown as { appendSystemPrompt?: string | null }
    expect(opts.appendSystemPrompt).toBeTruthy()
    expect(opts.appendSystemPrompt!.toLowerCase()).toContain('marshal')
  })

  it('returns NOT_FOUND for an unknown hand', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'ghost-worker', hand: 'does-not-exist' }),
    })
    expect(res.status).toBe(404)
  })
})
