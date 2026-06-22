import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// Stub the transcript parser so the model lookup is hermetic — no dependency on
// real ~/.claude transcripts. The route's resolveSessionModel resolves a path
// from workspace.path (readLatestModel) or falls back to findTranscriptByConvId
// + readLatestModelAt. We control all three here.
const { readLatestModelMock, readLatestModelAtMock, findTranscriptByConvIdMock } = vi.hoisted(() => ({
  readLatestModelMock: vi.fn<(workdir: string, convId: string) => string | null>(() => null),
  readLatestModelAtMock: vi.fn<(path: string) => string | null>(() => null),
  findTranscriptByConvIdMock: vi.fn<(convId: string) => string | null>(() => null),
}))
vi.mock('../../sessions/transcript-parser', async (importActual) => {
  const actual = await importActual<typeof import('../../sessions/transcript-parser')>()
  return {
    ...actual,
    readLatestModel: readLatestModelMock,
    readLatestModelAt: readLatestModelAtMock,
    findTranscriptByConvId: findTranscriptByConvIdMock,
  }
})

import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import { createSession, setState } from '../../sessions/session'

const SPACE_ID = 'spc-model-fixture'

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
  docStore.upsertSpace(SPACE_ID, { id: SPACE_ID, name: 'Model Space', createdAt: new Date().toISOString() })
  docStore.activeSpaceId = SPACE_ID

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
  sessionsDir: string
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
    sessionsDir: join(root, 'sessions'),
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
  readLatestModelMock.mockReset().mockReturnValue(null)
  readLatestModelAtMock.mockReset().mockReturnValue(null)
  findTranscriptByConvIdMock.mockReset().mockReturnValue(null)
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-model-route-test-'))
  testCtx = createTestServer(tmpRoot)
})

afterEach(async () => {
  await testCtx.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('GET /api/state — model enrichment', () => {
  it('includes a model field on each session, sourced from the transcript', async () => {
    // A session with a workspace.path resolves its model via readLatestModel.
    // The workspace path must exist on disk — listSessions nulls out missing
    // paths — so we point it at the test's tmp root.
    readLatestModelMock.mockReturnValue('claude-opus-4-8')
    const sess = createSession(testCtx.sessionsDir, {
      name: 'opus-worker',
      backend: 'tmux',
      workspace: { path: tmpRoot, worktree: false, branch: null, basePath: null },
    })
    setState(testCtx.sessionsDir, 'opus-worker', 'running')

    const res = await testCtx.fetch('/api/state')
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: Array<{ name: string; model?: string | null }> }
    const entry = body.sessions.find(s => s.name === 'opus-worker')
    expect(entry).toBeTruthy()
    expect(entry!.model).toBe('claude-opus-4-8')
    // Sourced from workspace.path + convId, not the convId-scan fallback.
    expect(readLatestModelMock).toHaveBeenCalledWith(tmpRoot, sess.conversation.id)
    expect(findTranscriptByConvIdMock).not.toHaveBeenCalled()
  })

  it('falls back to a convId transcript scan when the session has no workspace path', async () => {
    findTranscriptByConvIdMock.mockReturnValue('/found/transcript.jsonl')
    readLatestModelAtMock.mockReturnValue('claude-haiku-4-5')
    createSession(testCtx.sessionsDir, { name: 'no-workspace', backend: 'tmux' })

    const res = await testCtx.fetch('/api/state')
    const body = await res.json() as { sessions: Array<{ name: string; model?: string | null }> }
    const entry = body.sessions.find(s => s.name === 'no-workspace')
    expect(entry!.model).toBe('claude-haiku-4-5')
    expect(readLatestModelAtMock).toHaveBeenCalledWith('/found/transcript.jsonl')
  })

  it('reports model null for a session with no assistant turn yet (pre-first-response)', async () => {
    readLatestModelMock.mockReturnValue(null)
    createSession(testCtx.sessionsDir, {
      name: 'fresh',
      backend: 'tmux',
      workspace: { path: tmpRoot, worktree: false, branch: null, basePath: null },
    })

    const res = await testCtx.fetch('/api/state')
    const body = await res.json() as { sessions: Array<{ name: string; model?: string | null }> }
    const entry = body.sessions.find(s => s.name === 'fresh')
    expect(entry).toBeTruthy()
    expect(entry!.model).toBeNull()
  })
})

describe('GET /api/sessions/:name/model', () => {
  it('returns { name, model } for an existing session', async () => {
    readLatestModelMock.mockReturnValue('claude-opus-4-8')
    createSession(testCtx.sessionsDir, {
      name: 'pull-me',
      backend: 'tmux',
      workspace: { path: '/tmp/pull-repo', worktree: false, branch: null, basePath: null },
    })

    const res = await testCtx.fetch('/api/sessions/pull-me/model')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { name: string; model: string | null } }
    expect(body.data).toEqual({ name: 'pull-me', model: 'claude-opus-4-8' })
  })

  it('returns model null when unavailable', async () => {
    readLatestModelMock.mockReturnValue(null)
    createSession(testCtx.sessionsDir, {
      name: 'unknown-model',
      backend: 'tmux',
      workspace: { path: '/tmp/x', worktree: false, branch: null, basePath: null },
    })

    const res = await testCtx.fetch('/api/sessions/unknown-model/model')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { name: string; model: string | null } }
    expect(body.data.model).toBeNull()
  })

  it('404s for an unknown session', async () => {
    const res = await testCtx.fetch('/api/sessions/ghost/model')
    expect(res.status).toBe(404)
  })

  it('does not treat a deeper path ending in /model as a model pull', async () => {
    // The matcher is strict (exactly one name segment before /model), so a multi-
    // segment path can't masquerade as a model pull the way endsWith("/model") let it.
    readLatestModelMock.mockReturnValue('claude-opus-4-8')
    createSession(testCtx.sessionsDir, {
      name: 'deep',
      backend: 'tmux',
      workspace: { path: '/tmp/x', worktree: false, branch: null, basePath: null },
    })
    const res = await testCtx.fetch('/api/sessions/deep/extra/model')
    expect(res.status).toBe(404)
  })
})
