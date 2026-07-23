import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same stubbing posture as routes.notices.test.ts: the real `getSession` reads
// from disk and finds nothing in a temp root, so `delivered` is false in EVERY
// case and the anti-loop guard is invisible. Stubbing both lets a test distinguish
// "not delivered because there is no session" from "not delivered because the
// author was an agent". Uses the pluginTest posture (ctx.sessionConfig populated),
// mirroring the notices route harness — session-scoped routes need a config.
const sendPrompt = vi.hoisted(() =>
  vi.fn(async (_cfg: unknown, _sessionName: string, _prompt: string) => {}))
const getSession = vi.hoisted(() => vi.fn((_dir: string, _name: string) => null as unknown))
vi.mock('../../sessions', async (orig) => {
  const actual = await orig<typeof import('../../sessions')>()
  return { ...actual, getSession, tmuxBackend: { ...actual.tmuxBackend, sendPrompt } }
})
// The code-spawned author is mocked so tests never launch a real `claude -p`. Default
// return is dispatched:false so every EXISTING test falls through to the main-agent path
// (deliverSlatePrompt) unchanged; the author-branch tests override the return to true.
const dispatchSurfaceAuthor = vi.hoisted(() =>
  vi.fn((_params: { runId: string; prompt: string; label: string; sessionsDir: string; config: unknown }) =>
    ({ dispatched: false })))
vi.mock('../../sessions/surfaceAuthor', () => ({ dispatchSurfaceAuthor }))

beforeEach(() => {
  sendPrompt.mockClear()
  getSession.mockReset()
  getSession.mockReturnValue(null)
  dispatchSurfaceAuthor.mockClear()
  dispatchSurfaceAuthor.mockReturnValue({ dispatched: false })
})

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import type { Point, Run } from '../../../domain/types'

interface Harness {
  docStore: DocumentStore
  fetch(path: string, init?: RequestInit): Promise<Response>
  close(): Promise<void>
}

function createTestServer(root: string): Harness {
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
    ui: { promptComposerDefault: false, showEmptyEntities: true, layouts: {}, telemetryPanels: {} },
    slate: { author: { enabled: true, model: 'test-model', timeoutMs: 1000 } },
  }
  const docStore = new DocumentStore()
  const ctx = {
    sessionConfig: cfg,
    docStore,
    bus: { emit: () => {} },
    readyQueue: { onDelete: () => {}, getQueue: () => [] },
    sse: { setReadyQueue: () => {}, broadcastReadyQueueUpdate: () => {} },
  } as unknown as RouteContext

  const server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(handled => {
      if (!handled) { res.statusCode = 404; res.end() }
    }).catch(() => { res.statusCode = 500; res.end() })
  })
  let port: number
  const ready = new Promise<void>(resolve => server.listen(0, () => {
    port = (server.address() as AddressInfo).port
    resolve()
  }))
  return {
    docStore,
    async fetch(path, init) {
      await ready
      const headers = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) }
      return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers })
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

// runId === the run id === the tmux session name (what delivery targets).
const RUN = 'CLD-run-1'

function seedRun(store: DocumentStore, id = RUN): void {
  store.upsertRun(id, {
    id, sessionId: id, status: 'running', name: undefined,
    initiative: '', epic: '', task: '', repo: 'repo', worktree: 'wt',
    taskId: 'task-1', worktreeId: 'wt', createdAt: '2026-07-01T00:00:00Z',
    recapEntries: [], touchedFiles: [], rawLogs: '', port: null,
    backend: 'tmux', spaceId: 'spc-1',
  } as unknown as Run)
}

/** A2UI content carrying a single-select Choice (opt-a/opt-b), a text field, and a
 *  submit — the answerable shape the widget renders. */
function answerableContent() {
  return {
    root: 'root',
    components: [
      { id: 'root', component: 'Column', children: ['choice', 'notes', 'go'] },
      { id: 'choice', component: 'Choice', mode: 'single', options: [{ id: 'opt-a', label: 'Deploy now' }, { id: 'opt-b', label: 'Wait' }] },
      { id: 'notes', component: 'TextInput', label: 'Notes' },
      { id: 'go', component: 'Submit', label: 'Submit' },
    ],
  }
}

