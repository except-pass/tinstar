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

  it('still honors an explicit nats:{enabled:false} opt-out', async () => {
    const res = await testCtx.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'quiet-one', nats: { enabled: false } }),
    })
    expect(res.status).toBe(201)
    const run = testCtx.docStore.getRun('quiet-one') as Run
    expect(run.natsEnabled).toBe(false)
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
    // The intro fires once as the first user message.
    expect(opts.session.initialPrompt).toContain('Print a short introduction')
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

  it('returns an error (never hangs) for a malformed JSON body', async () => {
    // A throw before the create try/catch (JSON.parse on a bad body) must surface as a
    // response via the readBody .catch — not leave the socket open until curl times out.
    const res = await testCtx.fetch('/api/sessions', { method: 'POST', body: '{not valid json' })
    expect(res.status).toBe(500)
    expect(createTmuxSessionMock).not.toHaveBeenCalled()
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
