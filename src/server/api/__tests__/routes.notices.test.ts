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

async function post(srv: Harness, sessionId: string, over: Record<string, unknown> = {}): Promise<Response> {
  return srv.fetch('/api/notices', {
    method: 'POST',
    body: JSON.stringify({ sessionId, kind: 'needs-you', headline: 'Deploy or wait?', background: 'context', ...over }),
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
    // and it landed in the store
    expect(srv.docStore.getNotice(body.data.id)).toBeDefined()
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

  it('returns 413 for an oversized background', withServer(async srv => {
    seedRun(srv.docStore, 'CLD-run-1', 'sess-1')
    const res = await post(srv, 'sess-1', { background: 'x'.repeat(16 * 1024 + 1) })
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
