import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../sessions', async (importActual) => {
  const actual = await importActual<typeof import('../../sessions')>()
  return {
    ...actual,
    tmuxBackend: {
      ...actual.tmuxBackend,
      findPort: vi.fn(async () => 6123),
      createTmuxSession: vi.fn(async () => ({ port: 6123, ttydPid: 4242 })),
      onTtydRestart: vi.fn(),
    },
  }
})

import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import type { Run } from '../../../domain/types'
import { slotsForNode, nodesInSlot, snapNeighbors, emptyGraph, addMember } from '../../../domain/constellationGraph'

const SPACE_ID = 'space-1'
const SESSION_ID = 'sess-1'

function makeCtx(root: string): RouteContext {
  const cfg = {
    sessions: { prefix: 'tinstar' },
    cliTemplates: [], editor: 'vim',
    ports: { ttyd: 7681, hostStart: 5273 },
    dirs: { root, secrets: join(root, 'secrets'), sessions: join(root, 'sessions') },
    files: { config: join(root, 'config.json'), projects: join(root, 'projects.json') },
    git: { taskMarkerRegex: '#([A-Za-z0-9_-]+)', reconciliationRepos: [], reconciliationBranchScope: 'local' },
    nats: { channelServerPackage: '', bunPath: '', jetstream: false },
    uploadMaxBytes: 100 * 1024 * 1024,
    ui: { promptComposerDefault: false, showEmptyEntities: true, layouts: {}, telemetryPanels: { cost: true, tokens: true, cacheHit: false, duty: true, turnLength: true } },
  }
  const docStore = new DocumentStore()
  docStore.upsertSpace(SPACE_ID, { id: SPACE_ID, name: 'Test Space', createdAt: new Date().toISOString() })
  docStore.activeSpaceId = SPACE_ID

  const run: Run = {
    id: 'run-R1', status: 'idle', background: false, blocked: false, sessionId: SESSION_ID, taskId: 'task-1',
    initiative: 'init', epic: 'epic', task: 'task', repo: 'repo', worktree: 'wt',
    touchedFiles: [], recapEntries: [], rawLogs: '', port: null, backend: null,
    worktreeId: 'wt-1', createdAt: new Date().toISOString(), spaceId: SPACE_ID, color: '#abc',
  }
  docStore.upsertRun(run.id, run)

  return {
    sessionConfig: cfg, docStore,
    bus: { emit: vi.fn() },
    readyQueue: { onStatusChange: vi.fn(), getQueue: () => [] },
    sse: { setReadyQueue: vi.fn(), broadcastReadyQueueUpdate: vi.fn(), addClient: vi.fn() },
    natsTraffic: undefined,
    natsHealth: undefined,
  } as unknown as RouteContext
}

interface TestCtx {
  docStore: DocumentStore
  tmpRoot: string
  fetch(path: string, init?: RequestInit): Promise<Response>
  close(): Promise<void>
}

function createTestServer(): TestCtx {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-snap-test-'))
  const ctx = makeCtx(tmpRoot)
  const server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end() } })
  })
  let port: number
  const ready = new Promise<void>(r => server.listen(0, () => { port = (server.address() as AddressInfo).port; r() }))
  return {
    docStore: ctx.docStore,
    tmpRoot,
    async fetch(path, init) {
      await ready
      const headers = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) }
      return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers })
    },
    close() { return new Promise(r => server.close(() => r())) },
  }
}

let t: TestCtx
beforeEach(() => { t = createTestServer() })
afterEach(async () => { await t.close(); rmSync(t.tmpRoot, { recursive: true, force: true }) })

function writeHtml(root: string, name: string, html: string): string {
  const p = join(root, name)
  writeFileSync(p, html)
  return p
}

// The seeded run has id: 'run-R1', so the canvas node id is `run-${run.id}` = 'run-run-R1'
const SESSION_NODE_ID = 'run-run-R1'

