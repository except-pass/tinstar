import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import { createSession, getSession } from '../../sessions/session'
import { graveyardSnapshotPath } from '../../sessions/graveyard-snapshot'
import type { Run, RecapEntry, Tombstone } from '../../../domain/types'
import type { BusEvent } from '../../types'

const FIXTURE_SPACE_ID = 'spc-test-fixture'

interface Harness {
  docStore: DocumentStore
  events: BusEvent[]
  sessionsDir: string
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
    events,
    sessionsDir: cfg.dirs.sessions,
    async fetch(path, init) {
      await ready
      const headers = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) }
      return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers })
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

function seedRun(docStore: DocumentStore, name: string, recap: RecapEntry[], friendlyName?: string): void {
  const run: Run = {
    id: name, status: 'stopped', sessionId: name, name: friendlyName,
    initiative: '', epic: '', task: 'Graveyard design',
    repo: 'repo', worktree: 'wt', taskId: 'task-1', worktreeId: 'wt',
    createdAt: '2026-06-30T00:00:00Z', recapEntries: recap, touchedFiles: [],
    rawLogs: '', port: null, backend: 'tmux', spaceId: FIXTURE_SPACE_ID,
  } as unknown as Run
  docStore.upsertRun(name, run)
}

function recap(): RecapEntry[] {
  return [
    { id: 'u1', type: 'user', content: 'How do we necro a dead session?' },
    { id: 'a1', type: 'agent', content: 'Tombstone it on delete, revive by convId.', toolUses: 2 },
  ]
}