function withServer(fn: (srv: Harness) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'slate-route-'))
    const srv = createTestServer(root)
    try { await fn(srv) } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** Create a point over HTTP and return its id. */
async function createPoint(srv: Harness, over: Record<string, unknown> = {}): Promise<string> {
  const res = await srv.fetch(`/api/runs/${RUN}/slate/points`, {
    method: 'POST',
    body: JSON.stringify({ headline: 'a point', ...over }),
  })
  const body = await res.json() as { data: { point: Point } }
  return body.data.point.id
}

describe('POST /api/runs/:id/slate/points', () => {
  it('creates a user-authored point (author user, source user) — EVENTUAL, never prompts', withServer(async srv => {
    seedRun(srv.docStore)
    getSession.mockReturnValue({ name: RUN }) // session REACHABLE — and still no prompt
    sendPrompt.mockClear()
    const res = await srv.fetch(`/api/runs/${RUN}/slate/points`, {
      method: 'POST', body: JSON.stringify({ headline: 'why is CI red?' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { point: Point; notified: boolean } }
    expect(body.ok).toBe(true)
    expect(body.data.point.author).toBe('user')
    expect(body.data.point.source).toBe('user')
    expect(body.data.point.headline).toBe('why is CI red?')
    // Adding a point is eventual: it mutates the store and does NOT deliver a prompt,
    // even to a live session. The agent finds it next time it reads its open points.
    expect(body.data.notified).toBe(false)
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(srv.docStore.getSlatePoint(RUN, body.data.point.id)).toBeDefined()
  }))

  it('404s when the run does not exist', withServer(async srv => {
    const res = await srv.fetch(`/api/runs/${RUN}/slate/points`, {
      method: 'POST', body: JSON.stringify({ headline: 'x' }),
    })
    expect(res.status).toBe(404)
  }))

  it('rejects an empty headline (INVALID_PARAMS, nothing persisted)', withServer(async srv => {
    seedRun(srv.docStore)
    const res = await srv.fetch(`/api/runs/${RUN}/slate/points`, {
      method: 'POST', body: JSON.stringify({ headline: '   ' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_PARAMS')
    expect(srv.docStore.getSlatePointsForRun(RUN)).toHaveLength(0)
  }))

  it('a user point SURVIVES a subsequent file re-projection (the reconciliation)', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { headline: 'user added me' })
    expect(srv.docStore.getSlatePoint(RUN, pid)).toBeDefined()

    // The watcher re-projects the run's file surfaces, which do NOT include the
    // user point (the file never knew about it). Without the source:'user' retract
    // exemption this would nuke the user's point.
    srv.docStore.applyRunSlateProjection(RUN, [
      { id: 'file-pt', author: 'agent', headline: 'from a file', content: { root: 'r', components: [{ id: 'r', component: 'Text', text: 'x' }] } },
    ])

    expect(srv.docStore.getSlatePoint(RUN, pid)).toBeDefined()       // user point survived
    expect(srv.docStore.getSlatePoint(RUN, 'file-pt')).toBeDefined() // file point present
  }))
})

describe('POST /api/runs/:id/slate/points/:pid/answer', () => {
  const answer = (srv: Harness, pid: string, payload: unknown) =>
    srv.fetch(`/api/runs/${RUN}/slate/points/${pid}/answer`, { method: 'POST', body: JSON.stringify(payload) })

  it('persists a valid choice + text as a thread reply, then delivers to the live session', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { content: answerableContent() })
    getSession.mockReturnValue({ name: RUN }) // session reachable
    sendPrompt.mockClear()

    const res = await answer(srv, pid, { choices: ['opt-a'], text: 'go for it' })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { point: Point; delivered: boolean } }
    expect(body.data.delivered).toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(sendPrompt.mock.calls[0]![1]).toBe(RUN)
    // The answer persisted as a user reply on the thread (choice label + text).
    const stored = srv.docStore.getSlatePoint(RUN, pid)!
    expect(stored.replies).toHaveLength(1)
    expect(stored.replies![0]!.author).toBe('user')
    expect(stored.replies![0]!.text).toContain('Deploy now')
    expect(stored.replies![0]!.text).toContain('go for it')
  }))

  it('an ended session returns delivered:false with 200, answer still persisted', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { content: answerableContent() })
    getSession.mockReturnValue(null) // session gone

    const res = await answer(srv, pid, { choices: ['opt-b'] })
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { delivered: boolean } }).data.delivered).toBe(false)
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(srv.docStore.getSlatePoint(RUN, pid)!.replies).toHaveLength(1) // persisted regardless
  }))

  it('rejects a choice id absent from the CURRENT content (INVALID_PARAMS, nothing persisted)', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { content: answerableContent() })
    const res = await answer(srv, pid, { choices: ['opt-a', 'opt-ZZZ'] })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_PARAMS')
    expect(srv.docStore.getSlatePoint(RUN, pid)!.replies).toBeUndefined()
  }))

  it('rejects oversized free text with 413, nothing persisted', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { content: answerableContent() })
    const res = await answer(srv, pid, { text: 'x'.repeat(4001) })
    expect(res.status).toBe(413)
    expect(srv.docStore.getSlatePoint(RUN, pid)!.replies).toBeUndefined()
  }))

  it('rejects an empty answer (no choice, no text) with INVALID_PARAMS', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { content: answerableContent() })
    const res = await answer(srv, pid, {})
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_PARAMS')
  }))

  it('404s for an unknown point', withServer(async srv => {
    seedRun(srv.docStore)
    const res = await answer(srv, 'pt-nope', { text: 'hi' })
    expect(res.status).toBe(404)
  }))

  // THE ROUTE-ORDERING GUARD (structural half).
  //
  // `/slate/points/:pid/answer` is a sub-resource under `/api/runs/:id`, whose PATCH
  // handler matches with a greedy `startsWith('/api/runs/')`. If the anchored answer
  // route is ever moved BELOW it, a request could fall through to a generic handler
  // that silently wins. Assert the ordering itself so a revert fails immediately.
  it('is registered BEFORE the greedy startsWith PATCH /api/runs/ handler', () => {
    const src = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8')
    // The answer route's anchored regex (backslash-escaped in source).
    const answerRoute = src.indexOf('slate\\/points\\/[^/]+\\/answer$/')
    const patchRuns = src.indexOf("method === 'PATCH' && url.startsWith('/api/runs/')")
    expect(answerRoute).toBeGreaterThan(-1)
    expect(patchRuns).toBeGreaterThan(-1)
    expect(answerRoute).toBeLessThan(patchRuns)
  })

  // ...and the behavioural half: the anchored answer route is actually matched (a
  // generic handler does NOT eat it — it returns the slate answer envelope).
  it('is matched by the anchored regex — a generic handler does not eat it', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { content: answerableContent() })
    const res = await answer(srv, pid, { choices: ['opt-a'] })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { point: Point; delivered: boolean } }
    expect(body.ok).toBe(true)
    expect(body.data.point.id).toBe(pid)              // the answered point came back
    expect(srv.docStore.getSlatePoint(RUN, pid)!.replies).toHaveLength(1) // and it mutated the point
  }))
})

