import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import type { Notice, Run } from '../../../domain/types'

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

function seedRun(store: DocumentStore, id: string, sessionId: string): void {
  const run: Run = {
    id, sessionId, status: 'running', name: undefined,
    initiative: '', epic: '', task: '', repo: 'repo', worktree: 'wt',
    taskId: 'task-1', worktreeId: 'wt', createdAt: '2026-07-01T00:00:00Z',
    recapEntries: [], touchedFiles: [], rawLogs: '', port: null,
    backend: 'tmux', spaceId: 'spc-1',
  } as unknown as Run
  store.upsertRun(id, run)
}

/** A minimal valid A2UI v0_9 content description (a single Text node). */
function validContent(text = 'context') {
  return { root: 'root', components: [{ id: 'root', component: 'Text', text, variant: 'body' }] }
}

async function post(srv: Harness, sessionId: string, over: Record<string, unknown> = {}): Promise<Response> {
  return srv.fetch('/api/notices', {
    method: 'POST',
    body: JSON.stringify({ sessionId, kind: 'needs-you', headline: 'Deploy or wait?', content: validContent(), ...over }),
  })
}

function withServer(fn: (srv: Harness) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'notices-route-'))
    const srv = createTestServer(root)
    try { await fn(srv) } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('POST /api/notices', () => {
  it('posts a notice for a known session: generates an id, sets runId, equal timestamps', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const res = await post(srv, 'sess-1')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: Notice }
    expect(body.ok).toBe(true)
    expect(body.data.id).toBeTruthy()
    expect(body.data.runId).toBe('CLD-run-1')
    expect(body.data.kind).toBe('needs-you')
    expect(body.data.createdAt).toBe(body.data.amendedAt)
    // the validated A2UI content round-trips onto the stored notice
    expect(body.data.content).toEqual(validContent())
    // and it landed in the store
    expect(srv.docStore.getNotice(body.data.id)).toBeDefined()
  }))

  it('stores and returns a valid A2UI content tree', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const tree = {
      root: 'root',
      components: [
        { id: 'root', component: 'Column', children: ['h', 'p'] },
        { id: 'h', component: 'Text', text: 'Heads up', variant: 'h2' },
        { id: 'p', component: 'Text', text: 'A decision was made.', variant: 'body' },
      ],
    }
    const res = await post(srv, 'sess-1', { content: tree })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Notice }
    expect(body.data.content).toEqual(tree)
  }))

  it('accepts a headline-only notice with no content', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const res = await post(srv, 'sess-1', { content: undefined })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Notice }
    expect(body.data.content).toBeUndefined()
  }))

  it('returns INVALID_PARAMS (400) for malformed content and stores nothing', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    // Missing the required `root`/`components` envelope — fails the v0_9 schema.
    const res = await post(srv, 'sess-1', { content: { nope: true } })
    expect(res.status).toBe(400)
    const body = await res.json() as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('INVALID_PARAMS')
    expect(srv.docStore.getAllNotices()).toHaveLength(0)
  }))

  it('returns SESSION_NOT_FOUND (404) for an unknown session', withServer(async srv => {
    const res = await post(srv, 'nobody')
    expect(res.status).toBe(404)
    const body = await res.json() as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('SESSION_NOT_FOUND')
  }))

  it('returns INVALID_PARAMS (400) for an invalid kind', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const res = await post(srv, 'sess-1', { kind: 'urgent' })
    expect(res.status).toBe(400)
    const body = await res.json() as { ok: boolean; error: { code: string } }
    expect(body.error.code).toBe('INVALID_PARAMS')
  }))

  it('returns INVALID_PARAMS (400) for an empty headline', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const res = await post(srv, 'sess-1', { headline: '   ' })
    expect(res.status).toBe(400)
    const body = await res.json() as { ok: boolean; error: { code: string } }
    expect(body.error.code).toBe('INVALID_PARAMS')
  }))

  it('returns 413 for oversized content', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const res = await post(srv, 'sess-1', { content: validContent('x'.repeat(32 * 1024 + 1)) })
    expect(res.status).toBe(413)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(false)
  }))
})