describe('spawned widget snaps to session', () => {
  it('artifact spawned with sessionId joins a new constellation slot with the session node and adds a snap edge', async () => {
    const p = writeHtml(t.tmpRoot, 's.html', '<body>s</body>')
    const created = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p, sessionId: SESSION_ID }) })).json()).data
    const graph = t.docStore.getConstellationGraph(SPACE_ID)!
    expect(graph).toBeDefined()
    const widgetSlots = slotsForNode(graph, created.widgetId)
    expect(widgetSlots.length).toBe(1)
    // session node is in the SAME slot (new group formed)
    expect(slotsForNode(graph, SESSION_NODE_ID)).toEqual(widgetSlots)
    // snap edge couples them
    expect(snapNeighbors(graph, created.widgetId)).toContain(SESSION_NODE_ID)
  })

  it('a second artifact for the same session joins the SAME slot (rafts together)', async () => {
    const p = writeHtml(t.tmpRoot, 's2.html', '<body>s2</body>')
    const a = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p, sessionId: SESSION_ID }) })).json()).data
    const b = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p, sessionId: SESSION_ID }) })).json()).data
    const graph = t.docStore.getConstellationGraph(SPACE_ID)!
    const slotA = slotsForNode(graph, a.widgetId)[0]
    const slotB = slotsForNode(graph, b.widgetId)[0]
    expect(slotA).toBeDefined()
    expect(slotB).toBe(slotA)
    expect(nodesInSlot(graph, slotA!)).toEqual(expect.arrayContaining([a.widgetId, b.widgetId, SESSION_NODE_ID]))
  })

  it('snapToSession:false opts out — no constellation membership', async () => {
    const p = writeHtml(t.tmpRoot, 's3.html', '<body>s3</body>')
    const created = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p, sessionId: SESSION_ID, snapToSession: false }) })).json()).data
    const graph = t.docStore.getConstellationGraph(SPACE_ID)
    // either no graph yet, or the widget is not a member
    if (graph) expect(slotsForNode(graph, created.widgetId).length).toBe(0)
  })

  it('an explicit slot still wins (no auto-snap to a derived slot)', async () => {
    const p = writeHtml(t.tmpRoot, 's4.html', '<body>s4</body>')
    const created = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p, sessionId: SESSION_ID, slot: 5 }) })).json()).data
    const graph = t.docStore.getConstellationGraph(SPACE_ID)!
    expect(slotsForNode(graph, created.widgetId)).toEqual(['5'])
  })

  it('no sessionId → no snap', async () => {
    const p = writeHtml(t.tmpRoot, 's5.html', '<body>s5</body>')
    const created = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p }) })).json()).data
    const graph = t.docStore.getConstellationGraph(SPACE_ID)
    if (graph) expect(slotsForNode(graph, created.widgetId).length).toBe(0)
  })

  it('all 9 slots full → no membership and no dangling snap edge', async () => {
    // Fill every slot with a placeholder so no free slot remains, and leave the
    // session node unslotted (forces the new-group branch).
    let g = emptyGraph(SPACE_ID)
    for (const s of ['1','2','3','4','5','6','7','8','9'] as const) g = addMember(g, `filler-${s}`, s)
    t.docStore.upsertConstellationGraph(SPACE_ID, g)

    const p = writeHtml(t.tmpRoot, 'full.html', '<body>full</body>')
    const created = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p, sessionId: SESSION_ID }) })).json()).data
    const graph = t.docStore.getConstellationGraph(SPACE_ID)!
    expect(slotsForNode(graph, created.widgetId).length).toBe(0)
    expect(snapNeighbors(graph, created.widgetId)).not.toContain('run-run-R1')
  })

  // Seed the on-disk layouts that lookupNodeLayout reads (loadConfigMerged → <root>/config.json).
  function writeLayouts(entries: Record<string, { x: number; y: number; width: number; height: number }>) {
    writeFileSync(join(t.tmpRoot, 'config.json'),
      JSON.stringify({ ui: { layouts: { [`tinstar-layouts-v3-${SPACE_ID}`]: entries } } }))
  }

  it('tiles after the actual right edge of a resized neighbor (not a uniform-width offset)', async () => {
    // Session occupies x:0..1000. First spawn tiles right after it.
    writeLayouts({ [SESSION_NODE_ID]: { x: 0, y: 0, width: 1000, height: 600 } })
    const a = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: writeHtml(t.tmpRoot, 't1.html', '<body>1</body>'), sessionId: SESSION_ID }) })).json()).data
    const wa = t.docStore.getAllBrowserWidgets().find(w => w.id === a.widgetId)!
    expect(wa.position!.x).toBe(1020) // 1000 + PLACEMENT_GAP(20)

    // Simulate the user resizing the first widget much wider (x:1020, width:2000 → right 3020).
    writeLayouts({
      [SESSION_NODE_ID]: { x: 0, y: 0, width: 1000, height: 600 },
      [a.widgetId]: { x: 1020, y: 0, width: 2000, height: 600 },
    })
    const b = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: writeHtml(t.tmpRoot, 't2.html', '<body>2</body>'), sessionId: SESSION_ID }) })).json()).data
    const wb = t.docStore.getAllBrowserWidgets().find(w => w.id === b.widgetId)!
    // Must tile after the resized neighbor's real right edge (3020 + gap), NOT the old
    // uniform offset (1020 + 800 + 20 = 1840) which would overlap the widened widget.
    expect(wb.position!.x).toBe(3040)
  })

  it('an explicit but OUT-OF-RANGE slot opts out of auto-snap (no membership)', async () => {
    const p = writeHtml(t.tmpRoot, 'badslot.html', '<body>x</body>')
    const created = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p, sessionId: SESSION_ID, slot: 99 }) })).json()).data
    const graph = t.docStore.getConstellationGraph(SPACE_ID)
    // Invalid slot is not assigned, but providing it still suppresses auto-snap —
    // the widget joins no slot at all (old behavior auto-snapped to the session).
    if (graph) {
      expect(slotsForNode(graph, created.widgetId).length).toBe(0)
      expect(snapNeighbors(graph, created.widgetId)).not.toContain(SESSION_NODE_ID)
    }
  })
})