describe('POST /api/runs/:id/slate/points/:pid/replies', () => {
  const reply = (srv: Harness, pid: string, payload: unknown) =>
    srv.fetch(`/api/runs/${RUN}/slate/points/${pid}/replies`, { method: 'POST', body: JSON.stringify(payload) })

  // THE ANTI-LOOP GUARD: only a USER reply prompts the session. An agent/process
  // reply must not prompt the agent's own session (infinite self-trigger).
  it('delivers a USER reply but NOT an agent reply', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { headline: 'open q' })
    getSession.mockReturnValue({ name: RUN }) // reachable
    sendPrompt.mockClear()

    const asUser = await reply(srv, pid, { author: 'user', text: 'here is a note' })
    expect(asUser.status).toBe(200)
    expect((await asUser.json() as { data: { delivered: boolean } }).data.delivered).toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(sendPrompt.mock.calls[0]![1]).toBe(RUN)

    sendPrompt.mockClear()
    const asAgent = await reply(srv, pid, { author: 'agent', text: 'ack' })
    expect(asAgent.status).toBe(200)
    expect((await asAgent.json() as { data: { delivered: boolean } }).data.delivered).toBe(false)
    expect(sendPrompt).not.toHaveBeenCalled()
    // Both persisted regardless of delivery.
    expect(srv.docStore.getSlatePoint(RUN, pid)!.replies).toHaveLength(2)
  }))

  it('a process reply does not deliver either', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { headline: 'open q' })
    getSession.mockReturnValue({ name: RUN })
    sendPrompt.mockClear()
    const res = await reply(srv, pid, { author: 'process', text: 'build finished' })
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { delivered: boolean } }).data.delivered).toBe(false)
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(srv.docStore.getSlatePoint(RUN, pid)!.replies![0]!.author).toBe('process')
  }))

  it('defaults the author to agent when omitted', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { headline: 'open q' })
    await reply(srv, pid, { text: 'because the migration is irreversible' })
    expect(srv.docStore.getSlatePoint(RUN, pid)!.replies![0]!.author).toBe('agent')
  }))

  it('rejects a bad author, empty text, and oversize text', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { headline: 'open q' })
    expect((await reply(srv, pid, { author: 'nobody', text: 'x' })).status).toBe(400)
    expect((await reply(srv, pid, { text: '   ' })).status).toBe(400)
    expect((await reply(srv, pid, { author: 'user', text: 'x'.repeat(4001) })).status).toBe(413)
    expect(srv.docStore.getSlatePoint(RUN, pid)!.replies).toBeUndefined()
  }))

  it('404s for an unknown point', withServer(async srv => {
    seedRun(srv.docStore)
    const res = await reply(srv, 'pt-nope', { author: 'user', text: 'hi' })
    expect(res.status).toBe(404)
  }))

  // REOPEN-ON-REPLY: a reply on a resolved point reopens it (plan lifecycle diagram).
  it('reopens a resolved point when a new reply arrives', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { headline: 'open q' })
    await srv.fetch(`/api/runs/${RUN}/slate/points/${pid}/resolve`, { method: 'POST' })
    expect(srv.docStore.getSlatePoint(RUN, pid)!.status).toBe('resolved')

    await reply(srv, pid, { author: 'user', text: 'actually, one more thing' })
    const after = srv.docStore.getSlatePoint(RUN, pid)!
    expect(after.resolvedAt).toBeUndefined()   // reopened
    expect(after.status).toBe('waiting')       // derived from the new user reply
  }))
})