describe('PATCH /api/notices/:id', () => {
  it('amends a notice: changed headline is returned with amendedAt >= createdAt', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }
    const id = created.data.id

    const res = await srv.fetch(`/api/notices/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ headline: 'Deploy, wait, or ship behind a flag?' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: Notice }
    expect(body.data.headline).toBe('Deploy, wait, or ship behind a flag?')
    expect(body.data.amendedAt).toBeGreaterThanOrEqual(body.data.createdAt)
    expect(body.data.createdAt).toBe(created.data.createdAt) // createdAt is immutable
  }))

  it('returns 404 when amending a missing notice', withServer(async srv => {
    const res = await srv.fetch('/api/notices/notice-missing', {
      method: 'PATCH',
      body: JSON.stringify({ headline: 'x' }),
    })
    expect(res.status).toBe(404)
  }))

  async function seedAndPatch(srv: Harness, patch: unknown): Promise<{ id: string; res: Response }> {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }
    const id = created.data.id
    const res = await srv.fetch(`/api/notices/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    return { id, res }
  }

  it('returns INVALID_PARAMS (400) for an invalid kind', withServer(async srv => {
    const { res } = await seedAndPatch(srv, { kind: 'urgent' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_PARAMS')
  }))

  it('returns 413 for oversized content', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }
    const big = await srv.fetch(`/api/notices/${created.data.id}`, {
      method: 'PATCH', body: JSON.stringify({ content: validContent('x'.repeat(32 * 1024 + 1)) }),
    })
    expect(big.status).toBe(413)
  }))

  it('rejects malformed content (400) rather than persisting a crash vector', withServer(async srv => {
    const { id, res } = await seedAndPatch(srv, { content: { nope: true } })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_PARAMS')
    // and the stored notice keeps its prior valid content — nothing corrupt landed
    expect(srv.docStore.getNotice(id)!.content).toEqual(validContent())
  }))

  it('amends content in place with a new valid tree', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }
    const next = validContent('a fourth option appeared')
    const res = await srv.fetch(`/api/notices/${created.data.id}`, {
      method: 'PATCH', body: JSON.stringify({ content: next }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Notice }
    expect(body.data.content).toEqual(next)
  }))

  it('clears content to a headline-only notice when patched with null', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }
    const res = await srv.fetch(`/api/notices/${created.data.id}`, {
      method: 'PATCH', body: JSON.stringify({ content: null }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Notice }
    expect(body.data.content).toBeUndefined()
  }))

  it('ignores attempts to change immutable id / runId / createdAt', withServer(async srv => {
    const { id, res } = await seedAndPatch(srv, {
      headline: 'legit change', id: 'hijacked', runId: 'victim-run', createdAt: 0,
    })
    expect(res.status).toBe(200)
    const stored = srv.docStore.getNotice(id)!
    expect(stored.id).toBe(id)              // not re-keyed
    expect(stored.runId).toBe('CLD-run-1')  // cascade key intact
    expect(stored.createdAt).not.toBe(0)    // provenance intact
    expect(stored.headline).toBe('legit change')
  }))

  it('returns INVALID_PARAMS (400) for a non-object body (null) instead of hanging', withServer(async srv => {
    const { res } = await seedAndPatch(srv, null)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_PARAMS')
  }))
})

describe('DELETE /api/notices/:id', () => {
  it('deletes an existing notice (200) then reports missing (404)', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }
    const id = created.data.id

    const first = await srv.fetch(`/api/notices/${id}`, { method: 'DELETE' })
    expect(first.status).toBe(200)
    expect(srv.docStore.getNotice(id)).toBeUndefined()

    const second = await srv.fetch(`/api/notices/${id}`, { method: 'DELETE' })
    expect(second.status).toBe(404)
  }))
})

describe('GET /api/notices', () => {
  it('lists all notices as { ok: true, data: [...] }', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    await post(srv, 'sess-1', { headline: 'first' })
    await post(srv, 'sess-1', { kind: 'fyi', headline: 'second' })

    const res = await srv.fetch('/api/notices')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: Notice[] }
    expect(body.ok).toBe(true)
    expect(body.data).toHaveLength(2)
    expect(body.data.map(n => n.headline).sort()).toEqual(['first', 'second'])
  }))
})

