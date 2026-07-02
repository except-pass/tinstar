import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import { createSession, getSession } from '../../sessions/session'
import type { Run } from '../../../domain/types'

const FIXTURE_SPACE_ID = 'spc-test-fixture'

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
  docStore.upsertSpace(FIXTURE_SPACE_ID, {
    id: FIXTURE_SPACE_ID,
    name: 'Test Space',
    createdAt: new Date().toISOString(),
  })
  return { sessionConfig: cfg, docStore } as unknown as RouteContext
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
      if (!handled) {
        res.statusCode = 404
        res.end()
      }
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

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r1',
    status: 'idle',
    background: false,
    blocked: false,
    sessionId: 's1',
    initiative: 'i',
    epic: 'e',
    task: 't',
    repo: 'repo',
    worktree: 'wt',
    taskId: 't',
    worktreeId: 'wt',
    createdAt: '2026-05-22T00:00:00Z',
    recapEntries: [],
    touchedFiles: [],
    rawLogs: '',
    port: null,
    backend: 'tmux',
    spaceId: FIXTURE_SPACE_ID,
    attention: { level: 'attention', reason: 'Ready for input', setAt: '2026-05-28T00:00:00Z' },
    ...overrides,
  }
}

let tmpRoot: string
let testCtx: TestCtx

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-runs-route-test-'))
  testCtx = createTestServer(tmpRoot)
})

afterEach(async () => {
  await testCtx.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('PATCH /api/runs/:id', () => {
  it('clears existing run attention', async () => {
    testCtx.docStore.upsertRun('r1', makeRun())

    const res = await testCtx.fetch('/api/runs/r1', {
      method: 'PATCH',
      body: JSON.stringify({ attention: null }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: Run }
    expect(body.ok).toBe(true)
    expect(body.data.attention).toBeUndefined()
    expect(testCtx.docStore.getRun('r1')?.attention).toBeUndefined()
  })

  it('reparents a run to another task', async () => {
    testCtx.docStore.upsertRun('r1', makeRun())

    const res = await testCtx.fetch('/api/runs/r1', {
      method: 'PATCH',
      body: JSON.stringify({ taskId: 't2' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: Run }
    expect(body.ok).toBe(true)
    expect(body.data.taskId).toBe('t2')
    expect(testCtx.docStore.getRun('r1')?.taskId).toBe('t2')
  })

  describe('background flips', () => {
    it('AE5: demoting an idle run clears its "Ready for input" attention', async () => {
      // Visible idle run with the standard "Ready for input" attention row.
      createSession(join(tmpRoot, 'sessions'), { name: 's1', backend: 'tmux' })
      testCtx.docStore.upsertRun('r1', makeRun())

      const res = await testCtx.fetch('/api/runs/r1', {
        method: 'PATCH',
        body: JSON.stringify({ background: true }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; data: Run }
      expect(body.ok).toBe(true)
      expect(body.data.background).toBe(true)
      // No lingering inbox row: attention re-derived to null in the same mutation.
      expect(body.data.attention).toBeUndefined()
      expect(testCtx.docStore.getRun('r1')?.attention).toBeUndefined()
      // The flip is persisted to session.json so it survives restarts.
      expect(getSession(join(tmpRoot, 'sessions'), 's1')?.background).toBe(true)
    })

    it('demoting a blocked run re-derives urgent "Waiting on permission"', async () => {
      // Session persisted as blocked (pending permission prompt), mirrored on the run.
      createSession(join(tmpRoot, 'sessions'), { name: 's1', backend: 'tmux', blocked: true })
      testCtx.docStore.upsertRun('r1', makeRun({ blocked: true }))

      const res = await testCtx.fetch('/api/runs/r1', {
        method: 'PATCH',
        body: JSON.stringify({ background: true }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; data: Run }
      expect(body.data.background).toBe(true)
      expect(body.data.attention?.level).toBe('urgent')
      expect(body.data.attention?.reason).toBe('Waiting on permission')
    })

    it('promoting an idle background run restores "Ready for input"', async () => {
      createSession(join(tmpRoot, 'sessions'), { name: 's1', backend: 'tmux', background: true })
      testCtx.docStore.upsertRun('r1', makeRun({ background: true, attention: undefined }))

      const res = await testCtx.fetch('/api/runs/r1', {
        method: 'PATCH',
        body: JSON.stringify({ background: false }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; data: Run }
      expect(body.data.background).toBe(false)
      expect(body.data.attention?.level).toBe('attention')
      expect(body.data.attention?.reason).toBe('Ready for input')
      expect(getSession(join(tmpRoot, 'sessions'), 's1')?.background).toBe(false)
    })

    it('rejects a non-boolean background with a 400 envelope', async () => {
      testCtx.docStore.upsertRun('r1', makeRun())

      const res = await testCtx.fetch('/api/runs/r1', {
        method: 'PATCH',
        body: JSON.stringify({ background: 'yes' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json() as { ok: boolean; error: { code: string } }
      expect(body.ok).toBe(false)
      expect(body.error.code).toBe('BAD_REQUEST')
      // Nothing mutated.
      expect(testCtx.docStore.getRun('r1')?.background).toBe(false)
      expect(testCtx.docStore.getRun('r1')?.attention?.reason).toBe('Ready for input')
    })

    it('flips background on a run with no session.json and emits a change event', async () => {
      // Docstore-only run (simulator/plugin): no backing session record —
      // updateSession returning null is expected and tolerated.
      testCtx.docStore.upsertRun('r1', makeRun())
      expect(getSession(join(tmpRoot, 'sessions'), 's1')).toBeNull()

      const events: Array<{ entity: string; id: string }> = []
      testCtx.docStore.changes.on('change', (e: { entity: string; id: string }) => events.push(e))

      const res = await testCtx.fetch('/api/runs/r1', {
        method: 'PATCH',
        body: JSON.stringify({ background: true }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; data: Run }
      expect(body.ok).toBe(true)
      expect(body.data.background).toBe(true)
      expect(body.data.attention).toBeUndefined()
      expect(testCtx.docStore.getRun('r1')?.background).toBe(true)
      expect(events.some(e => e.entity === 'run' && e.id === 'r1')).toBe(true)
    })

    it('composes with a taskId patch in the same body', async () => {
      createSession(join(tmpRoot, 'sessions'), { name: 's1', backend: 'tmux' })
      testCtx.docStore.upsertRun('r1', makeRun())

      const res = await testCtx.fetch('/api/runs/r1', {
        method: 'PATCH',
        body: JSON.stringify({ taskId: 't2', background: true }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; data: Run }
      expect(body.data.taskId).toBe('t2')
      expect(body.data.background).toBe(true)
      expect(body.data.attention).toBeUndefined()
      expect(getSession(join(tmpRoot, 'sessions'), 's1')?.background).toBe(true)
    })
  })
})
