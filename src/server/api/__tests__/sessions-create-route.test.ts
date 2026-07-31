import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, request as createHttpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'

// Stub the tmux backend so POST /api/sessions doesn't spawn real tmux/ttyd.
// Everything else in the '../../sessions' barrel (createWorktree, loadSecrets,
// getProject, listSessions, …) stays real so the route exercises its true path.
const {
  createTmuxSessionMock,
  findPortMock,
  releasePortMock,
  startTmuxSessionMock,
  stopTmuxSessionMock,
  sendPromptMock,
  getTmuxSessionStateMock,
  managedTtydPortMock,
  onTtydRestartMock,
  createWorktreeMock,
  dispatchSurfaceAuthorMock,
} = vi.hoisted(() => ({
  createTmuxSessionMock: vi.fn(async (_cfg: unknown, _opts: unknown) => ({ port: 6123, ttydPid: 4242 })),
  findPortMock: vi.fn(async () => 6123),
  releasePortMock: vi.fn(),
  startTmuxSessionMock: vi.fn(async (_cfg: unknown, _opts: unknown) => ({ port: 6123, ttydPid: 4242 })),
  stopTmuxSessionMock: vi.fn(async () => undefined),
  sendPromptMock: vi.fn(async () => undefined),
  getTmuxSessionStateMock: vi.fn(
    async (): Promise<'exists' | 'missing'> => 'missing',
  ),
  managedTtydPortMock: vi.fn((): number | null => null),
  onTtydRestartMock: vi.fn(),
  createWorktreeMock: vi.fn(),
  dispatchSurfaceAuthorMock: vi.fn(() => ({ dispatched: false })),
}))
vi.mock('../../sessions', async (importActual) => {
  const actual = await importActual<typeof import('../../sessions')>()
  createWorktreeMock.mockImplementation(actual.createWorktree)
  return {
    ...actual,
    createWorktree: createWorktreeMock,
    tmuxBackend: {
      ...actual.tmuxBackend,
      findPort: findPortMock,
      releasePort: releasePortMock,
      createTmuxSession: createTmuxSessionMock,
      startTmuxSession: startTmuxSessionMock,
      stopTmuxSession: stopTmuxSessionMock,
      deleteTmuxSession: stopTmuxSessionMock,
      sendPrompt: sendPromptMock,
      getTmuxSessionState: getTmuxSessionStateMock,
      managedTtydPort: managedTtydPortMock,
      onTtydRestart: onTtydRestartMock,
    },
  }
})

vi.mock('../../hands', async (importActual) => {
  const actual = await importActual<typeof import('../../hands')>()
  return {
    ...actual,
    getHandByName: (name: string) => name === 'codex-hand'
      ? {
          name,
          description: 'A Codex-backed test hand',
          cliTemplate: 'Codex',
          prompt: 'Review the task.',
        }
      : actual.getHandByName(name),
  }
})

vi.mock('../../sessions/surfaceAuthor', () => ({
  dispatchSurfaceAuthor: dispatchSurfaceAuthorMock,
}))

import {
  acquirePersistedSessionBackendLeaseForConfig,
  finishBootSessionDeletion,
  handleRequest,
  persistedSessionBackendGenerationForConfig,
  persistTtydRestartForSessionIncarnation,
  reserveBootSessionDeletion,
  resetSessionBackendOwnersForTests,
  type RouteContext,
} from '../routes'
import {
  createSession,
  createWorktree,
  deleteSession,
  getSession,
  setState,
  updateSession,
} from '../../sessions'
import { DocumentStore } from '../../stores/document-store'
import type { Notice, Run } from '../../../domain/types'
import { graveyardSnapshotPath } from '../../sessions/graveyard-snapshot'
import { natsControlSocketPath } from '../../sessions/backends/tmux'
import {
  createDefaultProviderRegistry,
  type TerminalProviderAdapter,
} from '../../providers/lifecycle'

const SPACE_ID = 'spc-create-fixture'
const TASK_ID = 'task-create-fixture'

function makeCtx(root: string): RouteContext {
  const cfg = {
    sessions: { prefix: 'tinstar' },
    cliTemplates: [
      { id: 'Claude', name: 'Claude', adapter: 'claude', startCmd: 'claude --session-id {sessionId} -- {prompt}', resumeCmd: 'claude --resume {sessionId}' },
      { id: 'marshal', name: 'Marshal', adapter: 'claude', startCmd: 'claude --session-id {sessionId} -- {prompt}', resumeCmd: 'claude --resume {sessionId}' },
      { id: 'Cursor Agent', name: 'Cursor Agent', adapter: 'generic', startCmd: 'agent --yolo -- {prompt}', resumeCmd: 'agent --yolo resume' },
      { id: 'Codex', name: 'Codex', adapter: 'codex', startCmd: 'codex --sandbox workspace-write -- {prompt}', resumeCmd: 'codex resume --last --sandbox workspace-write' },
    ],
    editor: 'vim',
    ports: { ttyd: 7681, hostStart: 5273 },
    dirs: { root, secrets: join(root, 'secrets'), sessions: join(root, 'sessions') },
    files: { config: join(root, 'config.json'), projects: join(root, 'projects.json') },
    git: { taskMarkerRegex: '#([A-Za-z0-9_-]+)', reconciliationRepos: [], reconciliationBranchScope: 'local' },
    nats: { channelServerPackage: '', bunPath: '', jetstream: false },
    slate: { author: { enabled: true, model: 'test-model', timeoutMs: 1000 } },
    uploadMaxBytes: 100 * 1024 * 1024,
    ui: { promptComposerDefault: false, showEmptyEntities: true, layouts: {}, telemetryPanels: { cost: true, tokens: true, cacheHit: false, duty: true, turnLength: true } },
    switchboard: { allowedModels: ['opus', 'sonnet'], allowTokenOverride: true },
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
    readyQueue: { onStatusChange: vi.fn(), onDelete: vi.fn(), getQueue: () => [] },
    sse: { setReadyQueue: vi.fn(), broadcastReadyQueueUpdate: vi.fn(), addClient: vi.fn() },
    natsTraffic: undefined,
    natsHealth: undefined,
  } as unknown as RouteContext
}

interface TestCtx {
  docStore: DocumentStore
  routeContext: RouteContext
  fetch(path: string, init?: RequestInit): Promise<Response>
  openDelayedRequest(path: string, method: string): Promise<{
    started: Promise<void>
    finish(body: string): Promise<Response>
  }>
  close(): Promise<void>
}

function createTestServer(root: string): TestCtx {
  const ctx = makeCtx(root)
  const requestStartedWaiters = new Map<string, Array<() => void>>()
  const server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(handled => {
      const key = `${req.method ?? 'GET'} ${req.url ?? ''}`
      requestStartedWaiters.get(key)?.shift()?.()
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
    routeContext: ctx,
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      await ready
      const headers = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) }
      return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers })
    },
    async openDelayedRequest(path: string, method: string) {
      await ready
      const key = `${method} ${path}`
      let markStarted!: () => void
      const started = new Promise<void>(resolve => { markStarted = resolve })
      const waiters = requestStartedWaiters.get(key) ?? []
      waiters.push(markStarted)
      requestStartedWaiters.set(key, waiters)

      let finishRequest!: (body: string) => void
      const response = new Promise<Response>((resolve, reject) => {
        const request = createHttpRequest({
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: { 'Content-Type': 'application/json' },
        }, incoming => {
          const chunks: Buffer[] = []
          incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
          incoming.on('end', () => {
            const headers = new Headers()
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) headers.append(name, item)
              } else if (value !== undefined) {
                headers.set(name, value)
              }
            }
            resolve(new Response(Buffer.concat(chunks), {
              status: incoming.statusCode ?? 500,
              headers,
            }))
          })
        })
        request.on('error', reject)
        request.flushHeaders()
        finishRequest = body => request.end(body)
      })
      return {
        started,
        finish: async (body: string) => {
          finishRequest(body)
          return response
        },
      }
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
  findPortMock.mockClear()
  releasePortMock.mockClear()
  startTmuxSessionMock.mockClear()
  stopTmuxSessionMock.mockClear()
  sendPromptMock.mockClear()
  getTmuxSessionStateMock.mockClear()
  getTmuxSessionStateMock.mockResolvedValue('missing')
  managedTtydPortMock.mockReset()
  managedTtydPortMock.mockReturnValue(null)
  onTtydRestartMock.mockClear()
  createWorktreeMock.mockClear()
  dispatchSurfaceAuthorMock.mockClear()
  dispatchSurfaceAuthorMock.mockReturnValue({ dispatched: false })
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-create-route-test-'))
  testCtx = createTestServer(tmpRoot)
})