describe('POST /api/notices/:id/answer', () => {
  /** A needs-you content tree with a single-select Choice (opt-a/opt-b), a text
   *  field, and a submit — the answerable shape the widget renders (U2/U3). */
  function answerableContent() {
    return {
      root: 'root',
      components: [
        { id: 'root', component: 'Column', children: ['q', 'choice', 'notes', 'go'] },
        { id: 'q', component: 'Text', text: 'Deploy or wait?', variant: 'body' },
        {
          id: 'choice', component: 'Choice', mode: 'single',
          options: [{ id: 'opt-a', label: 'Deploy now' }, { id: 'opt-b', label: 'Wait' }],
        },
        { id: 'notes', component: 'TextInput', label: 'Notes' },
        { id: 'go', component: 'Submit', label: 'Submit' },
      ],
    }
  }

  async function seedAnswerable(srv: Harness): Promise<string> {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1', { content: answerableContent() })).json() as { data: Notice }
    return created.data.id
  }

  function answer(srv: Harness, id: string, payload: unknown): Promise<Response> {
    return srv.fetch(`/api/notices/${id}/answer`, { method: 'POST', body: JSON.stringify(payload) })
  }

  it('persists a valid choice + text, marks answered, and reports delivery deferred (no live session)', withServer(async srv => {
    const id = await seedAnswerable(srv)
    const res = await answer(srv, id, { choices: ['opt-a'], text: 'go for it' })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { notice: Notice; delivered: boolean } }
    expect(body.ok).toBe(true)
    expect(body.data.notice.answer).toBeTruthy()
    expect(body.data.notice.answer!.choices).toEqual(['opt-a'])
    expect(body.data.notice.answer!.text).toBe('go for it')
    expect(body.data.notice.answer!.answeredAt).toBeGreaterThan(0)
    // No tmux session exists in this harness → delivery is best-effort deferred,
    // but the answer still persisted (durable, KTD1).
    expect(body.data.delivered).toBe(false)
    expect(srv.docStore.getNotice(id)!.answer!.choices).toEqual(['opt-a'])
  }))

  it('fires exactly one notice change on answer (live refresh for the widget)', withServer(async srv => {
    const id = await seedAnswerable(srv)
    const events: string[] = []
    srv.docStore.changes.on('change', (e: unknown) => {
      const c = e as { entity: string; id: string }
      if (c.entity === 'notice') events.push(c.id)
    })
    await answer(srv, id, { choices: ['opt-b'] })
    expect(events).toEqual([id])
  }))

  it('rejects a choice id not in the notice declared set (INVALID_PARAMS, nothing persisted)', withServer(async srv => {
    const id = await seedAnswerable(srv)
    const res = await answer(srv, id, { choices: ['opt-a', 'opt-ZZZ'] })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_PARAMS')
    expect(srv.docStore.getNotice(id)!.answer).toBeUndefined()
  }))

  it('rejects oversized free text (413), nothing persisted', withServer(async srv => {
    const id = await seedAnswerable(srv)
    const res = await answer(srv, id, { text: 'x'.repeat(4001) })
    expect(res.status).toBe(413)
    expect(srv.docStore.getNotice(id)!.answer).toBeUndefined()
  }))

  it('rejects an empty answer (no choices, no text) with INVALID_PARAMS', withServer(async srv => {
    const id = await seedAnswerable(srv)
    const res = await answer(srv, id, {})
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_PARAMS')
    expect(srv.docStore.getNotice(id)!.answer).toBeUndefined()
  }))

  it('returns 404 for an unknown notice', withServer(async srv => {
    const res = await answer(srv, 'notice-missing', { text: 'hi' })
    expect(res.status).toBe(404)
  }))

  // Covers AE2 (origin): a dissent on an FYI persists the objection as a dissent
  // answer (delivered toward the posting session; deferred here with no tmux).
  it('persists an FYI dissent (dissent:true + text, no choices)', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const fyi = await (await post(srv, 'sess-1', { kind: 'fyi', headline: 'Skipped a flaky test', content: undefined })).json() as { data: Notice }
    const res = await answer(srv, fyi.data.id, { dissent: true, text: "don't skip it — it caught a real bug last week" })
    expect(res.status).toBe(200)
    const stored = srv.docStore.getNotice(fyi.data.id)!
    expect(stored.answer!.dissent).toBe(true)
    expect(stored.answer!.choices).toEqual([])
    expect(stored.answer!.text).toContain('real bug')
  }))

  it('answers a free-text-only notice (no choices declared) — AE6', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const textOnly = {
      root: 'root',
      components: [
        { id: 'root', component: 'Column', children: ['t', 'go'] },
        { id: 't', component: 'TextInput', label: 'Your call' },
        { id: 'go', component: 'Submit', label: 'Submit' },
      ],
    }
    const created = await (await post(srv, 'sess-1', { content: textOnly })).json() as { data: Notice }
    const res = await answer(srv, created.data.id, { text: 'ship it' })
    expect(res.status).toBe(200)
    expect(srv.docStore.getNotice(created.data.id)!.answer!.text).toBe('ship it')
  }))
})