describe('POST /api/runs/:id/slate/points/:pid/{resolve,reopen,dismiss}', () => {
  it('resolves, dismisses, and reopens without delivering a prompt', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = await createPoint(srv, { headline: 'open q' })
    getSession.mockReturnValue({ name: RUN })
    sendPrompt.mockClear()

    const resolved = await srv.fetch(`/api/runs/${RUN}/slate/points/${pid}/resolve`, { method: 'POST' })
    expect(resolved.status).toBe(200)
    expect(srv.docStore.getSlatePoint(RUN, pid)!.status).toBe('resolved')

    await srv.fetch(`/api/runs/${RUN}/slate/points/${pid}/dismiss`, { method: 'POST' })
    expect(srv.docStore.getSlatePoint(RUN, pid)!.status).toBe('dismissed')

    await srv.fetch(`/api/runs/${RUN}/slate/points/${pid}/reopen`, { method: 'POST' })
    expect(srv.docStore.getSlatePoint(RUN, pid)!.status).toBe('open')

    // A lifecycle flip is not an injection — the agent is never prompted.
    expect(sendPrompt).not.toHaveBeenCalled()
  }))

  it('404s for an unknown point', withServer(async srv => {
    seedRun(srv.docStore)
    const res = await srv.fetch(`/api/runs/${RUN}/slate/points/pt-nope/resolve`, { method: 'POST' })
    expect(res.status).toBe(404)
  }))
})

