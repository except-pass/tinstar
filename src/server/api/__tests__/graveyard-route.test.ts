import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import { createSession, getSession } from '../../sessions/session'
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

function seedRun(docStore: DocumentStore, name: string, recap: RecapEntry[]): void {
  const run: Run = {
    id: name, status: 'stopped', sessionId: name,
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