// The user's one attention bit (R24). Deliberately NOT a status workflow: a
// single optional timestamp, set and cleared, with no enum and no state machine.
describe('POST/DELETE /api/notices/:id/dismiss', () => {
  it('POST sets dismissedAt to now and returns the updated notice', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }
    const before = Date.now()

    const res = await srv.fetch(`/api/notices/${created.data.id}/dismiss`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: Notice }
    expect(body.ok).toBe(true)
    expect(body.data.dismissedAt).toBeGreaterThanOrEqual(before)
    expect(srv.docStore.getNotice(created.data.id)!.dismissedAt).toBe(body.data.dismissedAt)
  }))

  it('does NOT delete the notice — it stays on the board so undo is possible', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }

    await srv.fetch(`/api/notices/${created.data.id}/dismiss`, { method: 'POST' })

    expect(srv.docStore.getNotice(created.data.id)).toBeDefined()
    expect(srv.docStore.getAllNotices()).toHaveLength(1)
  }))

  it('DELETE clears dismissedAt (undo) without pulling the notice down', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }
    await srv.fetch(`/api/notices/${created.data.id}/dismiss`, { method: 'POST' })

    const res = await srv.fetch(`/api/notices/${created.data.id}/dismiss`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: Notice }
    expect(body.ok).toBe(true)
    expect(body.data.dismissedAt).toBeUndefined()
    // The DELETE /dismiss route must NOT be swallowed by the generic pull route.
    expect(srv.docStore.getNotice(created.data.id)).toBeDefined()
    expect(srv.docStore.getNotice(created.data.id)!.dismissedAt).toBeUndefined()
  }))

  it('leaves the rest of the notice untouched, including amendedAt', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }

    await srv.fetch(`/api/notices/${created.data.id}/dismiss`, { method: 'POST' })

    const stored = srv.docStore.getNotice(created.data.id)!
    // A user dismissing is not an agent amend — the derived staleness signal
    // reads amendedAt, so bumping it would make an old notice look fresh.
    expect(stored.amendedAt).toBe(created.data.amendedAt)
    expect(stored.createdAt).toBe(created.data.createdAt)
    expect(stored.headline).toBe(created.data.headline)
    expect(stored.kind).toBe(created.data.kind)
    expect(stored.content).toEqual(created.data.content)
  }))

  it('does not answer the notice — dismissing never prompts the posting agent', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }

    await srv.fetch(`/api/notices/${created.data.id}/dismiss`, { method: 'POST' })

    expect(srv.docStore.getNotice(created.data.id)!.answer).toBeUndefined()
  }))

  it('returns NOT_FOUND (404) for an unknown notice on both POST and DELETE', withServer(async srv => {
    for (const method of ['POST', 'DELETE']) {
      const res = await srv.fetch('/api/notices/notice-nope/dismiss', { method })
      expect(res.status).toBe(404)
      const body = await res.json() as { ok: boolean; error: { code: string } }
      expect(body.ok).toBe(false)
      expect(body.error.code).toBe('NOT_FOUND')
    }
  }))

  it('is idempotent enough: a second DELETE on an undismissed notice still 200s and leaves it undismissed', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const created = await (await post(srv, 'sess-1')).json() as { data: Notice }

    const res = await srv.fetch(`/api/notices/${created.data.id}/dismiss`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(srv.docStore.getNotice(created.data.id)!.dismissedAt).toBeUndefined()
  }))
})
