// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import type { Run } from '../../../domain/types'
import type { BusEvent } from '../../types'

const RUN_ID = 'vpppm-general-pourpose-2dc86'

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
  const events: BusEvent[] = []
  const ctx = {
    sessionConfig: cfg,
    docStore,
    bus: { emit: (ev: BusEvent) => events.push(ev) },
    natsTraffic: undefined,
    natsHealth: undefined,
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

function seedRun(docStore: DocumentStore, over: Partial<Run> = {}): void {
  const run: Run = {
    id: RUN_ID, status: 'running', sessionId: RUN_ID,
    background: false, blocked: false,
    initiative: '', epic: '', task: 'VPP',
    repo: 'repo', worktree: 'wt-vpppm', taskId: 'task-1', worktreeId: 'wt',
    createdAt: '2026-07-13T00:00:00Z', recapEntries: [], touchedFiles: [],
    rawLogs: '', port: null, backend: 'tmux',
    ...over,
  } as unknown as Run
  docStore.upsertRun(run.id, run)
}

async function withServer(fn: (srv: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'run-name-'))
  const srv = createTestServer(root)
  try { await fn(srv) } finally { await srv.close(); rmSync(root, { recursive: true, force: true }) }
}

const patchName = (srv: Harness, body: unknown) =>
  srv.fetch(`/api/runs/${RUN_ID}`, { method: 'PATCH', body: JSON.stringify(body) })

describe('PATCH /api/runs/:id — friendly name', () => {
  it('persists a free-text name verbatim, without id-sanitizing it', async () => {
    await withServer(async srv => {
      seedRun(srv.docStore)
      const res = await patchName(srv, { name: 'PM: Vpp project (Q3)' })
      expect(res.status).toBe(200)
      // Colon, spaces and parens survive — this is NOT the id sanitizer's input.
      expect(srv.docStore.getRun(RUN_ID)?.name).toBe('PM: Vpp project (Q3)')
    })
  })

  it('round-trips multibyte UTF-8 without corruption', async () => {
    await withServer(async srv => {
      seedRun(srv.docStore)
      await patchName(srv, { name: '⚡ Проект VPP — café 🔋' })
      expect(srv.docStore.getRun(RUN_ID)?.name).toBe('⚡ Проект VPP — café 🔋')
    })
  })

  it('leaves the run identity byte-identical after a rename', async () => {
    await withServer(async srv => {
      seedRun(srv.docStore)
      const before = srv.docStore.getRun(RUN_ID)!
      await patchName(srv, { name: 'PM Vpp project' })
      const after = srv.docStore.getRun(RUN_ID)!
      expect(after.id).toBe(before.id)
      expect(after.sessionId).toBe(before.sessionId)
      expect(after.worktree).toBe(before.worktree)
    })
  })

  it('refuses to let a client rewrite identity fields through the catch-all merge', async () => {
    await withServer(async srv => {
      seedRun(srv.docStore)
      await patchName(srv, { name: 'PM Vpp project', id: 'hijacked', sessionId: 'hijacked', worktree: 'hijacked' })
      const after = srv.docStore.getRun(RUN_ID)!
      expect(after.id).toBe(RUN_ID)
      expect(after.sessionId).toBe(RUN_ID)
      expect(after.worktree).toBe('wt-vpppm')
      expect(after.name).toBe('PM Vpp project')
    })
  })

  it('clears the name on an empty string, so the UI falls back to the id', async () => {
    await withServer(async srv => {
      seedRun(srv.docStore, { name: 'PM Vpp project' } as Partial<Run>)
      const res = await patchName(srv, { name: '' })
      expect(res.status).toBe(200)
      expect(srv.docStore.getRun(RUN_ID)?.name).toBeUndefined()
    })
  })

  it('clears the name on whitespace-only input', async () => {
    await withServer(async srv => {
      seedRun(srv.docStore, { name: 'PM Vpp project' } as Partial<Run>)
      await patchName(srv, { name: '   ' })
      expect(srv.docStore.getRun(RUN_ID)?.name).toBeUndefined()
    })
  })

  it('clears the name on null', async () => {
    await withServer(async srv => {
      seedRun(srv.docStore, { name: 'PM Vpp project' } as Partial<Run>)
      await patchName(srv, { name: null })
      expect(srv.docStore.getRun(RUN_ID)?.name).toBeUndefined()
    })
  })

  it('leaves an existing name untouched when the patch omits name', async () => {
    await withServer(async srv => {
      seedRun(srv.docStore, { name: 'PM Vpp project' } as Partial<Run>)
      await patchName(srv, { taskId: 'task-2' })
      expect(srv.docStore.getRun(RUN_ID)?.name).toBe('PM Vpp project')
    })
  })

  it('rejects a non-string name', async () => {
    await withServer(async srv => {
      seedRun(srv.docStore)
      const res = await patchName(srv, { name: 42 })
      expect(res.status).toBe(400)
      expect(srv.docStore.getRun(RUN_ID)?.name).toBeUndefined()
    })
  })

  it('rejects a malformed JSON body rather than throwing', async () => {
    await withServer(async srv => {
      seedRun(srv.docStore)
      const res = await srv.fetch(`/api/runs/${RUN_ID}`, { method: 'PATCH', body: '{not json' })
      expect(res.status).toBe(400)
    })
  })

  it('caps a pathologically long name', async () => {
    await withServer(async srv => {
      seedRun(srv.docStore)
      await patchName(srv, { name: 'x'.repeat(500) })
      expect(srv.docStore.getRun(RUN_ID)?.name).toHaveLength(200)
    })
  })

  it('404s for an unknown run', async () => {
    await withServer(async srv => {
      const res = await srv.fetch('/api/runs/nope', { method: 'PATCH', body: JSON.stringify({ name: 'x' }) })
      expect(res.status).toBe(404)
    })
  })
})