afterEach(async () => {
  await testCtx.close()
  resetSessionBackendOwnersForTests()
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
    // The advertised DM subject is the direct (second) subscription — not the
    // broadcast channel at [0]. Guards that #998's fix didn't alter task agents.
    expect(run.natsSubject).toBe(run.natsSubscriptions![1])
  })

  it('enables NATS by default for a standalone session (active space, no task)', async () => {
    // Regression: standalone sessions (no taskId/epicId/initiativeId, no explicit
    // `nats` arg) used to spawn with NATS off because the auto-enable gate omitted
    // spaceId. They now join the bus.
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'lone-wolf' }),
    })
    expect(res.status).toBe(201)

    const run = testCtx.docStore.getRun('lone-wolf') as Run
    expect(run).toBeTruthy()
    expect(run.natsEnabled).toBe(true)
    // Scope leak guard: a task-less agent gets a DM-ONLY inbox — its own exact
    // direct subject with '_' for the unresolved levels — and NOT a space
    // wildcard. A `tinstar.<space>.>` sub would funnel every task broadcast in
    // the space into an un-seated agent (the remote-control leak).
    expect(run.natsSubscriptions).toEqual(['tinstar.create-space._._._.lone-wolf'])
    expect(run.natsSubscriptions!.some(s => s.includes('>'))).toBe(false)
    // #998: the advertised DM subject must be exactly what the agent subscribes
    // to. It was recomputed by the space-blind buildNatsSubject, yielding a
    // '_'-rooted 'tinstar._._._._.lone-wolf' the agent never listens on — so a
    // sender reading run.natsSubject couldn't reach it. Now derived from the subs.
    expect(run.natsSubject).toBe('tinstar.create-space._._._.lone-wolf')
    expect(run.natsSubject).toBe(run.natsSubscriptions![0])
  })

  it('does NOT default NATS on for a non-claude (generic/cursor) adapter', async () => {
    // NATS is wired via Claude-only flags (--mcp-config), so auto-enabling it for
    // a cursor session would inject --mcp-config into `agent` and crash the launch.
    // A generic-adapter session with just an active space must stay off the bus.
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'cursor-worker', cliTemplate: 'Cursor Agent' }),
    })
    expect(res.status).toBe(201)
    const run = testCtx.docStore.getRun('cursor-worker') as Run
    expect(run).toBeTruthy()
    expect(run.natsEnabled).toBe(false)
    // And the launch opts carry no NATS, so buildAgentCommand emits no --mcp-config.
    const opts = createTmuxSessionMock.mock.calls.at(-1)![1] as unknown as { session: { nats?: { enabled: boolean } | null } }
    expect(opts.session.nats?.enabled ?? false).toBe(false)
  })

  it('rejects explicit NATS for a provider that has no NATS launch capability before provisioning', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'codex-with-unsupported-nats',
        cliTemplate: 'Codex',
        nats: { enabled: true },
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: {
        message: expect.stringContaining(
          'Provider "codex" does not support terminal capability "nats"',
        ),
      },
    })
    expect(createTmuxSessionMock).not.toHaveBeenCalled()
    expect(getSession(join(tmpRoot, 'sessions'), 'codex-with-unsupported-nats')).toBeNull()
  })

  it('rejects a supplied but missing template name before provisioning', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'missing-template', cliTemplate: 'Does Not Exist' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { message: 'CLI template "Does Not Exist" is not configured' },
    })
    expect(findPortMock).not.toHaveBeenCalled()
    expect(createTmuxSessionMock).not.toHaveBeenCalled()
    expect(getSession(join(tmpRoot, 'sessions'), 'missing-template')).toBeNull()
  })

  it('lets the task-scoped route derive NATS from a Codex provider capability', async () => {
    const res = await testCtx.fetch(`/api/tasks/${TASK_ID}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ name: 'task-codex', cliTemplate: 'Codex' }),
    })

    expect(res.status).toBe(201)
    expect(getSession(join(tmpRoot, 'sessions'), 'task-codex')).toMatchObject({
      adapter: 'codex',
      nats: null,
    })
    expect((testCtx.docStore.getRun('task-codex') as Run).natsEnabled).toBe(false)
  })

  it('lets the task-scoped route derive NATS from a runtime provider capability', async () => {
    const forge: TerminalProviderAdapter = {
      provider: { id: 'task-forge', label: 'Task Forge' },
      sessionLifecycle: 'terminal',
      terminal: {
        capabilities: {
          nats: { state: 'unsupported', reason: 'not implemented' },
          telemetry: { state: 'unsupported', reason: 'not implemented' },
        },
        defaultTelemetry: false,
        transcript: null,
      },
    }
    testCtx.routeContext.providerRegistry = createDefaultProviderRegistry([forge])
    testCtx.routeContext.sessionConfig!.cliTemplates.push({
      id: 'task-forge',
      name: 'Task Forge',
      adapter: 'task-forge',
      startCmd: 'task-forge -- {prompt}',
      resumeCmd: 'task-forge resume',
    })

    const res = await testCtx.fetch(`/api/tasks/${TASK_ID}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ name: 'task-forge-worker', cliTemplate: 'task-forge' }),
    })

    expect(res.status).toBe(201)
    expect(getSession(join(tmpRoot, 'sessions'), 'task-forge-worker')).toMatchObject({
      adapter: 'task-forge',
      nats: null,
    })
  })

  it('rejects a non-string task-session name as a client error', async () => {
    const res = await testCtx.fetch(`/api/tasks/${TASK_ID}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ name: 42 }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { message: 'Session name is required' },
    })
    expect(createTmuxSessionMock).not.toHaveBeenCalled()
  })

  it('resolves the same provider adapter for create, resume, and stop', async () => {
    const registry = createDefaultProviderRegistry()
    const resolveSession = vi.spyOn(registry, 'resolveSession')
    testCtx.routeContext.providerRegistry = registry
    const created = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'codex-lifecycle', cliTemplate: 'Codex' }),
    })
    expect(created.status).toBe(201)
    expect((createTmuxSessionMock.mock.calls.at(-1)![1] as {
      provider: { provider: { id: string } }
    }).provider.provider.id).toBe('codex')

    const stopped = await testCtx.fetch('/api/sessions/codex-lifecycle/stop', {
      method: 'POST',
    })
    expect(stopped.status).toBe(200)
    expect(resolveSession).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: 'codex' }),
      expect.objectContaining({ adapter: 'codex' }),
    )

    const started = await testCtx.fetch('/api/sessions/codex-lifecycle/start', {
      method: 'POST',
    })
    expect(started.status).toBe(200)
    expect((startTmuxSessionMock.mock.calls.at(-1)![1] as {
      provider: { provider: { id: string } }
    }).provider.provider.id).toBe('codex')
  })

  it('rejects a concurrent create that targets the same session name', async () => {
    let finishLaunch!: () => void
    createTmuxSessionMock.mockImplementationOnce(
      () => new Promise(resolve => {
        finishLaunch = () => resolve({ port: 6123, ttydPid: 4242 })
      }),
    )

    const first = testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'single-writer' }),
    })
    await vi.waitFor(() => expect(createTmuxSessionMock).toHaveBeenCalledTimes(1))

    const competing = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'single-writer' }),
    })
    expect(competing.status).toBe(409)
    expect(await competing.json()).toMatchObject({
      error: { message: expect.stringContaining('already being created') },
    })

    finishLaunch()
    expect((await first).status).toBe(201)
    expect(createTmuxSessionMock).toHaveBeenCalledTimes(1)
  })

  it('rejects deletion while a create still owns the provisional backend name', async () => {
    let finishLaunch!: () => void
    createTmuxSessionMock.mockImplementationOnce(
      () => new Promise(resolve => {
        finishLaunch = () => resolve({ port: 6123, ttydPid: 4242 })
      }),
    )
    const creating = testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'delete-race' }),
    })
    await vi.waitFor(() => expect(createTmuxSessionMock).toHaveBeenCalledTimes(1))

    const deleting = await testCtx.fetch('/api/sessions/delete-race', {
      method: 'DELETE',
    })
    expect(deleting.status).toBe(409)

    const competing = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'delete-race' }),
    })
    expect(competing.status).toBe(409)
    expect(createTmuxSessionMock).toHaveBeenCalledTimes(1)

    finishLaunch()
    expect((await creating).status).toBe(201)
  })

  it('retains a failed create name when backend teardown cannot be confirmed', async () => {
    createTmuxSessionMock.mockRejectedValueOnce(new Error('launch failed'))
    getTmuxSessionStateMock.mockResolvedValueOnce('exists')

    const failed = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'orphaned-create' }),
    })
    expect(failed.status).toBe(500)
    const sessionsDir = join(tmpRoot, 'sessions')
    expect(existsSync(join(sessionsDir, 'orphaned-create', '.deleting'))).toBe(true)
    resetSessionBackendOwnersForTests()

    const retry = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'orphaned-create' }),
    })
    expect(retry.status).toBe(409)
    expect(createTmuxSessionMock).toHaveBeenCalledTimes(1)
    expect((await testCtx.fetch('/api/sessions/orphaned-create/start', {
      method: 'POST',
      body: '{}',
    })).status).toBe(409)
  })

  it('retains a deleted name when backend teardown cannot be confirmed', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'orphaned-delete' }),
    })).status).toBe(201)
    getTmuxSessionStateMock.mockResolvedValueOnce('exists')

    expect((await testCtx.fetch('/api/sessions/orphaned-delete', {
      method: 'DELETE',
    })).status).toBe(200)
    await vi.waitFor(() => expect(getTmuxSessionStateMock).toHaveBeenCalled())

    const retry = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'orphaned-delete' }),
    })
    expect(retry.status).toBe(409)
    expect(createTmuxSessionMock).toHaveBeenCalledTimes(1)

    getTmuxSessionStateMock.mockResolvedValueOnce('missing')
    expect((await testCtx.fetch('/api/sessions/orphaned-delete', {
      method: 'DELETE',
    })).status).toBe(200)
    await vi.waitFor(() => expect(getTmuxSessionStateMock).toHaveBeenCalledTimes(2))

    const recovered = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'orphaned-delete' }),
    })
    expect(recovered.status).toBe(201)
    expect(createTmuxSessionMock).toHaveBeenCalledTimes(2)
  })

  it('refuses deletion before teardown when its durable marker cannot be written', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'marker-write-failure' }),
    })).status).toBe(201)
    const sessionDir = join(tmpRoot, 'sessions', 'marker-write-failure')
    mkdirSync(join(sessionDir, '.deleting'))
    stopTmuxSessionMock.mockClear()
    const deleted = await testCtx.fetch('/api/sessions/marker-write-failure', {
      method: 'DELETE',
    })
    expect(deleted.status).toBe(500)
    expect(stopTmuxSessionMock).not.toHaveBeenCalled()
    expect(getSession(join(tmpRoot, 'sessions'), 'marker-write-failure')).not.toBeNull()
  })

  it('rejects start when an orphaned owner still has a persisted record', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'orphaned-start' }),
    })).status).toBe(201)
    getTmuxSessionStateMock.mockResolvedValueOnce('exists')
    expect((await testCtx.fetch('/api/sessions/orphaned-start', {
      method: 'DELETE',
    })).status).toBe(200)
    await vi.waitFor(() => expect(getTmuxSessionStateMock).toHaveBeenCalled())

    createSession(join(tmpRoot, 'sessions'), {
      name: 'orphaned-start',
      backend: 'tmux',
      adapter: 'claude',
      cliTemplate: 'Claude',
    })
    startTmuxSessionMock.mockClear()

    const start = await testCtx.fetch('/api/sessions/orphaned-start/start', {
      method: 'POST',
      body: '{}',
    })
    expect(start.status).toBe(409)
    expect(startTmuxSessionMock).not.toHaveBeenCalled()
  })

  it('rejects start while deletion still owns the backend cleanup', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'delete-start-race' }),
    })).status).toBe(201)
    let finishDelete!: () => void
    stopTmuxSessionMock.mockImplementationOnce(
      () => new Promise<undefined>(resolve => {
        finishDelete = () => resolve(undefined)
      }),
    )

    expect((await testCtx.fetch('/api/sessions/delete-start-race', {
      method: 'DELETE',
    })).status).toBe(200)
    await vi.waitFor(() => expect(stopTmuxSessionMock).toHaveBeenCalled())

    const listedWhileDeleting = await testCtx.fetch('/api/sessions')
    expect(listedWhileDeleting.status).toBe(200)
    expect(
      ((await listedWhileDeleting.json()) as {
        data: Array<{ name: string }>
      }).data.some(session => session.name === 'delete-start-race'),
    ).toBe(false)
    expect(
      (await testCtx.fetch('/api/sessions/delete-start-race')).status,
    ).toBe(404)

    startTmuxSessionMock.mockClear()

    const start = await testCtx.fetch('/api/sessions/delete-start-race/start', {
      method: 'POST',
      body: '{}',
    })
    expect(start.status).toBe(409)
    expect(startTmuxSessionMock).not.toHaveBeenCalled()

    finishDelete()
    await vi.waitFor(() => expect(getTmuxSessionStateMock).toHaveBeenCalled())
  })

  it('rejects deletion while start still owns the backend launch', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'start-delete-race' }),
    })).status).toBe(201)
    expect((await testCtx.fetch('/api/sessions/start-delete-race/stop', {
      method: 'POST',
    })).status).toBe(200)

    let finishStart!: () => void
    startTmuxSessionMock.mockImplementationOnce(
      () => new Promise(resolve => {
        finishStart = () => resolve({ port: 6123, ttydPid: 4242 })
      }),
    )
    const starting = testCtx.fetch('/api/sessions/start-delete-race/start', {
      method: 'POST',
      body: '{}',
    })
    await vi.waitFor(() => expect(startTmuxSessionMock).toHaveBeenCalled())
    stopTmuxSessionMock.mockClear()

    const deleting = await testCtx.fetch('/api/sessions/start-delete-race', {
      method: 'DELETE',
    })
    expect(deleting.status).toBe(409)
    expect(stopTmuxSessionMock).not.toHaveBeenCalled()
    expect(getSession(join(tmpRoot, 'sessions'), 'start-delete-race')).not.toBeNull()

    finishStart()
    expect((await starting).status).toBe(200)
  })

  it('holds a backend lease until a queued prompt settles', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'leased-prompt' }),
    })).status).toBe(201)
    let finishPrompt!: () => void
    sendPromptMock.mockImplementationOnce(
      () => new Promise<undefined>(resolve => {
        finishPrompt = () => resolve(undefined)
      }),
    )

    const prompting = testCtx.fetch('/api/sessions/leased-prompt/prompt', {
      method: 'POST',
      body: JSON.stringify({ text: 'deliver once', force: true }),
    })
    await vi.waitFor(() => expect(sendPromptMock).toHaveBeenCalledTimes(1))

    expect((await testCtx.fetch('/api/sessions/leased-prompt', {
      method: 'DELETE',
    })).status).toBe(409)
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'leased-prompt' }),
    })).status).toBe(409)

    finishPrompt()
    expect((await prompting).status).toBe(200)
    expect(sendPromptMock).toHaveBeenCalledTimes(1)

    expect((await testCtx.fetch('/api/sessions/leased-prompt', {
      method: 'DELETE',
    })).status).toBe(200)
    await vi.waitFor(() => {
      expect(getSession(join(tmpRoot, 'sessions'), 'leased-prompt')).toBeNull()
    })
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'leased-prompt' }),
    })).status).toBe(201)
    expect(sendPromptMock).toHaveBeenCalledTimes(1)
  })

  it('does not deliver a delayed notice reply to a same-name replacement session', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'notice-generation' }),
    })).status).toBe(201)
    const now = Date.now()
    const notice: Notice = {
      id: 'notice-generation-race',
      runId: 'notice-generation',
      kind: 'fyi',
      headline: 'Original incarnation',
      createdAt: now,
      amendedAt: now,
    }
    testCtx.docStore.upsertNotice(notice)

    const delayed = await testCtx.openDelayedRequest(
      '/api/notices/notice-generation-race/replies',
      'POST',
    )
    await delayed.started

    expect((await testCtx.fetch('/api/sessions/notice-generation', {
      method: 'DELETE',
    })).status).toBe(200)
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'notice-generation' }),
    })).status).toBe(201)
    testCtx.docStore.upsertNotice({
      ...notice,
      headline: 'Replacement incarnation',
      createdAt: now + 1,
      amendedAt: now + 1,
    })
    sendPromptMock.mockClear()

    const response = await delayed.finish(JSON.stringify({
      author: 'user',
      text: 'This belongs to the original session',
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { delivered: false },
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it('does not dispatch a delayed Slate author into a same-name replacement workspace', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'compose-generation' }),
    })).status).toBe(201)

    const delayed = await testCtx.openDelayedRequest(
      '/api/runs/compose-generation/slate/compose',
      'POST',
    )
    await delayed.started

    expect((await testCtx.fetch('/api/sessions/compose-generation', {
      method: 'DELETE',
    })).status).toBe(200)
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'compose-generation' }),
    })).status).toBe(201)
    dispatchSurfaceAuthorMock.mockClear()
    sendPromptMock.mockClear()

    const response = await delayed.finish(JSON.stringify({
      freeform: 'Author this in the original workspace',
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { delivered: false },
    })
    expect(dispatchSurfaceAuthorMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it('rejects delayed NATS rewiring for a same-name replacement session', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'nats-generation', nats: { enabled: true } }),
    })).status).toBe(201)

    const delayed = await testCtx.openDelayedRequest('/api/runs/nats-generation', 'PATCH')
    await delayed.started

    expect((await testCtx.fetch('/api/sessions/nats-generation', {
      method: 'DELETE',
    })).status).toBe(200)
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'nats-generation', nats: { enabled: true } }),
    })).status).toBe(201)

    const response = await delayed.finish(JSON.stringify({
      taskId: TASK_ID,
      background: true,
      attention: { level: 'urgent', reason: 'stale request' },
      name: 'Stale replacement name',
    }))
    expect(response.status).toBe(409)
    const replacement = testCtx.docStore.getRun('nats-generation')
    expect(replacement?.background).toBe(false)
    expect(replacement?.attention).toBeUndefined()
    expect(replacement?.name).toBeUndefined()
    expect(replacement?.taskId).not.toBe(TASK_ID)
    expect(getSession(join(tmpRoot, 'sessions'), 'nats-generation')).toMatchObject({
      background: false,
    })
  })

  it('rejects a delayed background-only patch for a same-name replacement session', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'background-generation' }),
    })).status).toBe(201)

    const delayed = await testCtx.openDelayedRequest('/api/runs/background-generation', 'PATCH')
    await delayed.started

    expect((await testCtx.fetch('/api/sessions/background-generation', {
      method: 'DELETE',
    })).status).toBe(200)
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'background-generation' }),
    })).status).toBe(201)

    expect((await delayed.finish(JSON.stringify({ background: true }))).status).toBe(409)
    expect(testCtx.docStore.getRun('background-generation')?.background).toBe(false)
    expect(getSession(join(tmpRoot, 'sessions'), 'background-generation')).toMatchObject({
      background: false,
    })
  })

  it('rejects a delayed docstore-only patch when the run becomes a managed session', async () => {
    const id = 'plugin-to-managed-generation'
    testCtx.docStore.upsertRun(id, {
      id,
      status: 'idle',
      background: false,
      blocked: false,
      sessionId: id,
      taskId: '',
      worktreeId: '',
      createdAt: '2026-07-30T00:00:00.000Z',
      initiative: '',
      epic: '',
      task: '',
      repo: '',
      worktree: '',
      touchedFiles: [],
      recapEntries: [],
      rawLogs: '',
      port: null,
      backend: null,
      natsControlOrphanedAt: null,
    } satisfies Run)

    const delayed = await testCtx.openDelayedRequest(`/api/runs/${id}`, 'PATCH')
    await delayed.started

    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: id }),
    })).status).toBe(201)

    expect((await delayed.finish(JSON.stringify({ background: true }))).status).toBe(409)
    expect(testCtx.docStore.getRun(id)?.background).toBe(false)
    expect(getSession(join(tmpRoot, 'sessions'), id)).toMatchObject({
      background: false,
    })
  })

  it('does not reserve a ghost backend owner when a backend route targets a missing session', async () => {
    expect((await testCtx.fetch('/api/sessions/future-session/send-keys', {
      method: 'POST',
      body: JSON.stringify({ keys: ['Enter'] }),
    })).status).toBe(409)

    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'future-session' }),
    })).status).toBe(201)
  })

  it('rejects docstore-only deletion while the same backend identity is being created', async () => {
    const name = 'inflight-docstore-delete'
    const repo = join(tmpRoot, 'proj')
    execFileSync('git', ['init', '-q', repo], { encoding: 'utf-8' })
    writeFileSync(join(tmpRoot, 'projects.json'), JSON.stringify({ proj: repo }))
    testCtx.docStore.upsertRun(name, {
      id: name,
      sessionId: name,
      status: 'running',
      port: null,
      backend: null,
    } as Run)
    let finishWorktree!: () => void
    createWorktreeMock.mockImplementationOnce(
      () => new Promise(resolve => {
        finishWorktree = () => resolve({
          path: join(`${repo}-worktrees`, name),
          created: false,
        })
      }),
    )

    const creating = testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name, project: 'proj', worktree: true }),
    })
    await vi.waitFor(() => expect(createWorktreeMock).toHaveBeenCalled())
    expect(getSession(join(tmpRoot, 'sessions'), name)).toBeNull()

    expect((await testCtx.fetch(`/api/sessions/${name}`, {
      method: 'DELETE',
    })).status).toBe(409)
    expect(testCtx.docStore.getRun(name)).toBeDefined()

    finishWorktree()
    expect((await creating).status).toBe(201)
  })

  it('preserves session state when reconciliation observes a busy backend owner', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'stopping-reconcile' }),
    })).status).toBe(201)
    let finishStop!: () => void
    stopTmuxSessionMock.mockImplementationOnce(
      () => new Promise<undefined>(resolve => {
        finishStop = () => resolve(undefined)
      }),
    )
    const stopping = testCtx.fetch('/api/sessions/stopping-reconcile/stop', {
      method: 'POST',
    })
    await vi.waitFor(() => expect(stopTmuxSessionMock).toHaveBeenCalled())
    getTmuxSessionStateMock.mockClear()

    const listed = await testCtx.fetch('/api/sessions')
    expect(listed.status).toBe(200)
    const sessions = (await listed.json()) as { data: Array<{ name: string; state: string }> }
    expect(sessions.data.find(session => session.name === 'stopping-reconcile')).toMatchObject({
      state: 'running',
    })
    expect(getTmuxSessionStateMock).not.toHaveBeenCalled()

    finishStop()
    expect((await stopping).status).toBe(200)
  })

  it('does not let read-only reconciliation block a user stop', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'reconcile-stop' }),
    })).status).toBe(201)
    let finishProbe!: (state: 'exists' | 'missing') => void
    getTmuxSessionStateMock.mockImplementationOnce(
      () => new Promise<'exists' | 'missing'>(resolve => {
        finishProbe = resolve
      }),
    )

    const listing = testCtx.fetch('/api/sessions')
    await vi.waitFor(() => expect(getTmuxSessionStateMock).toHaveBeenCalled())

    const stopped = await testCtx.fetch('/api/sessions/reconcile-stop/stop', {
      method: 'POST',
    })
    expect(stopped.status).toBe(200)

    finishProbe('exists')
    const listed = await listing
    expect(listed.status).toBe(200)
    const sessions = (await listed.json()) as { data: Array<{ name: string; state: string }> }
    expect(sessions.data.find(session => session.name === 'reconcile-stop')).toMatchObject({
      state: 'stopped',
    })
  })

  it('omits a session deleted while read-only reconciliation is pending', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'reconcile-delete' }),
    })).status).toBe(201)
    let finishProbe!: (state: 'exists' | 'missing') => void
    getTmuxSessionStateMock.mockImplementationOnce(
      () => new Promise<'exists' | 'missing'>(resolve => {
        finishProbe = resolve
      }),
    )

    const listing = testCtx.fetch('/api/sessions')
    await vi.waitFor(() => expect(getTmuxSessionStateMock).toHaveBeenCalled())
    expect((await testCtx.fetch('/api/sessions/reconcile-delete', {
      method: 'DELETE',
    })).status).toBe(200)
    await vi.waitFor(() =>
      expect(getSession(join(tmpRoot, 'sessions'), 'reconcile-delete')).toBeNull())

    finishProbe('exists')
    const listed = await listing
    const sessions = (await listed.json()) as { data: Array<{ name: string }> }
    expect(sessions.data.some(session => session.name === 'reconcile-delete')).toBe(false)
  })

  it('does not apply a missing probe across a complete stop and start generation', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'reconcile-restart' }),
    })).status).toBe(201)
    let finishProbe!: (state: 'exists' | 'missing') => void
    getTmuxSessionStateMock.mockImplementationOnce(
      () => new Promise<'exists' | 'missing'>(resolve => {
        finishProbe = resolve
      }),
    )

    const listing = testCtx.fetch('/api/sessions')
    await vi.waitFor(() => expect(getTmuxSessionStateMock).toHaveBeenCalled())
    expect((await testCtx.fetch('/api/sessions/reconcile-restart/stop', {
      method: 'POST',
    })).status).toBe(200)
    expect((await testCtx.fetch('/api/sessions/reconcile-restart/start', {
      method: 'POST',
      body: '{}',
    })).status).toBe(200)

    finishProbe('missing')
    const listed = await listing
    const sessions = (await listed.json()) as { data: Array<{ name: string; state: string }> }
    expect(sessions.data.find(session => session.name === 'reconcile-restart')).toMatchObject({
      state: 'running',
    })
  })

  it('rejects start and stop for a partially deleted session after owner reset', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'restart-mid-delete' }),
    })).status).toBe(201)
    const sessionsDir = join(tmpRoot, 'sessions')
    writeFileSync(join(sessionsDir, 'restart-mid-delete', '.deleting'), '')
    resetSessionBackendOwnersForTests()
    startTmuxSessionMock.mockClear()
    stopTmuxSessionMock.mockClear()

    const start = await testCtx.fetch('/api/sessions/restart-mid-delete/start', {
      method: 'POST',
      body: '{}',
    })
    const stop = await testCtx.fetch('/api/sessions/restart-mid-delete/stop', {
      method: 'POST',
    })
    expect(start.status).toBe(409)
    expect(stop.status).toBe(409)
    expect(startTmuxSessionMock).not.toHaveBeenCalled()
    expect(stopTmuxSessionMock).not.toHaveBeenCalled()

    expect((await testCtx.fetch('/api/sessions/restart-mid-delete', {
      method: 'DELETE',
    })).status).toBe(200)
    await vi.waitFor(() => expect(stopTmuxSessionMock).toHaveBeenCalled())
    await vi.waitFor(() => {
      expect(getSession(sessionsDir, 'restart-mid-delete')).toBeNull()
    })
  })

  it('fences HTTP delete and recreate while boot owns deletion cleanup', async () => {
    const sessionsDir = join(tmpRoot, 'sessions')
    createSession(sessionsDir, {
      name: 'boot-delete-fence',
      backend: 'tmux',
    })
    writeFileSync(join(sessionsDir, 'boot-delete-fence', '.deleting'), '')
    const token = reserveBootSessionDeletion(
      sessionsDir,
      'tinstar',
      'boot-delete-fence',
    )
    expect(token).not.toBeNull()

    expect((await testCtx.fetch('/api/sessions/boot-delete-fence', {
      method: 'DELETE',
    })).status).toBe(409)
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'boot-delete-fence' }),
    })).status).toBe(409)

    expect(deleteSession(sessionsDir, 'boot-delete-fence')).toBe(true)
    finishBootSessionDeletion(
      sessionsDir,
      'boot-delete-fence',
      token!,
      'deleted',
    )
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'boot-delete-fence' }),
    })).status).toBe(201)
  })

  it('fences lifecycle mutation while startup reattach holds its generation lease', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'startup-reattach' }),
    })).status).toBe(201)
    const lease = acquirePersistedSessionBackendLeaseForConfig(
      testCtx.routeContext.sessionConfig!,
      'startup-reattach',
    )
    expect(lease).not.toBeNull()

    expect((await testCtx.fetch('/api/sessions/startup-reattach', {
      method: 'DELETE',
    })).status).toBe(409)
    expect((await testCtx.fetch('/api/sessions/startup-reattach/stop', {
      method: 'POST',
    })).status).toBe(409)

    lease!.release()
    expect((await testCtx.fetch('/api/sessions/startup-reattach', {
      method: 'DELETE',
    })).status).toBe(200)
  })

  it('ignores a stale ttyd restart callback after same-name replacement', () => {
    const sessionsDir = join(tmpRoot, 'sessions')
    createSession(sessionsDir, {
      name: 'ttyd-incarnation',
      backend: 'tmux',
    })
    updateSession(sessionsDir, 'ttyd-incarnation', {
      created: '2026-07-30T00:00:00.000Z',
    })
    const oldCreated = getSession(sessionsDir, 'ttyd-incarnation')!.created
    setState(sessionsDir, 'ttyd-incarnation', 'running')
    const oldGeneration = persistedSessionBackendGenerationForConfig(
      testCtx.routeContext.sessionConfig!,
      'ttyd-incarnation',
    )
    expect(deleteSession(sessionsDir, 'ttyd-incarnation')).toBe(true)
    createSession(sessionsDir, {
      name: 'ttyd-incarnation',
      backend: 'tmux',
    })
    updateSession(sessionsDir, 'ttyd-incarnation', {
      created: '2026-07-31T00:00:00.000Z',
      ttydPid: null,
    })

    expect(persistTtydRestartForSessionIncarnation(
      sessionsDir,
      'ttyd-incarnation',
      oldCreated,
      oldGeneration,
      9999,
    )).toBe(false)
    expect(getSession(sessionsDir, 'ttyd-incarnation')?.ttydPid).toBeNull()
  })

  it('ignores an old ttyd restart callback across stop and stop-start', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'ttyd-lifecycle' }),
    })).status).toBe(201)
    const oldCallback = onTtydRestartMock.mock.calls.at(-1)?.[1] as
      | ((pid: number) => void)
      | undefined
    expect(oldCallback).toBeTypeOf('function')

    expect((await testCtx.fetch('/api/sessions/ttyd-lifecycle/stop', {
      method: 'POST',
    })).status).toBe(200)
    oldCallback!(9001)
    expect(
      getSession(join(tmpRoot, 'sessions'), 'ttyd-lifecycle')?.ttydPid,
    ).toBeNull()

    expect((await testCtx.fetch('/api/sessions/ttyd-lifecycle/start', {
      method: 'POST',
      body: '{}',
    })).status).toBe(200)
    const currentCallback = onTtydRestartMock.mock.calls.at(-1)?.[1] as
      | ((pid: number) => void)
      | undefined
    oldCallback!(9002)
    expect(
      getSession(join(tmpRoot, 'sessions'), 'ttyd-lifecycle')?.ttydPid,
    ).toBe(4242)

    currentCallback!(9003)
    expect(
      getSession(join(tmpRoot, 'sessions'), 'ttyd-lifecycle')?.ttydPid,
    ).toBe(9003)
  })

  it('invalidates stale probes when reconciliation commits stopped', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'reconcile-generation' }),
    })).status).toBe(201)
    const cfg = testCtx.routeContext.sessionConfig!
    const oldGeneration = persistedSessionBackendGenerationForConfig(
      cfg,
      'reconcile-generation',
    )
    const lease = acquirePersistedSessionBackendLeaseForConfig(
      cfg,
      'reconcile-generation',
      oldGeneration!,
    )
    expect(lease).not.toBeNull()

    const listed = await testCtx.fetch('/api/sessions')
    expect(listed.status).toBe(200)
    expect(
      getSession(join(tmpRoot, 'sessions'), 'reconcile-generation')?.state,
    ).toBe('stopped')
    expect(
      persistedSessionBackendGenerationForConfig(cfg, 'reconcile-generation'),
    ).not.toBe(oldGeneration)

    lease!.release()
    expect((await testCtx.fetch('/api/sessions/reconcile-generation/start', {
      method: 'POST',
      body: '{}',
    })).status).toBe(200)
  })

  it('retries marked deletion even when the durable session record is unreadable', async () => {
    const sessionsDir = join(tmpRoot, 'sessions')
    createSession(sessionsDir, {
      name: 'unreadable-delete',
      backend: 'tmux',
    })
    writeFileSync(join(sessionsDir, 'unreadable-delete', '.deleting'), '')
    writeFileSync(join(sessionsDir, 'unreadable-delete', 'session.json'), '{')
    resetSessionBackendOwnersForTests()
    stopTmuxSessionMock.mockClear()
    releasePortMock.mockClear()
    managedTtydPortMock.mockReturnValueOnce(6123)

    expect((await testCtx.fetch('/api/sessions/unreadable-delete', {
      method: 'DELETE',
    })).status).toBe(200)
    await vi.waitFor(() => expect(stopTmuxSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'unreadable-delete' }),
    ))
    await vi.waitFor(() =>
      expect(existsSync(join(sessionsDir, 'unreadable-delete'))).toBe(false))
    expect(releasePortMock).toHaveBeenCalledWith(6123)
  })

  it('keeps in-flight backend names process-wide across config roots', async () => {
    let finishFirstLaunch!: () => void
    createTmuxSessionMock.mockImplementationOnce(
      () => new Promise(resolve => {
        finishFirstLaunch = () => resolve({ port: 6123, ttydPid: 4242 })
      }),
    )
    const first = testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'shared-backend-name' }),
    })
    await vi.waitFor(() => expect(createTmuxSessionMock).toHaveBeenCalledTimes(1))

    const secondRoot = join(tmpRoot, 'other-config-root')
    mkdirSync(secondRoot, { recursive: true })
    const secondCtx = createTestServer(secondRoot)
    try {
      const second = await secondCtx.fetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: 'shared-backend-name' }),
      })
      expect(second.status).toBe(409)
      expect(await second.json()).toMatchObject({
        error: { message: expect.stringContaining('already being created') },
      })
    } finally {
      await secondCtx.close()
      finishFirstLaunch()
    }

    expect((await first).status).toBe(201)
    expect(createTmuxSessionMock).toHaveBeenCalledTimes(1)
  })

  it('keeps successful backend names owned across later cross-root creates', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'owned-backend-name' }),
    })).status).toBe(201)

    const secondRoot = join(tmpRoot, 'later-config-root')
    mkdirSync(secondRoot, { recursive: true })
    const secondCtx = createTestServer(secondRoot)
    try {
      const second = await secondCtx.fetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: 'owned-backend-name' }),
      })
      expect(second.status).toBe(409)
      expect(await second.json()).toMatchObject({
        error: { message: expect.stringContaining('already exists') },
      })
    } finally {
      await secondCtx.close()
    }

    expect(createTmuxSessionMock).toHaveBeenCalledTimes(1)
  })

  it('rejects distinct raw names that resolve to the same tmux target', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: '-resolved-collision' }),
    })).status).toBe(201)

    const secondRoot = join(tmpRoot, 'prefixed-config-root')
    mkdirSync(secondRoot, { recursive: true })
    const secondCtx = createTestServer(secondRoot)
    secondCtx.routeContext.sessionConfig!.sessions.prefix = 'tinstar-'
    try {
      const second = await secondCtx.fetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: 'resolved-collision' }),
      })
      expect(second.status).toBe(409)
      expect(await second.json()).toMatchObject({
        error: { message: expect.stringContaining('already exists') },
      })
    } finally {
      await secondCtx.close()
    }

    expect(createTmuxSessionMock).toHaveBeenCalledTimes(1)
  })

  it('rejects resume when another root owns the persisted backend identity', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'resume-owner' }),
    })).status).toBe(201)

    const secondRoot = join(tmpRoot, 'resume-conflict-root')
    createSession(join(secondRoot, 'sessions'), {
      name: 'resume-owner',
      backend: 'tmux',
      adapter: 'claude',
      cliTemplate: 'Claude',
    })
    const secondCtx = createTestServer(secondRoot)
    startTmuxSessionMock.mockClear()
    try {
      const resumed = await secondCtx.fetch('/api/sessions/resume-owner/start', {
        method: 'POST',
        body: '{}',
      })
      expect(resumed.status).toBe(409)
      expect(await resumed.json()).toMatchObject({
        error: { message: expect.stringContaining('process-wide backend identity') },
      })
    } finally {
      await secondCtx.close()
    }

    expect(startTmuxSessionMock).not.toHaveBeenCalled()
  })

  it('rejects stop when another root owns the resolved tmux target', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: '-protected-stop' }),
    })).status).toBe(201)

    const secondRoot = join(tmpRoot, 'stop-conflict-root')
    createSession(join(secondRoot, 'sessions'), {
      name: 'protected-stop',
      backend: 'tmux',
      adapter: 'claude',
      cliTemplate: 'Claude',
    })
    const secondCtx = createTestServer(secondRoot)
    secondCtx.routeContext.sessionConfig!.sessions.prefix = 'tinstar-'
    stopTmuxSessionMock.mockClear()
    try {
      const stopped = await secondCtx.fetch(
        '/api/sessions/protected-stop/stop',
        { method: 'POST' },
      )
      expect(stopped.status).toBe(409)
      expect(await stopped.json()).toMatchObject({
        error: { message: expect.stringContaining('process-wide backend identity') },
      })
    } finally {
      await secondCtx.close()
    }

    expect(stopTmuxSessionMock).not.toHaveBeenCalled()
  })

  it('rejects delete when another root owns the resolved tmux target', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: '-protected-delete' }),
    })).status).toBe(201)

    const secondRoot = join(tmpRoot, 'delete-conflict-root')
    const secondSessionsDir = join(secondRoot, 'sessions')
    createSession(secondSessionsDir, {
      name: 'protected-delete',
      backend: 'tmux',
      adapter: 'claude',
      cliTemplate: 'Claude',
    })
    const secondCtx = createTestServer(secondRoot)
    secondCtx.routeContext.sessionConfig!.sessions.prefix = 'tinstar-'
    stopTmuxSessionMock.mockClear()
    try {
      const deleted = await secondCtx.fetch(
        '/api/sessions/protected-delete',
        { method: 'DELETE' },
      )
      expect(deleted.status).toBe(409)
      expect(await deleted.json()).toMatchObject({
        error: { message: expect.stringContaining('process-wide backend identity') },
      })
      expect(getSession(secondSessionsDir, 'protected-delete')).not.toBeNull()
    } finally {
      await secondCtx.close()
    }

    expect(stopTmuxSessionMock).not.toHaveBeenCalled()
  })

  it('rejects shared tmux and NATS access from a colliding root', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: '-protected-access' }),
    })).status).toBe(201)

    const secondRoot = join(tmpRoot, 'backend-access-conflict-root')
    createSession(join(secondRoot, 'sessions'), {
      name: 'protected-access',
      backend: 'tmux',
      adapter: 'claude',
      cliTemplate: 'Claude',
      nats: { enabled: true, subscriptions: ['tinstar.dm.protected-access'] },
    })
    const secondCtx = createTestServer(secondRoot)
    secondCtx.routeContext.sessionConfig!.sessions.prefix = 'tinstar-'
    try {
      const attempts: Array<[string, RequestInit | undefined]> = [
        [
          '/api/sessions/protected-access/send-keys',
          { method: 'POST', body: JSON.stringify({ keys: ['Enter'] }) },
        ],
        ['/api/sessions/protected-access/screen', undefined],
        [
          '/api/sessions/protected-access/enter-prompt',
          { method: 'POST', body: JSON.stringify({ prompt: 'do not deliver' }) },
        ],
        [
          '/api/sessions/protected-access/prompt',
          { method: 'POST', body: JSON.stringify({ text: 'do not deliver', force: true }) },
        ],
        [
          '/api/sessions/protected-access/nats-reconnect',
          { method: 'POST', body: '{}' },
        ],
        ['/api/sessions/protected-access/nats-status', undefined],
        [
          '/api/sessions/protected-access/subscriptions',
          {
            method: 'POST',
            body: JSON.stringify({ subject: 'tinstar.broadcast.forbidden' }),
          },
        ],
        [
          '/api/sessions/protected-access/spawn',
          { method: 'POST', body: JSON.stringify({ hand: 'codex-hand' }) },
        ],
      ]

      for (const [path, init] of attempts) {
        const response = await secondCtx.fetch(path, init)
        expect(response.status, path).toBe(409)
        expect(await response.json()).toMatchObject({
          error: { message: expect.stringContaining('process-wide backend identity') },
        })
      }
    } finally {
      await secondCtx.close()
    }
  })

  it('keeps graveyard revive names away from direct creates still acquiring a worktree', async () => {
    const repo = join(tmpRoot, 'proj')
    execFileSync('git', ['init', '-q', repo], { encoding: 'utf-8' })
    writeFileSync(join(tmpRoot, 'projects.json'), JSON.stringify({ proj: repo }))

    let finishWorktree!: () => void
    createWorktreeMock.mockImplementationOnce(
      () => new Promise(resolve => {
        finishWorktree = () => resolve({
          path: join(`${repo}-worktrees`, 'revive-race-necro'),
          created: false,
        })
      }),
    )
    const directCreate = testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'revive-race-necro',
        project: 'proj',
        worktree: true,
      }),
    })
    await vi.waitFor(() => expect(createWorktreeMock).toHaveBeenCalledTimes(1))
    expect(getSession(join(tmpRoot, 'sessions'), 'revive-race-necro')).toBeNull()

    const convId = 'revive-name-race'
    const snapshot = graveyardSnapshotPath(tmpRoot, convId)
    mkdirSync(dirname(snapshot), { recursive: true })
    writeFileSync(snapshot, '{"type":"assistant"}\n')
    testCtx.docStore.upsertTombstone({
      convId,
      provider: 'claude',
      sessionName: 'revive-race',
      coversSummary: 'A revive racing direct worktree acquisition',
      retiredAt: new Date().toISOString(),
      snapshotted: true,
    })

    const revived = await testCtx.fetch(`/api/graveyard/${convId}/revive`, {
      method: 'POST',
    })
    expect(revived.status).toBe(200)
    expect(await revived.json()).toMatchObject({
      data: { sessionName: 'revive-race-necro-2' },
    })

    finishWorktree()
    expect((await directCreate).status).toBe(201)
    expect(getSession(join(tmpRoot, 'sessions'), 'revive-race-necro')).not.toBeNull()
    expect(getSession(join(tmpRoot, 'sessions'), 'revive-race-necro-2')).not.toBeNull()
  })

  it('clears stale unsupported NATS state while resuming an existing session', async () => {
    const created = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'generic-resume', cliTemplate: 'Cursor Agent' }),
    })
    expect(created.status).toBe(201)
    expect((await testCtx.fetch('/api/sessions/generic-resume/stop', { method: 'POST' })).status).toBe(200)

    updateSession(join(tmpRoot, 'sessions'), 'generic-resume', {
      nats: { enabled: true, subscriptions: ['legacy.subject'] },
    })
    const run = testCtx.docStore.getRun('generic-resume')!
    testCtx.docStore.upsertRun('generic-resume', {
      ...run,
      natsEnabled: true,
      natsSubject: 'legacy.subject',
      natsSubscriptions: ['legacy.subject'],
    })
    const removeWidget = vi.fn()
    const untrackSession = vi.fn()
    testCtx.routeContext.natsTraffic = {
      updateWidgetSubscriptions: vi.fn(),
      removeWidget,
    } as never
    testCtx.routeContext.natsHealth = {
      trackSession: vi.fn(),
      untrackSession,
    } as never
    findPortMock.mockClear()
    releasePortMock.mockClear()

    const resumed = await testCtx.fetch('/api/sessions/generic-resume/start', { method: 'POST' })
    expect(resumed.status).toBe(200)
    expect(startTmuxSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        session: expect.objectContaining({
          nats: expect.objectContaining({ enabled: false }),
        }),
      }),
    )
    expect(getSession(join(tmpRoot, 'sessions'), 'generic-resume')).toMatchObject({
      nats: { enabled: false, subscriptions: [] },
    })
    expect(testCtx.docStore.getRun('generic-resume')).toMatchObject({
      natsEnabled: false,
    })
    expect(testCtx.docStore.getRun('generic-resume')?.natsSubject).toBeUndefined()
    expect(testCtx.docStore.getRun('generic-resume')?.natsSubscriptions).toBeUndefined()
    expect(findPortMock).toHaveBeenCalled()
    expect(releasePortMock).not.toHaveBeenCalled()
    expect(removeWidget).toHaveBeenCalledWith('saloon:generic-resume')
    expect(untrackSession).toHaveBeenCalledWith('generic-resume')
  })

  it('finishes stale NATS repair when auxiliary cleanup throws', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'generic-cleanup', cliTemplate: 'Cursor Agent' }),
    })).status).toBe(201)
    expect((await testCtx.fetch(
      '/api/sessions/generic-cleanup/stop',
      { method: 'POST' },
    )).status).toBe(200)

    updateSession(join(tmpRoot, 'sessions'), 'generic-cleanup', {
      nats: { enabled: true, subscriptions: ['legacy.subject'] },
    })
    const run = testCtx.docStore.getRun('generic-cleanup')!
    testCtx.docStore.upsertRun('generic-cleanup', {
      ...run,
      natsEnabled: true,
      natsSubject: 'legacy.subject',
      natsSubscriptions: ['legacy.subject'],
    })
    testCtx.routeContext.natsTraffic = {
      updateWidgetSubscriptions: vi.fn(),
      removeWidget: vi.fn(() => { throw new Error('Saloon unavailable') }),
    } as never
    testCtx.routeContext.natsHealth = {
      trackSession: vi.fn(),
      untrackSession: vi.fn(() => { throw new Error('health unavailable') }),
    } as never

    const resumed = await testCtx.fetch(
      '/api/sessions/generic-cleanup/start',
      { method: 'POST' },
    )

    expect(resumed.status).toBe(200)
    expect(getSession(join(tmpRoot, 'sessions'), 'generic-cleanup')).toMatchObject({
      nats: { enabled: false, subscriptions: [] },
    })
    expect(testCtx.docStore.getRun('generic-cleanup')).toMatchObject({
      natsEnabled: false,
    })
    expect(testCtx.docStore.getRun('generic-cleanup')?.natsSubject).toBeUndefined()
    expect(testCtx.docStore.getRun('generic-cleanup')?.natsSubscriptions).toBeUndefined()
  })

  it('rejects resume when a persisted named template was deleted', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'deleted-template-resume', cliTemplate: 'Codex' }),
    })).status).toBe(201)
    expect((await testCtx.fetch(
      '/api/sessions/deleted-template-resume/stop',
      { method: 'POST' },
    )).status).toBe(200)

    const templates = testCtx.routeContext.sessionConfig!.cliTemplates
    templates.splice(templates.findIndex(template => template.name === 'Codex'), 1)
    findPortMock.mockClear()
    startTmuxSessionMock.mockClear()

    const resumed = await testCtx.fetch(
      '/api/sessions/deleted-template-resume/start',
      { method: 'POST' },
    )

    expect(resumed.status).toBe(400)
    expect(await resumed.json()).toMatchObject({
      error: { message: 'CLI template "Codex" is not configured' },
    })
    expect(findPortMock).not.toHaveBeenCalled()
    expect(startTmuxSessionMock).not.toHaveBeenCalled()
  })

  it('releases a newly claimed resume port when backend startup fails', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'failed-resume' }),
    })).status).toBe(201)
    expect((await testCtx.fetch('/api/sessions/failed-resume/stop', { method: 'POST' })).status).toBe(200)

    findPortMock.mockClear()
    releasePortMock.mockClear()
    startTmuxSessionMock.mockRejectedValueOnce(new Error('resume failed'))

    const resumed = await testCtx.fetch('/api/sessions/failed-resume/start', { method: 'POST' })
    expect(resumed.status).toBe(500)
    expect(findPortMock).toHaveBeenCalledTimes(1)
    expect(releasePortMock).toHaveBeenCalledWith(6123)
  })

  it('releases a newly claimed graveyard revive port when backend startup fails', async () => {
    const convId = 'failed-revive-conv'
    const snapshot = graveyardSnapshotPath(tmpRoot, convId)
    mkdirSync(dirname(snapshot), { recursive: true })
    writeFileSync(snapshot, '{"type":"assistant"}\n')
    testCtx.docStore.upsertTombstone({
      convId,
      provider: 'claude',
      sessionName: 'failed-revive',
      coversSummary: 'A revive that should roll back',
      retiredAt: new Date().toISOString(),
      snapshotted: true,
    })
    findPortMock.mockClear()
    releasePortMock.mockClear()
    startTmuxSessionMock.mockRejectedValueOnce(new Error('revive failed'))

    const revived = await testCtx.fetch(`/api/graveyard/${convId}/revive`, {
      method: 'POST',
    })

    expect(revived.status).toBe(500)
    expect(findPortMock).toHaveBeenCalledTimes(1)
    expect(releasePortMock).toHaveBeenCalledWith(6123)
    expect(getSession(join(tmpRoot, 'sessions'), 'failed-revive-necro')).toBeNull()
    expect(testCtx.docStore.getTombstone(convId)).toBeDefined()
  })

  it('retains an unconfirmed failed revive across owner-map reset', async () => {
    const convId = 'orphaned-revive-conv'
    const snapshot = graveyardSnapshotPath(tmpRoot, convId)
    mkdirSync(dirname(snapshot), { recursive: true })
    writeFileSync(snapshot, '{"type":"assistant"}\n')
    testCtx.docStore.upsertTombstone({
      convId,
      provider: 'claude',
      sessionName: 'orphaned-revive',
      coversSummary: 'A revive with uncertain backend cleanup',
      retiredAt: new Date().toISOString(),
      snapshotted: true,
    })
    startTmuxSessionMock.mockRejectedValueOnce(new Error('revive failed'))
    getTmuxSessionStateMock.mockResolvedValueOnce('exists')

    const revived = await testCtx.fetch(`/api/graveyard/${convId}/revive`, {
      method: 'POST',
    })

    expect(revived.status).toBe(500)
    const name = 'orphaned-revive-necro'
    const sessionsDir = join(tmpRoot, 'sessions')
    expect(existsSync(join(sessionsDir, name, '.deleting'))).toBe(true)
    resetSessionBackendOwnersForTests()

    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })).status).toBe(409)
    expect((await testCtx.fetch(`/api/sessions/${name}/start`, {
      method: 'POST',
      body: '{}',
    })).status).toBe(409)
    expect(testCtx.docStore.getTombstone(convId)).toBeDefined()
  })

  it('removes partial revive registration when post-launch bookkeeping fails', async () => {
    const convId = 'failed-revive-registration'
    const snapshot = graveyardSnapshotPath(tmpRoot, convId)
    mkdirSync(dirname(snapshot), { recursive: true })
    writeFileSync(snapshot, '{"type":"assistant"}\n')
    testCtx.docStore.upsertTombstone({
      convId,
      provider: 'claude',
      sessionName: 'failed-revive-registration',
      coversSummary: 'A revive whose registration should roll back',
      retiredAt: new Date().toISOString(),
      snapshotted: true,
    })
    const removeWidget = vi.fn()
    const untrackSession = vi.fn()
    testCtx.routeContext.natsTraffic = {
      updateWidgetSubscriptions: vi.fn(),
      removeWidget,
    } as never
    testCtx.routeContext.natsHealth = {
      trackSession: vi.fn(),
      untrackSession,
    } as never
    testCtx.routeContext.sse.broadcastReadyQueueUpdate = vi.fn(() => {
      throw new Error('revive SSE registration failed')
    })
    stopTmuxSessionMock.mockClear()
    releasePortMock.mockClear()

    const revived = await testCtx.fetch(`/api/graveyard/${convId}/revive`, {
      method: 'POST',
    })

    expect(revived.status).toBe(500)
    expect(stopTmuxSessionMock).toHaveBeenCalled()
    expect(releasePortMock).toHaveBeenCalledWith(6123)
    expect(removeWidget).toHaveBeenCalled()
    expect(untrackSession).toHaveBeenCalled()
    expect(getSession(join(tmpRoot, 'sessions'), 'failed-revive-registration-necro')).toBeNull()
    expect(testCtx.docStore.getRun('failed-revive-registration-necro')).toBeUndefined()
    expect(testCtx.docStore.getAllTopicMetadata()).toEqual([])
    expect(testCtx.docStore.getTombstone(convId)).toBeDefined()
  })

  it('rolls back the session, backend, and port when create provisioning fails', async () => {
    createTmuxSessionMock.mockRejectedValueOnce(new Error('create failed'))

    const failed = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'failed-create' }),
    })

    expect(failed.status).toBe(500)
    expect(stopTmuxSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'failed-create' }),
    )
    expect(releasePortMock).toHaveBeenCalledWith(6123)
    expect(getSession(join(tmpRoot, 'sessions'), 'failed-create')).toBeNull()
    expect(testCtx.docStore.getRun('failed-create')).toBeUndefined()
  })

  it('rolls back backend and durable state when Run creation fails after launch', async () => {
    const upsertRun = vi.spyOn(testCtx.docStore, 'upsertRun')
      .mockImplementationOnce(() => { throw new Error('run projection failed') })

    const failed = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'failed-run-projection' }),
    })
    upsertRun.mockRestore()

    expect(failed.status).toBe(500)
    expect(stopTmuxSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'failed-run-projection' }),
    )
    expect(releasePortMock).toHaveBeenCalledWith(6123)
    expect(getSession(join(tmpRoot, 'sessions'), 'failed-run-projection')).toBeNull()
    expect(testCtx.docStore.getRun('failed-run-projection')).toBeUndefined()
  })

  it('preserves a reused worktree and its entity when session provisioning fails', async () => {
    const repo = join(tmpRoot, 'proj')
    execFileSync('git', ['init', '-q', repo], { encoding: 'utf-8' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'])
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init'])
    writeFileSync(join(tmpRoot, 'projects.json'), JSON.stringify({ proj: repo }))

    const existing = await createWorktree(repo, 'reused-worktree')
    expect(existing.created).toBe(true)
    const priorEntity = {
      id: 'reused-worktree',
      name: 'Existing worktree label',
      branch: 'reused-worktree',
      repo: 'existing-repo-label',
      worktreePath: existing.path,
      spaceId: SPACE_ID,
    }
    testCtx.docStore.upsertWorktree(priorEntity.id, priorEntity)
    createTmuxSessionMock.mockRejectedValueOnce(new Error('launch failed'))

    const failed = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'reused-worktree',
        project: 'proj',
        worktree: true,
      }),
    })

    expect(failed.status).toBe(500)
    expect(existsSync(existing.path)).toBe(true)
    expect(testCtx.docStore.getWorktree(priorEntity.id)).toEqual(priorEntity)
    expect(getSession(join(tmpRoot, 'sessions'), 'reused-worktree')).toBeNull()
  })

  it('preserves a worktree adopted by a concurrent entity update', async () => {
    const repo = join(tmpRoot, 'proj')
    execFileSync('git', ['init', '-q', repo], { encoding: 'utf-8' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'])
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init'])
    writeFileSync(join(tmpRoot, 'projects.json'), JSON.stringify({ proj: repo }))

    let adoptedEntity: ReturnType<DocumentStore['getWorktree']>
    createTmuxSessionMock.mockImplementationOnce(async () => {
      adoptedEntity = {
        ...testCtx.docStore.getWorktree('adopted-worktree')!,
        name: 'Updated while launching',
      }
      testCtx.docStore.upsertWorktree('adopted-worktree', adoptedEntity)
      throw new Error('launch failed after adoption')
    })

    const failed = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'adopted-worktree',
        project: 'proj',
        worktree: true,
      }),
    })

    expect(failed.status).toBe(500)
    expect(testCtx.docStore.getWorktree('adopted-worktree')).toBe(adoptedEntity)
    expect(existsSync(join(`${repo}-worktrees`, 'adopted-worktree'))).toBe(true)
  })

  it('rejects a non-string session name before creating worktree resources', async () => {
    const repo = join(tmpRoot, 'proj')
    execFileSync('git', ['init', '-q', repo], { encoding: 'utf-8' })
    writeFileSync(join(tmpRoot, 'projects.json'), JSON.stringify({ proj: repo }))

    const failed = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 42, project: 'proj', worktree: true }),
    })

    expect(failed.status).toBe(400)
    expect(existsSync(join(`${repo}-worktrees`, '42'))).toBe(false)
    expect(createTmuxSessionMock).not.toHaveBeenCalled()
  })

  it('continues core rollback when auxiliary registration cleanup also throws', async () => {
    const removeWidget = vi.fn(() => { throw new Error('Saloon cleanup failed') })
    const untrackSession = vi.fn(() => { throw new Error('health cleanup failed') })
    const onDelete = vi.fn(() => { throw new Error('ready cleanup failed') })
    testCtx.routeContext.natsTraffic = {
      updateWidgetSubscriptions: vi.fn(),
      removeWidget,
    } as never
    testCtx.routeContext.natsHealth = {
      trackSession: vi.fn(),
      untrackSession,
    } as never
    testCtx.routeContext.readyQueue.onDelete = onDelete
    testCtx.routeContext.sse.broadcastReadyQueueUpdate = vi.fn(() => {
      throw new Error('SSE registration failed')
    })

    const failed = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'failed-registration-cleanup',
        taskId: TASK_ID,
        nats: { enabled: true },
      }),
    })

    expect(failed.status).toBe(500)
    expect(stopTmuxSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'failed-registration-cleanup' }),
    )
    expect(releasePortMock).toHaveBeenCalledWith(6123)
    // Registration itself broadcasts once and fails there. The outer
    // provisioning transaction performs exactly one rollback; registration
    // must not run a second nested cleanup before rethrowing.
    expect(removeWidget).toHaveBeenCalledTimes(1)
    expect(untrackSession).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(testCtx.routeContext.sse.broadcastReadyQueueUpdate).toHaveBeenCalledTimes(2)
    expect(getSession(join(tmpRoot, 'sessions'), 'failed-registration-cleanup')).toBeNull()
    expect(testCtx.docStore.getRun('failed-registration-cleanup')).toBeUndefined()
    // Shared live-set/task metadata is never rollback-owned: another session
    // may have joined it after this launch created it. Only the failed
    // session's unique DM metadata is safe to remove.
    expect(testCtx.docStore.getAllTopicMetadata()).toEqual([
      expect.objectContaining({ kind: 'broadcast', name: 'Task: Make Widget' }),
    ])
    expect(testCtx.docStore.getAllTopicMetadata().some(
      metadata => metadata.subject.endsWith('.failed-registration-cleanup'),
    )).toBe(false)
  })

  it('still deletes durable state when malformed subscription data breaks registration', async () => {
    const failed = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'malformed-registration-subject',
        nats: { enabled: true, subscriptions: [123] },
      }),
    })

    expect(failed.status).toBe(500)
    expect(stopTmuxSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'malformed-registration-subject' }),
    )
    expect(releasePortMock).toHaveBeenCalledWith(6123)
    expect(getSession(join(tmpRoot, 'sessions'), 'malformed-registration-subject')).toBeNull()
    expect(testCtx.docStore.getRun('malformed-registration-subject')).toBeUndefined()
  })

  it('stops and releases the port when a persisted adapter is no longer registered', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'orphaned-provider' }),
    })).status).toBe(201)
    updateSession(join(tmpRoot, 'sessions'), 'orphaned-provider', { adapter: 'removed-provider' })
    releasePortMock.mockClear()

    const stopped = await testCtx.fetch('/api/sessions/orphaned-provider/stop', { method: 'POST' })
    expect(stopped.status).toBe(200)
    expect(stopTmuxSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ adapter: 'removed-provider' }),
    )
    expect(releasePortMock).toHaveBeenCalledWith(6123)
    expect(getSession(join(tmpRoot, 'sessions'), 'orphaned-provider')).toMatchObject({
      state: 'stopped',
      port: null,
    })
  })

  it('retains the port and orphans ownership when stop teardown is unconfirmed', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'uncertain-stop' }),
    })).status).toBe(201)
    stopTmuxSessionMock.mockRejectedValueOnce(new Error('stop failed'))
    getTmuxSessionStateMock.mockResolvedValueOnce('exists')
    releasePortMock.mockClear()

    const stopped = await testCtx.fetch('/api/sessions/uncertain-stop/stop', {
      method: 'POST',
    })

    expect(stopped.status).toBe(500)
    expect(releasePortMock).not.toHaveBeenCalled()
    expect(getSession(join(tmpRoot, 'sessions'), 'uncertain-stop')).toMatchObject({
      state: 'running',
      port: 6123,
    })
    expect((await testCtx.fetch('/api/sessions/uncertain-stop/start', {
      method: 'POST',
      body: '{}',
    })).status).toBe(409)

    // A live answer keeps the owner fenced and automatically retries the
    // original stop rather than declaring a ttyd-less backend healthy.
    getTmuxSessionStateMock.mockResolvedValueOnce('exists')
    expect((await testCtx.fetch('/api/sessions')).status).toBe(200)
    expect(stopTmuxSessionMock).toHaveBeenCalledTimes(2)
    expect((await testCtx.fetch('/api/sessions/uncertain-stop/start', {
      method: 'POST',
      body: '{}',
    })).status).toBe(409)
    expect(releasePortMock).not.toHaveBeenCalled()

    // The next confirmed miss completes reconciliation without another
    // user-issued stop.
    getTmuxSessionStateMock.mockResolvedValueOnce('missing')
    expect((await testCtx.fetch('/api/sessions')).status).toBe(200)
    expect(stopTmuxSessionMock).toHaveBeenCalledTimes(3)
    expect(releasePortMock).toHaveBeenCalledWith(6123)
    expect(getSession(join(tmpRoot, 'sessions'), 'uncertain-stop')).toMatchObject({
      state: 'stopped',
      port: null,
    })
  })

  it('finishes stop when the command fails but strict probing confirms absence', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'already-gone-stop' }),
    })).status).toBe(201)
    stopTmuxSessionMock.mockRejectedValueOnce(new Error('kill raced with exit'))
    getTmuxSessionStateMock.mockResolvedValueOnce('missing')
    releasePortMock.mockClear()

    const stopped = await testCtx.fetch('/api/sessions/already-gone-stop/stop', {
      method: 'POST',
    })

    expect(stopped.status).toBe(200)
    expect(releasePortMock).toHaveBeenCalledWith(6123)
    expect(getSession(join(tmpRoot, 'sessions'), 'already-gone-stop')).toMatchObject({
      state: 'stopped',
      port: null,
    })
  })

  it('does not release a stopped port until clearing the durable record succeeds', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'stop-persist-failure' }),
    })).status).toBe(201)
    const sessionsDir = join(tmpRoot, 'sessions')
    getTmuxSessionStateMock.mockImplementationOnce(async () => {
      deleteSession(sessionsDir, 'stop-persist-failure')
      return 'missing'
    })
    releasePortMock.mockClear()

    const stopped = await testCtx.fetch('/api/sessions/stop-persist-failure/stop', {
      method: 'POST',
    })

    expect(stopped.status).toBe(500)
    expect(releasePortMock).not.toHaveBeenCalled()
  })

  it('creates a session for a capability-light third provider registered at runtime', async () => {
    const forge: TerminalProviderAdapter = {
      provider: { id: 'forge', label: 'Forge CLI' },
      sessionLifecycle: 'terminal',
      terminal: {
        capabilities: {
          nats: { state: 'unsupported', reason: 'not implemented' },
          telemetry: { state: 'unsupported', reason: 'not implemented' },
        },
        defaultTelemetry: false,
        transcript: null,
      },
    }
    testCtx.routeContext.providerRegistry = createDefaultProviderRegistry([forge])
    testCtx.routeContext.sessionConfig!.cliTemplates.push({
      id: 'forge',
      name: 'Forge',
      adapter: 'forge',
      startCmd: 'forge run -- {prompt}',
      resumeCmd: 'forge resume',
    })

    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'forge-worker', cliTemplate: 'forge' }),
    })

    expect(res.status).toBe(201)
    expect(getSession(join(tmpRoot, 'sessions'), 'forge-worker')?.adapter).toBe('forge')
    expect((createTmuxSessionMock.mock.calls.at(-1)![1] as {
      provider: { provider: { id: string } }
    }).provider.provider.id).toBe('forge')
  })

  it('still honors an explicit nats:{enabled:false} opt-out', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'quiet-one', nats: { enabled: false } }),
    })
    expect(res.status).toBe(201)
    const run = testCtx.docStore.getRun('quiet-one') as Run
    expect(run.natsEnabled).toBe(false)
  })

  // --- Passive spawn (focus opt-out) ---

  it('persists focusOnCreate:false on the run when created with focus:false', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'passive-worker', focus: false }),
    })
    expect(res.status).toBe(201)
    const run = testCtx.docStore.getRun('passive-worker') as Run
    // The flag rides on the run projection so the client skips its auto-pan for
    // exactly this session — the viewport stays put on a passive spawn.
    expect(run.focusOnCreate).toBe(false)
  })

  it('leaves focusOnCreate unset by default so the canvas auto-focuses the new run', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'eager-worker' }),
    })
    expect(res.status).toBe(201)
    const run = testCtx.docStore.getRun('eager-worker') as Run
    // No opt-out → field absent → default focus behavior (backward compatible).
    expect(run.focusOnCreate).toBeUndefined()
  })

  it('treats focus:true the same as omitting it (still auto-focuses)', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'eager-explicit', focus: true }),
    })
    expect(res.status).toBe(201)
    const run = testCtx.docStore.getRun('eager-explicit') as Run
    expect(run.focusOnCreate).toBeUndefined()
  })

  // --- Background sessions (born hidden) ---

  it('persists background:true on the run and session.json, forcing focusOnCreate:false (AE1)', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'bg-worker', background: true }),
    })
    expect(res.status).toBe(201)

    const run = testCtx.docStore.getRun('bg-worker') as Run
    expect(run).toBeTruthy()
    expect(run.background).toBe(true)
    // R14: a background session never steals camera focus — the server forces
    // the passive-spawn opt-out rather than trusting callers to pass focus:false.
    expect(run.focusOnCreate).toBe(false)

    // The flag persists on session.json so it survives a restart rehydrate.
    const session = getSession(join(tmpRoot, 'sessions'), 'bg-worker')
    expect(session?.background).toBe(true)
  })

  it('defaults background:false with focus behavior unchanged when the param is omitted', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'fg-worker' }),
    })
    expect(res.status).toBe(201)

    const run = testCtx.docStore.getRun('fg-worker') as Run
    expect(run.background).toBe(false)
    // No opt-out → field absent → default auto-focus (backward compatible).
    expect(run.focusOnCreate).toBeUndefined()

    const session = getSession(join(tmpRoot, 'sessions'), 'fg-worker')
    expect(session?.background).toBe(false)
  })

  it('forces focusOnCreate:false even when background:true is paired with focus:true', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'bg-eager', background: true, focus: true }),
    })
    expect(res.status).toBe(201)

    const run = testCtx.docStore.getRun('bg-eager') as Run
    expect(run.background).toBe(true)
    // background wins over an explicit focus:true — hidden cards can't be
    // pan targets, so honoring focus here would aim the camera at nothing.
    expect(run.focusOnCreate).toBe(false)
  })

  it('uses the marshal hand\'s persona as appendSystemPrompt and its intro as the one-shot prompt', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'marshal-worker', hand: 'marshal' }),
    })

    expect(res.status).toBe(201)
    expect(createTmuxSessionMock).toHaveBeenCalledTimes(1)
    const opts = createTmuxSessionMock.mock.calls[0]![1] as unknown as {
      appendSystemPrompt?: string | null
      session: { initialPrompt?: string }
    }
    // System prompt is the persistent persona, NOT the one-shot intro.
    expect(opts.appendSystemPrompt).toBeTruthy()
    expect(opts.appendSystemPrompt!.toLowerCase()).toContain('marshal')
    expect(opts.appendSystemPrompt).not.toContain('Print a short introduction')
    // The intro fires once as the first user message: it loads the tinstar skill
    // (the preload) and then prints a short introduction.
    expect(opts.session.initialPrompt).toContain('load the `tinstar` skill')
    expect(opts.session.initialPrompt).toContain('short introduction')
  })

  it('re-threads the marshal persona (not the intro) into startTmuxSession on restart', async () => {
    const created = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'marshal-restart', hand: 'marshal' }),
    })
    expect(created.status).toBe(201)

    // A later /start recreates the tmux process. The persistent persona must be
    // re-injected from persisted session metadata, not the one-shot intro.
    const restarted = await testCtx.fetch('/api/sessions/marshal-restart/start', { method: 'POST' })
    expect(restarted.status).toBe(200)
    expect(startTmuxSessionMock).toHaveBeenCalledTimes(1)
    const opts = startTmuxSessionMock.mock.calls[0]![1] as unknown as { appendSystemPrompt?: string | null }
    expect(opts.appendSystemPrompt).toBeTruthy()
    expect(opts.appendSystemPrompt!.toLowerCase()).toContain('marshal')
    expect(opts.appendSystemPrompt).not.toContain('Print a short introduction')
  })

  it('retries an orphaned marshal restart after cleanup becomes confirmable', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'marshal', cliTemplate: 'marshal' }),
    })).status).toBe(201)
    getTmuxSessionStateMock.mockResolvedValueOnce('exists')

    const first = await testCtx.fetch('/api/marshal/restart', {
      method: 'POST',
      body: '{}',
    })
    expect(first.status).toBe(500)
    expect(existsSync(join(tmpRoot, 'sessions', 'marshal', '.deleting'))).toBe(true)

    getTmuxSessionStateMock.mockResolvedValueOnce('missing')
    const retried = await testCtx.fetch('/api/marshal/restart', {
      method: 'POST',
      body: '{}',
    })
    expect(retried.status).toBe(200)
    expect(await retried.json()).toMatchObject({
      data: { name: 'marshal' },
    })
    expect(getSession(join(tmpRoot, 'sessions'), 'marshal')).not.toBeNull()
    expect(createTmuxSessionMock).toHaveBeenCalledTimes(2)
  })

  it('returns NOT_FOUND for an unknown hand', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'ghost-worker', hand: 'does-not-exist' }),
    })
    expect(res.status).toBe(404)
  })

  // --- Switchboard per-session override (Phase 2 Steps 5-6) ---
  // These exercise the override through the REAL POST /api/sessions route, not the
  // helpers in isolation — the wiring gap (route not passing model/token into
  // createSessionInternal) is only visible end-to-end.

  it('threads a per-session model override through to the launch', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'model-worker', model: 'opus' }),
    })
    expect(res.status).toBe(201)
    expect(createTmuxSessionMock).toHaveBeenCalledTimes(1)
    const opts = createTmuxSessionMock.mock.calls[0]![1] as unknown as { session: { modelOverride?: string | null } }
    // Regression: the route MUST pass `model` into createSessionInternal so the
    // session launches with it. A wiring gap makes the override a silent no-op.
    expect(opts.session.modelOverride).toBe('opus')
  })

  it('rejects a model not in switchboard.allowedModels with a stable 403, before launch', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'bad-model', model: 'haiku' }),
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { ok: boolean; error: { code: string } }
    expect(body.error.code).toBe('OVERRIDE_MODEL_NOT_ALLOWED')
    expect(createTmuxSessionMock).not.toHaveBeenCalled()
  })

  it('overlays a per-session token onto the launch secrets without persisting it', async () => {
    const token = 'sk-ant-oat01-' + 'y'.repeat(40)
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'token-worker', token }),
    })
    expect(res.status).toBe(201)
    const opts = createTmuxSessionMock.mock.calls[0]![1] as unknown as {
      secrets: Record<string, string>
      session: Record<string, unknown>
    }
    expect(opts.secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe(token)
    // Spawn-time only: the token is never written onto the persisted session.
    expect(opts.session).not.toHaveProperty('token')
    expect(opts.session.modelOverride ?? null).toBeNull()
  })

  it('re-applies a per-session token supplied on /start (trimmed, never persisted)', async () => {
    // The token override is spawn-time-only, so it does not survive a stop/start.
    // /start accepts an optional token to re-establish quota isolation on resume.
    const created = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'restart-token' }),
    })
    expect(created.status).toBe(201)
    startTmuxSessionMock.mockClear()

    const token = 'sk-ant-oat01-' + 'z'.repeat(40)
    const restarted = await testCtx.fetch('/api/sessions/restart-token/start', {
      method: 'POST',
      body: JSON.stringify({ token: `  ${token}  ` }), // padded → also asserts the trim-on-apply fix
    })
    expect(restarted.status).toBe(200)
    expect(startTmuxSessionMock).toHaveBeenCalledTimes(1)
    const opts = startTmuxSessionMock.mock.calls[0]![1] as unknown as { secrets: Record<string, string> }
    expect(opts.secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe(token)

    // Still never persisted: the session file has no token field.
    const persisted = await (await testCtx.fetch('/api/sessions/restart-token')).json() as Record<string, unknown>
    expect(persisted).not.toHaveProperty('token')
  })

  it('returns 409 with a clear message (and no spawn) when the worktree branch name is blocked', async () => {
    // Repro of the "cockpit" bug: a branch `cockpit/soak-evidence` makes a plain
    // branch `cockpit` impossible (git directory/file ref conflict). The create
    // must fail FAST — before any tmux spawn — with a helpful 409, not git's
    // cryptic "fatal: invalid reference: cockpit" surfaced as a 500.
    const repo = join(tmpRoot, 'proj')
    const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' })
    execFileSync('git', ['init', '-q', repo], { encoding: 'utf-8' })
    g('config', 'user.email', 'test@example.com')
    g('config', 'user.name', 'Test')
    g('commit', '--allow-empty', '-q', '-m', 'init')
    g('branch', 'cockpit/soak-evidence')
    writeFileSync(join(tmpRoot, 'projects.json'), JSON.stringify({ proj: repo }))

    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'cockpit', project: 'proj', worktree: true }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { ok: boolean; error: { message: string } }
    expect(body.error.message).toContain('cockpit')
    expect(body.error.message).toContain('cockpit/soak-evidence')
    // Fail-fast: the blocked name is caught before the tmux backend is touched.
    expect(createTmuxSessionMock).not.toHaveBeenCalled()
  })

  it('returns 400 (never hangs) for a malformed JSON body', async () => {
    // A throw before the create try/catch (JSON.parse on a bad body) must surface as a
    // response via withBody's guard — not leave the socket open until curl times out.
    // A parse failure is a client error, so 400 (not 500).
    const res = await testCtx.fetch('/api/sessions', { method: 'POST', body: '{not valid json' })
    expect(res.status).toBe(400)
    expect(createTmuxSessionMock).not.toHaveBeenCalled()
  })

  it('spawns an unsupported child provider without inheriting parent NATS', async () => {
    const parent = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'nats-parent', nats: { enabled: true } }),
    })
    expect(parent.status).toBe(201)

    createTmuxSessionMock.mockClear()
    const spawned = await testCtx.fetch('/api/sessions/nats-parent/spawn', {
      method: 'POST',
      body: JSON.stringify({ hand: 'codex-hand' }),
    })
    expect(spawned.status).toBe(201)
    const body = await spawned.json() as {
      data: { session: string; room: string | null }
      warnings?: { nats?: string[] }
    }
    const { data } = body
    const child = getSession(join(tmpRoot, 'sessions'), data.session)
    expect(child).toMatchObject({ adapter: 'codex' })
    expect(child?.nats?.enabled ?? false).toBe(false)
    expect(data.room).toBeNull()
    expect(body.warnings?.nats).toEqual([
      expect.stringContaining('Parent NATS was not inherited'),
    ])

    const launch = createTmuxSessionMock.mock.calls.at(-1)![1] as unknown as {
      provider: { provider: { id: string } }
      session: { adapter?: string | null; nats?: { enabled: boolean } | null }
    }
    expect(launch.provider.provider.id).toBe('codex')
    expect(launch.session.adapter).toBe('codex')
    expect(launch.session.nats?.enabled ?? false).toBe(false)
    expect((testCtx.docStore.getRun(data.session) as Run).natsEnabled).toBe(false)
  })

  it('rejects hand spawn when its named provider template was deleted', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'missing-hand-template-parent', nats: { enabled: false } }),
    })).status).toBe(201)
    const templates = testCtx.routeContext.sessionConfig!.cliTemplates
    templates.splice(templates.findIndex(template => template.name === 'Codex'), 1)
    createTmuxSessionMock.mockClear()

    const spawned = await testCtx.fetch('/api/sessions/missing-hand-template-parent/spawn', {
      method: 'POST',
      body: JSON.stringify({ hand: 'codex-hand' }),
    })

    expect(spawned.status).not.toBe(201)
    expect(await spawned.json()).toMatchObject({
      error: { message: 'CLI template "Codex" is not configured' },
    })
    expect(createTmuxSessionMock).not.toHaveBeenCalled()
  })

  it('rolls back the child backend, port, session, and run when hand spawn fails', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'failed-spawn-parent', nats: { enabled: false } }),
    })).status).toBe(201)
    createTmuxSessionMock.mockClear()
    stopTmuxSessionMock.mockClear()
    releasePortMock.mockClear()
    createTmuxSessionMock.mockRejectedValueOnce(new Error('child create failed'))

    const failed = await testCtx.fetch('/api/sessions/failed-spawn-parent/spawn', {
      method: 'POST',
      body: JSON.stringify({ hand: 'codex-hand' }),
    })

    expect(failed.status).toBe(500)
    const stopCall = stopTmuxSessionMock.mock.calls.at(-1) as unknown as [
      unknown,
      { name: string },
    ]
    const rolledBackChild = stopCall[1]
    expect(rolledBackChild.name).toContain('failed-spawn-parent-codex-hand-')
    expect(releasePortMock).toHaveBeenCalledWith(6123)
    expect(getSession(join(tmpRoot, 'sessions'), rolledBackChild.name)).toBeNull()
    expect(testCtx.docStore.getRun(rolledBackChild.name)).toBeUndefined()
  })

  it('retains an unconfirmed failed spawn across owner-map reset', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'orphaned-spawn-parent', nats: { enabled: false } }),
    })).status).toBe(201)
    createTmuxSessionMock.mockClear()
    createTmuxSessionMock.mockRejectedValueOnce(new Error('child create failed'))
    getTmuxSessionStateMock.mockResolvedValueOnce('exists')

    const failed = await testCtx.fetch('/api/sessions/orphaned-spawn-parent/spawn', {
      method: 'POST',
      body: JSON.stringify({ hand: 'codex-hand' }),
    })

    expect(failed.status).toBe(500)
    const spawnedName = (
      createTmuxSessionMock.mock.calls.at(-1)![1] as unknown as {
        session: { name: string }
      }
    ).session.name
    const sessionsDir = join(tmpRoot, 'sessions')
    expect(existsSync(join(sessionsDir, spawnedName, '.deleting'))).toBe(true)
    resetSessionBackendOwnersForTests()

    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: spawnedName }),
    })).status).toBe(409)
    expect((await testCtx.fetch(`/api/sessions/${spawnedName}/start`, {
      method: 'POST',
      body: '{}',
    })).status).toBe(409)
  })

  it('rolls back every persisted parent breakout surface when spawn fails late', async () => {
    const parentName = 'late-breakout-parent'
    const socketPath = natsControlSocketPath(parentName)
    rmSync(socketPath, { force: true })
    const commands: Array<{ action: string; subject: string }> = []
    const controlServer = createNetServer(socket => {
      socket.on('data', chunk => {
        for (const line of chunk.toString().trim().split('\n')) {
          if (line) commands.push(JSON.parse(line))
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      controlServer.once('error', reject)
      controlServer.listen(socketPath, resolve)
    })

    try {
      expect((await testCtx.fetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          name: parentName,
          taskId: TASK_ID,
          nats: { enabled: true, subscriptions: ['existing.parent.subject'] },
        }),
      })).status).toBe(201)
      const parentBefore = getSession(join(tmpRoot, 'sessions'), parentName)!
      const runBefore = testCtx.docStore.getRun(parentName)!
      const originalUpsertRun = testCtx.docStore.upsertRun.bind(testCtx.docStore)
      const runSpy = vi.spyOn(testCtx.docStore, 'upsertRun')
        .mockImplementation((id, run) => {
          if (id === parentName && run.breakoutRooms?.length) {
            throw new Error('late parent run failure')
          }
          originalUpsertRun(id, run)
        })

      const failed = await testCtx.fetch(`/api/sessions/${parentName}/spawn`, {
        method: 'POST',
        body: JSON.stringify({ hand: 'marshal' }),
      })
      runSpy.mockRestore()

      expect(failed.status).toBe(500)
      const breakout = commands.find(command => command.action === 'subscribe')?.subject
      expect(breakout).toMatch(/^tinstar\.room\./)
      await vi.waitFor(() => {
        expect(commands).toContainEqual({ action: 'unsubscribe', subject: breakout })
      })
      expect(getSession(join(tmpRoot, 'sessions'), parentName)?.nats?.subscriptions)
        .toEqual(parentBefore.nats?.subscriptions)
      expect(testCtx.docStore.getRun(parentName)?.breakoutRooms)
        .toEqual(runBefore.breakoutRooms)
      expect(testCtx.docStore.getTopicMetadata(breakout!)).toBeUndefined()
      const stoppedChild = (stopTmuxSessionMock.mock.calls.at(-1) as unknown as [
        unknown,
        { name: string },
      ])[1].name
      expect(testCtx.docStore.getAllTopicMetadata().some(
        metadata => metadata.subject.split('.').length === 5,
      )).toBe(true)
      expect(testCtx.docStore.getAllTopicMetadata().some(
        metadata => metadata.subject.endsWith(`.${stoppedChild}`),
      )).toBe(false)
    } finally {
      await new Promise<void>(resolve => controlServer.close(() => resolve()))
      rmSync(socketPath, { force: true })
    }
  })

  it('removes child-owned topic metadata after a fallback spawn fails late', async () => {
    const parentName = 'fallback-breakout-parent'
    rmSync(natsControlSocketPath(parentName), { force: true })
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: parentName,
        nats: { enabled: true, subscriptions: ['existing.parent.subject'] },
      }),
    })).status).toBe(201)
    const metadataBefore = testCtx.docStore.getAllTopicMetadata()
    testCtx.routeContext.natsHealth = {
      trackSession: vi.fn(() => { throw new Error('late health registration failure') }),
      untrackSession: vi.fn(),
    } as never

    const failed = await testCtx.fetch(`/api/sessions/${parentName}/spawn`, {
      method: 'POST',
      body: JSON.stringify({ hand: 'marshal' }),
    })

    expect(failed.status).toBe(500)
    const stopCall = stopTmuxSessionMock.mock.calls.at(-1) as unknown as [
      unknown,
      { name: string },
    ]
    const childName = stopCall[1].name
    expect(testCtx.docStore.getAllTopicMetadata()).toEqual(metadataBefore)
    expect(testCtx.docStore.getAllTopicMetadata().some(
      metadata => metadata.subject.endsWith(`.${childName}`),
    )).toBe(false)
  })

  it('spawn from a background parent does NOT inherit background (child born visible)', async () => {
    // Explicit opt-in only: surprise-hidden sessions are worse than
    // surprise-visible ones, so `background` never flows parent → child.
    // nats disabled on the parent keeps the spawn path off the breakout-room
    // socket machinery (irrelevant here).
    const created = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'bg-parent', background: true, nats: { enabled: false } }),
    })
    expect(created.status).toBe(201)
    expect((testCtx.docStore.getRun('bg-parent') as Run).background).toBe(true)

    const res = await testCtx.fetch('/api/sessions/bg-parent/spawn', {
      method: 'POST',
      body: JSON.stringify({ hand: 'marshal' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { ok: boolean; data: { session: string } }
    const childName = body.data.session

    const childRun = testCtx.docStore.getRun(childName) as Run
    expect(childRun).toBeTruthy()
    expect(childRun.background).toBe(false)
    // Visible spawn keeps default focus behavior (no forced opt-out).
    expect(childRun.focusOnCreate).toBeUndefined()
    expect(getSession(join(tmpRoot, 'sessions'), childName)?.background).toBe(false)
  })

  it('keeps a successfully spawned child backend name owned across roots', async () => {
    expect((await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'spawn-owner-parent', nats: { enabled: false } }),
    })).status).toBe(201)
    const spawned = await testCtx.fetch('/api/sessions/spawn-owner-parent/spawn', {
      method: 'POST',
      body: JSON.stringify({ hand: 'marshal' }),
    })
    expect(spawned.status).toBe(201)
    const childName = (await spawned.json() as { data: { session: string } }).data.session
    const launchesBeforeCollision = createTmuxSessionMock.mock.calls.length

    const secondRoot = join(tmpRoot, 'spawn-owner-other-root')
    mkdirSync(secondRoot, { recursive: true })
    const secondCtx = createTestServer(secondRoot)
    try {
      const collision = await secondCtx.fetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: childName }),
      })
      expect(collision.status).toBe(409)
    } finally {
      await secondCtx.close()
    }

    expect(createTmuxSessionMock).toHaveBeenCalledTimes(launchesBeforeCollision)
  })

  it('spawn with a friendly name sets it on the child run, leaving the generated id intact', async () => {
    await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'named-parent', nats: { enabled: false } }),
    })
    const res = await testCtx.fetch('/api/sessions/named-parent/spawn', {
      method: 'POST',
      body: JSON.stringify({ hand: 'marshal', name: 'Reviewer — auth edge cases' }),
    })
    expect(res.status).toBe(201)
    const { data } = await res.json() as { data: { session: string } }

    const childRun = testCtx.docStore.getRun(data.session) as Run
    expect(childRun.name).toBe('Reviewer — auth edge cases')
    // The generated id is the concatenated form, untouched by the friendly name.
    expect(data.session).toContain('named-parent-marshal-')
    expect(childRun.id).toBe(data.session)
  })

  it('spawn without a name leaves the child run unnamed (falls back to its id)', async () => {
    await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'unnamed-parent', nats: { enabled: false } }),
    })
    const res = await testCtx.fetch('/api/sessions/unnamed-parent/spawn', {
      method: 'POST',
      body: JSON.stringify({ hand: 'marshal' }),
    })
    const { data } = await res.json() as { data: { session: string } }
    expect((testCtx.docStore.getRun(data.session) as Run).name).toBeUndefined()
  })

  it('spawn rejects a non-string name with 400', async () => {
    await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'reject-parent', nats: { enabled: false } }),
    })
    const res = await testCtx.fetch('/api/sessions/reject-parent/spawn', {
      method: 'POST',
      body: JSON.stringify({ hand: 'marshal', name: 42 }),
    })
    expect(res.status).toBe(400)
  })

  it('spawn 400s on a malformed JSON body rather than throwing a 500', async () => {
    await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'malformed-parent', nats: { enabled: false } }),
    })
    const res = await testCtx.fetch('/api/sessions/malformed-parent/spawn', {
      method: 'POST',
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

  it('a plain /start with no body launches with the global token (no override)', async () => {
    const created = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'restart-plain' }),
    })
    expect(created.status).toBe(201)
    startTmuxSessionMock.mockClear()

    const restarted = await testCtx.fetch('/api/sessions/restart-plain/start', { method: 'POST' })
    expect(restarted.status).toBe(200)
    const opts = startTmuxSessionMock.mock.calls[0]![1] as unknown as { secrets: Record<string, string> }
    // No override supplied ⇒ untouched global secrets (empty secrets dir ⇒ no token key).
    expect(opts.secrets).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
  })
})