describe('POST /api/runs/:id/slate/surfaces/:pid/refresh', () => {
  const refresh = (srv: Harness, pid: string) =>
    srv.fetch(`/api/runs/${RUN}/slate/surfaces/${pid}/refresh`, { method: 'POST' })

  // Seed a FILE-projected surface: `refresh` is file-owned, so it arrives via the
  // watcher projection, NOT the user-point POST route (which never carries a recipe).
  function seedSurface(srv: Harness, over: Record<string, unknown> = {}): string {
    srv.docStore.applyRunSlateProjection(RUN, [{
      id: 'srf-1', author: 'agent', headline: 'a surface',
      content: { root: 'r', components: [{ id: 'r', component: 'Text', text: 'x' }] },
      ...over,
    }])
    return 'srf-1'
  }

  it('with a recipe delivers the recipe VERBATIM and persists nothing', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = seedSurface(srv, { refresh: 'Re-run the blind PR eval and rewrite the file' })
    getSession.mockReturnValue({ name: RUN }) // reachable
    sendPrompt.mockClear()

    const res = await refresh(srv, pid)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { delivered: boolean } }
    expect(body.ok).toBe(true)
    expect(body.data.delivered).toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(sendPrompt.mock.calls[0]![1]).toBe(RUN)
    const prompt = sendPrompt.mock.calls[0]![2] as string
    expect(prompt).toContain('Re-run the blind PR eval and rewrite the file') // recipe verbatim
    // Persist-nothing: refresh is a nudge — the point gains no thread / no mutation.
    expect(srv.docStore.getSlatePoint(RUN, pid)!.replies).toBeUndefined()
  }))

  it('without a recipe delivers the bare regenerate-nudge', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = seedSurface(srv) // no refresh recipe
    getSession.mockReturnValue({ name: RUN })
    sendPrompt.mockClear()

    const res = await refresh(srv, pid)
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { delivered: boolean } }).data.delivered).toBe(true)
    const prompt = sendPrompt.mock.calls[0]![2] as string
    expect(prompt).toContain('Regenerate the Slate surface')
    expect(prompt).toContain(pid)
  }))

  it('an unreachable session returns delivered:false + 200 and persists nothing', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = seedSurface(srv, { refresh: 'recipe' })
    getSession.mockReturnValue(null) // session gone

    const res = await refresh(srv, pid)
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { delivered: boolean } }).data.delivered).toBe(false)
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(srv.docStore.getSlatePoint(RUN, pid)!.replies).toBeUndefined()
  }))

  it('rejects a cross-run pid (point.runId !== URL runId) with 404, nothing delivered', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = seedSurface(srv, { refresh: 'recipe' }) // belongs to RUN
    getSession.mockReturnValue({ name: RUN })
    // POST under a DIFFERENT run id — the cross-run guard must reject it.
    const res = await srv.fetch(`/api/runs/OTHER-run/slate/surfaces/${pid}/refresh`, { method: 'POST' })
    expect(res.status).toBe(404)
    expect(sendPrompt).not.toHaveBeenCalled()
  }))

  it('404s for an unknown surface', withServer(async srv => {
    seedRun(srv.docStore)
    const res = await refresh(srv, 'srf-nope')
    expect(res.status).toBe(404)
  }))

  // ROUTE-ORDERING GUARD (structural): the anchored /refresh regex must precede the
  // greedy PATCH /api/runs/ handler, or a request could fall through to it (break the
  // order → this test goes red).
  it('is registered BEFORE the greedy startsWith PATCH /api/runs/ handler', () => {
    const src = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8')
    const refreshRoute = src.indexOf('slate\\/surfaces\\/[^/]+\\/refresh$/')
    const patchRuns = src.indexOf("method === 'PATCH' && url.startsWith('/api/runs/')")
    expect(refreshRoute).toBeGreaterThan(-1)
    expect(patchRuns).toBeGreaterThan(-1)
    expect(refreshRoute).toBeLessThan(patchRuns)
  })

  // ...and behavioural: the anchored route is actually matched (a generic handler does
  // NOT eat it — it returns the refresh envelope).
  it('is matched by the anchored regex — a generic handler does not eat it', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = seedSurface(srv, { refresh: 'recipe' })
    getSession.mockReturnValue({ name: RUN })
    const res = await refresh(srv, pid)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { delivered: boolean } }
    expect(body.ok).toBe(true)
    expect(typeof body.data.delivered).toBe('boolean')
  }))
})