describe('DELETE /api/sessions/:name — entomb to graveyard', () => {
  it('writes a tombstone (with convId + summary) and emits managed_session.retired', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      createSession(srv.sessionsDir, { name: 'askviktor', backend: 'tmux' })
      const convId = getSession(srv.sessionsDir, 'askviktor')!.conversation.id!
      seedRun(srv.docStore, 'askviktor', recap())

      const res = await srv.fetch('/api/sessions/askviktor', { method: 'DELETE' })
      expect(res.status).toBe(200)

      const tomb = srv.docStore.getTombstone(convId) as Tombstone
      expect(tomb).toBeDefined()
      expect(tomb.sessionName).toBe('askviktor')
      expect(tomb.coversSummary).toContain('How do we necro a dead session?')
      expect(tomb.task).toBe('Graveyard design')

      const retired = srv.events.find(e => e.type === 'managed_session.retired')
      expect(retired).toBeDefined()
      expect((retired!.payload as { convId: string }).convId).toBe(convId)
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('snapshots the run\'s friendly name onto the tombstone, without touching sessionName', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      createSession(srv.sessionsDir, { name: 'vpppm-general-pourpose-2dc86', backend: 'tmux' })
      const convId = getSession(srv.sessionsDir, 'vpppm-general-pourpose-2dc86')!.conversation.id!
      seedRun(srv.docStore, 'vpppm-general-pourpose-2dc86', recap(), 'PM Vpp project')

      const res = await srv.fetch('/api/sessions/vpppm-general-pourpose-2dc86', { method: 'DELETE' })
      expect(res.status).toBe(200)

      const tomb = srv.docStore.getTombstone(convId) as Tombstone
      expect(tomb.displayName).toBe('PM Vpp project')
      // sessionName is the revive handle (reviveName reads it) — it must stay
      // the real session name, never the display string.
      expect(tomb.sessionName).toBe('vpppm-general-pourpose-2dc86')
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves displayName absent when the run had no friendly name, so the graveyard falls back to sessionName', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      createSession(srv.sessionsDir, { name: 'unnamed', backend: 'tmux' })
      const convId = getSession(srv.sessionsDir, 'unnamed')!.conversation.id!
      seedRun(srv.docStore, 'unnamed', recap())

      await srv.fetch('/api/sessions/unnamed', { method: 'DELETE' })

      const tomb = srv.docStore.getTombstone(convId) as Tombstone
      expect(tomb.displayName).toBeUndefined()
      expect(tomb.sessionName).toBe('unnamed')
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('carries background: true onto the tombstone when deleting a background session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      createSession(srv.sessionsDir, { name: 'machinery', backend: 'tmux', background: true })
      const convId = getSession(srv.sessionsDir, 'machinery')!.conversation.id!
      // Run seeded without the field — the handler falls back to the session record.
      seedRun(srv.docStore, 'machinery', recap())

      const res = await srv.fetch('/api/sessions/machinery', { method: 'DELETE' })
      expect(res.status).toBe(200)

      const tomb = srv.docStore.getTombstone(convId) as Tombstone
      expect(tomb).toBeDefined()
      expect(tomb.background).toBe(true)
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes background: false on the tombstone for an ordinary (visible) session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      createSession(srv.sessionsDir, { name: 'plain', backend: 'tmux' })
      const convId = getSession(srv.sessionsDir, 'plain')!.conversation.id!
      seedRun(srv.docStore, 'plain', recap())

      const res = await srv.fetch('/api/sessions/plain', { method: 'DELETE' })
      expect(res.status).toBe(200)

      expect((srv.docStore.getTombstone(convId) as Tombstone).background).toBe(false)
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not tombstone a session with no convId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      // No session dir created → getSession returns null → no convId → nothing to necro.
      const res = await srv.fetch('/api/sessions/ghost', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(srv.docStore.getAllTombstones()).toHaveLength(0)
      expect(srv.events.some(e => e.type === 'managed_session.retired')).toBe(false)
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function makeTomb(convId: string, summary: string): Tombstone {
  return { convId, sessionName: convId, coversSummary: summary, retiredAt: `2026-07-01T00:00:0${convId.length % 10}Z` }
}

describe('GET/POST /api/graveyard', () => {
  it('search filters tombstones by query (case-insensitive)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      srv.docStore.upsertTombstone(makeTomb('c1', 'Redis caching layer'))
      srv.docStore.upsertTombstone(makeTomb('c2', 'Graveyard necro design'))
      srv.docStore.upsertTombstone(makeTomb('c3', 'auth refactor'))

      const res = await srv.fetch('/api/graveyard?q=NECRO')
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; data: Tombstone[] }
      expect(body.ok).toBe(true)
      expect(body.data.map(t => t.convId)).toEqual(['c2'])
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('search with no query returns all tombstones, newest first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      srv.docStore.upsertTombstone({ convId: 'old', sessionName: 'old', coversSummary: 'x', retiredAt: '2026-06-01T00:00:00Z' })
      srv.docStore.upsertTombstone({ convId: 'new', sessionName: 'new', coversSummary: 'y', retiredAt: '2026-06-30T00:00:00Z' })

      const res = await srv.fetch('/api/graveyard')
      const body = await res.json() as { data: Tombstone[] }
      expect(body.data.map(t => t.convId)).toEqual(['new', 'old'])
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('purge removes a tombstone AND its durable snapshot (AE3, R5)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      srv.docStore.upsertTombstone(makeTomb('doomed', 'to be forgotten'))
      // Seed a snapshot file the way retire-time would.
      const snap = graveyardSnapshotPath(root, 'doomed')
      mkdirSync(dirname(snap), { recursive: true })
      writeFileSync(snap, '{"turn":1}\n')
      expect(existsSync(snap)).toBe(true)

      const res = await srv.fetch('/api/graveyard/doomed/purge', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(srv.docStore.getTombstone('doomed')).toBeUndefined()
      expect(existsSync(snap)).toBe(false) // snapshot forgotten too
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a traversal/non-token convId before any lookup (BAD_REQUEST)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      // %2F decodes to '/', %2E to '.' — a '../..' style convId must be refused.
      const res = await srv.fetch('/api/graveyard/..%2F..%2Fetc/purge', { method: 'POST' })
      expect(res.status).toBe(400)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(false)
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('revive on an unknown convId returns NOT_FOUND', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      const res = await srv.fetch('/api/graveyard/nope/revive', { method: 'POST' })
      expect(res.status).toBe(404)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(false)
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('revive reports not-revivable when the transcript is gone (AE2, no tmux)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      // A convId with no Claude Code transcript on disk → best-effort revive refuses.
      srv.docStore.upsertTombstone(makeTomb('conv-no-transcript-xyz', 'stale ghost'))
      const res = await srv.fetch('/api/graveyard/conv-no-transcript-xyz/revive', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json() as { data: { revivable: boolean; reason?: string } }
      expect(body.data.revivable).toBe(false)
      expect(body.data.reason).toBe('transcript-unavailable')
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('graveyard — project + worktree', () => {
  it('records the resolved project on the tombstone at retire-time', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      createSession(srv.sessionsDir, { name: 'projecty', backend: 'tmux' })
      const convId = getSession(srv.sessionsDir, 'projecty')!.conversation.id!
      seedRun(srv.docStore, 'projecty', recap())
      // seedRun parents the run under task-1; the project is inherited from it.
      srv.docStore.upsertTask('task-1', {
        id: 'task-1', name: 'Graveyard design', epicId: '', initiativeId: '',
        status: 'active', settings: { project: 'tinstar' },
      })

      await srv.fetch('/api/sessions/projecty', { method: 'DELETE' })

      expect((srv.docStore.getTombstone(convId) as Tombstone).project).toBe('tinstar')
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves project absent when no task settings resolve one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      createSession(srv.sessionsDir, { name: 'projectless', backend: 'tmux' })
      const convId = getSession(srv.sessionsDir, 'projectless')!.conversation.id!
      seedRun(srv.docStore, 'projectless', recap())

      await srv.fetch('/api/sessions/projectless', { method: 'DELETE' })

      // Absent, not '' — the widget distinguishes unknown from a real project.
      expect((srv.docStore.getTombstone(convId) as Tombstone).project).toBeUndefined()
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['project', 'tinstar'],
    ['workspace path', 'fix-run-title'],
  ])('search matches on %s', async (_label, q) => {
    const root = mkdtempSync(join(tmpdir(), 'gy-route-'))
    const srv = createTestServer(root)
    try {
      srv.docStore.upsertTombstone({
        convId: 'c-hit', sessionName: 'hit', coversSummary: 'unrelated summary',
        project: 'tinstar', workspacePath: '/home/ubuntu/wt/fix-run-title',
        retiredAt: '2026-07-01T12:00:00Z',
      })
      srv.docStore.upsertTombstone({
        convId: 'c-miss', sessionName: 'miss', coversSummary: 'unrelated summary',
        project: 'cmsandbox', workspacePath: '/home/ubuntu/repo/cmsandbox',
        retiredAt: '2026-07-01T12:00:00Z',
      })

      const res = await srv.fetch(`/api/graveyard?q=${encodeURIComponent(q)}`)
      const body = await res.json() as { data: Tombstone[] }

      expect(body.data.map(t => t.convId)).toEqual(['c-hit'])
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