describe('POST /api/runs/:id/slate/explain', () => {
  const explain = (srv: Harness) =>
    srv.fetch(`/api/runs/${RUN}/slate/explain`, { method: 'POST' })

  it('delivers the multi-surface explain nudge and persists nothing', withServer(async srv => {
    seedRun(srv.docStore)
    getSession.mockReturnValue({ name: RUN }) // reachable
    sendPrompt.mockClear()

    const res = await explain(srv)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { delivered: boolean } }
    expect(body.ok).toBe(true)
    expect(body.data.delivered).toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(sendPrompt.mock.calls[0]![1]).toBe(RUN)
    const prompt = sendPrompt.mock.calls[0]![2] as string
    expect(prompt).toContain('Explain this session on its Slate') // multi-surface framing
    expect(prompt).toContain('SEPARATE surfaces')
    expect(prompt).toContain('.tinstar/slate/')                   // authoring-to-file instruction
    // Persist-nothing: no surface is created by the nudge itself.
    expect(srv.docStore.getRun(RUN)!.slate ?? []).toHaveLength(0)
  }))

  it('an unreachable session returns delivered:false + 200 (persists nothing)', withServer(async srv => {
    seedRun(srv.docStore)
    getSession.mockReturnValue(null) // session gone
    const res = await explain(srv)
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { delivered: boolean } }).data.delivered).toBe(false)
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(srv.docStore.getRun(RUN)!.slate ?? []).toHaveLength(0)
  }))
})

describe('POST /api/runs/:id/slate/compose', () => {
  const compose = (srv: Harness, payload: unknown) =>
    srv.fetch(`/api/runs/${RUN}/slate/compose`, { method: 'POST', body: JSON.stringify(payload) })

  it('delivers the composed authoring prompt (prompt + freeform interpolated)', withServer(async srv => {
    seedRun(srv.docStore)
    getSession.mockReturnValue({ name: RUN }) // reachable
    sendPrompt.mockClear()

    const res = await compose(srv, { prompt: 'Build a PR review surface', freeform: 'focus on the migration' })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { delivered: boolean } }
    expect(body.ok).toBe(true)
    expect(body.data.delivered).toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(sendPrompt.mock.calls[0]![1]).toBe(RUN)
    const prompt = sendPrompt.mock.calls[0]![2] as string
    expect(prompt).toContain('Build a PR review surface') // template prompt interpolated
    expect(prompt).toContain('focus on the migration')    // freeform interpolated
    expect(prompt).toContain('.tinstar/slate/')           // authoring-to-file instruction
  }))

  it('a freeform-only body delivers the freeform text', withServer(async srv => {
    seedRun(srv.docStore)
    getSession.mockReturnValue({ name: RUN })
    sendPrompt.mockClear()
    const res = await compose(srv, { freeform: 'a checklist of deploy steps' })
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { delivered: boolean } }).data.delivered).toBe(true)
    expect(sendPrompt.mock.calls[0]![2]).toContain('a checklist of deploy steps')
  }))

  it('an empty body (no prompt, no freeform) is INVALID_PARAMS, nothing delivered', withServer(async srv => {
    seedRun(srv.docStore)
    getSession.mockReturnValue({ name: RUN })
    const res = await compose(srv, { prompt: '   ', freeform: '' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_PARAMS')
    expect(sendPrompt).not.toHaveBeenCalled()
  }))

  it('an unreachable session returns delivered:false + 200 (persists nothing)', withServer(async srv => {
    seedRun(srv.docStore)
    getSession.mockReturnValue(null) // session gone
    const res = await compose(srv, { prompt: 'Author a Dataflow surface' })
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { delivered: boolean } }).data.delivered).toBe(false)
    expect(sendPrompt).not.toHaveBeenCalled()
  }))
})

describe('refresh/compose — code-spawned author branch (feat: multi-agent Slate)', () => {
  function seedSurfaceWithRecipe(srv: Harness, id = 'srf-auth'): string {
    srv.docStore.applyRunSlateProjection(RUN, [{
      id, author: 'agent', headline: 'a surface',
      content: { root: 'r', components: [{ id: 'r', component: 'Text', text: 'x' }] },
      refresh: 'Re-run the eval of PR #7 and rewrite this surface',
    }])
    return id
  }

  it('a surface WITH a recipe spawns an author — no main-agent nudge', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = seedSurfaceWithRecipe(srv)
    dispatchSurfaceAuthor.mockReturnValue({ dispatched: true })
    getSession.mockReturnValue({ name: RUN }) // would be reachable — the author path skips it
    const res = await srv.fetch(`/api/runs/${RUN}/slate/surfaces/${pid}/refresh`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { dispatched: boolean } }).data.dispatched).toBe(true)
    expect(dispatchSurfaceAuthor).toHaveBeenCalledTimes(1)
    const arg = dispatchSurfaceAuthor.mock.calls[0]![0] as { runId: string; prompt: string }
    expect(arg.runId).toBe(RUN)
    expect(arg.prompt).toContain('Re-run the eval of PR #7') // recipe carried into the author prompt
    expect(sendPrompt).not.toHaveBeenCalled()                // the run's main agent is untouched
  }))

  it('a recipe surface falls back to the main agent when the spawn declines', withServer(async srv => {
    seedRun(srv.docStore)
    const pid = seedSurfaceWithRecipe(srv)
    dispatchSurfaceAuthor.mockReturnValue({ dispatched: false }) // disabled / no workdir / spawn error
    getSession.mockReturnValue({ name: RUN })
    const res = await srv.fetch(`/api/runs/${RUN}/slate/surfaces/${pid}/refresh`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { delivered: boolean } }).data.delivered).toBe(true)
    expect(dispatchSurfaceAuthor).toHaveBeenCalledTimes(1)
    expect(sendPrompt).toHaveBeenCalledTimes(1) // fell back to the unchanged main-agent nudge
  }))

  it('a surface WITHOUT a recipe never spawns an author (session-derived stays main-agent)', withServer(async srv => {
    seedRun(srv.docStore)
    srv.docStore.applyRunSlateProjection(RUN, [{
      id: 'srf-norecipe', author: 'agent', headline: 'no recipe',
      content: { root: 'r', components: [{ id: 'r', component: 'Text', text: 'x' }] },
    }])
    getSession.mockReturnValue({ name: RUN })
    const res = await srv.fetch(`/api/runs/${RUN}/slate/surfaces/srf-norecipe/refresh`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(dispatchSurfaceAuthor).not.toHaveBeenCalled()
    expect(sendPrompt).toHaveBeenCalledTimes(1) // the unchanged main-agent path
  }))

  it('compose offloads to an author when enabled', withServer(async srv => {
    seedRun(srv.docStore)
    dispatchSurfaceAuthor.mockReturnValue({ dispatched: true })
    const res = await srv.fetch(`/api/runs/${RUN}/slate/compose`, {
      method: 'POST', body: JSON.stringify({ prompt: 'Build a PR review surface' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { dispatched: boolean } }).data.dispatched).toBe(true)
    expect(dispatchSurfaceAuthor).toHaveBeenCalledTimes(1)
    expect(sendPrompt).not.toHaveBeenCalled()
  }))
})

describe('PUT /api/runs/:id/slate/points/order (S6 U2)', () => {
  /** Seed N points over HTTP and return their ids in creation order. */
  async function seedPoints(srv: Harness, n: number): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < n; i++) ids.push(await createPoint(srv, { headline: `point ${i}` }))
    return ids
  }

  const putOrder = (srv: Harness, order: unknown) =>
    srv.fetch(`/api/runs/${RUN}/slate/points/order`, { method: 'PUT', body: JSON.stringify({ order }) })

  it('reorders the run\'s points and re-projects run.slate', withServer(async srv => {
    seedRun(srv.docStore)
    const [a, b, c] = await seedPoints(srv, 3)
    expect(srv.docStore.getSlatePointsForRun(RUN).map(p => p.id)).toEqual([a, b, c])

    const res = await putOrder(srv, [c, a, b])
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { order: string[] } }
    expect(body.ok).toBe(true)
    expect(body.data.order).toEqual([c, a, b])

    // The store AND the render projection agree — the projection leg is the one
    // that fails silently if `order: p.order ?? p.createdAt` is ever backed out.
    expect(srv.docStore.getSlatePointsForRun(RUN).map(p => p.id)).toEqual([c, a, b])
    expect(srv.docStore.getRun(RUN)!.slate!.map(s => s.id)).toEqual([c, a, b])
  }))

  it('never delivers a prompt — a reorder is an arrangement, not an injection', withServer(async srv => {
    seedRun(srv.docStore)
    getSession.mockReturnValue({ name: RUN }) // session reachable, still no prompt
    const [a, b] = await seedPoints(srv, 2)
    sendPrompt.mockClear()
    await putOrder(srv, [b, a])
    expect(sendPrompt).not.toHaveBeenCalled()
  }))

  it('404s when the run does not exist', withServer(async srv => {
    const res = await putOrder(srv, ['whatever'])
    expect(res.status).toBe(404)
  }))

  it('rejects a non-array or non-string order (INVALID_PARAMS, nothing moved)', withServer(async srv => {
    seedRun(srv.docStore)
    const [a, b] = await seedPoints(srv, 2)

    for (const bad of ['nope', 42, null, { 0: a }, [a, 7], [a, ''], [a, null]]) {
      const res = await putOrder(srv, bad)
      expect(res.status).toBe(400)
      expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_PARAMS')
    }
    // A malformed body is inert — the order is untouched.
    expect(srv.docStore.getSlatePointsForRun(RUN).map(p => p.id)).toEqual([a, b])
  }))

  it('rejects a body that is not a JSON object', withServer(async srv => {
    seedRun(srv.docStore)
    await seedPoints(srv, 2)
    const res = await srv.fetch(`/api/runs/${RUN}/slate/points/order`, { method: 'PUT', body: 'not json' })
    expect(res.status).toBe(400)
  }))

  it('ignores unknown ids and leaves unlisted points where they were', withServer(async srv => {
    // Deterministic even when all three land in the same millisecond: the store
    // deconflicts against the WHOLE run, so an unlisted point sharing a slot with the
    // reordered ones is nudged out of the tie rather than sorting into the middle of
    // them by id. (See the "cannot let an unlisted point slide in" store test.)
    seedRun(srv.docStore)
    const [a, b, c] = await seedPoints(srv, 3)
    const res = await putOrder(srv, [b, 'ghost', a]) // c is not mentioned at all
    expect(res.status).toBe(200)
    expect(srv.docStore.getSlatePointsForRun(RUN).map(p => p.id)).toEqual([b, a, c])
  }))

  // THE ROUTE-ORDERING GUARD: like the answer route, this is a sub-resource under
  // `/api/runs/:id` and must be registered above the greedy PATCH handler.
  it('is registered BEFORE the greedy startsWith PATCH /api/runs/ handler', () => {
    const src = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8')
    const orderRoute = src.indexOf('slate\\/points\\/order$/')
    const patchRuns = src.indexOf("method === 'PATCH' && url.startsWith('/api/runs/')")
    expect(orderRoute).toBeGreaterThan(-1)
    expect(patchRuns).toBeGreaterThan(-1)
    expect(orderRoute).toBeLessThan(patchRuns)
  })
})
