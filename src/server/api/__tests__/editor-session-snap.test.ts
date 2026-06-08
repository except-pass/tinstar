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
    id: 'run-R1', status: 'idle', sessionId: SESSION_ID, taskId: 'task-1',
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

function writeSource(root: string, name: string, content: string): string {
  const p = join(root, name)
  writeFileSync(p, content)
  return p
}

// The seeded run has id: 'run-R1', so the canvas node id is `run-${run.id}` = 'run-run-R1'
const SESSION_NODE_ID = 'run-run-R1'

describe('file-editor snaps to session on create', () => {
  it('editor spawned with sessionId joins a new constellation slot with the session node and adds a snap edge', async () => {
    const p = writeSource(t.tmpRoot, 'a.ts', 'export const a = 1')
    const editor = (await (await t.fetch('/api/editor-widgets', { method: 'POST', body: JSON.stringify({ sessionId: SESSION_ID, filePath: p }) })).json()).data
    const graph = t.docStore.getConstellationGraph(SPACE_ID)!
    expect(graph).toBeDefined()
    // EditorWidget returns the widget directly via ok(res, widget) — it has `id`, not `widgetId`.
    const editorSlots = slotsForNode(graph, editor.id)
    expect(editorSlots.length).toBe(1)
    // session node is in the SAME slot (new group formed)
    expect(slotsForNode(graph, SESSION_NODE_ID)).toEqual(editorSlots)
    // snap edge couples them
    expect(snapNeighbors(graph, editor.id)).toContain(SESSION_NODE_ID)
  })

  it('a second editor for the same session rafts into the SAME slot', async () => {
    const pa = writeSource(t.tmpRoot, 'b1.ts', 'export const b1 = 1')
    const pb = writeSource(t.tmpRoot, 'b2.ts', 'export const b2 = 2')
    const a = (await (await t.fetch('/api/editor-widgets', { method: 'POST', body: JSON.stringify({ sessionId: SESSION_ID, filePath: pa }) })).json()).data
    const b = (await (await t.fetch('/api/editor-widgets', { method: 'POST', body: JSON.stringify({ sessionId: SESSION_ID, filePath: pb }) })).json()).data
    const graph = t.docStore.getConstellationGraph(SPACE_ID)!
    const slotA = slotsForNode(graph, a.id)[0]
    const slotB = slotsForNode(graph, b.id)[0]
    expect(slotA).toBeDefined()
    expect(slotB).toBe(slotA)
    expect(nodesInSlot(graph, slotA!)).toEqual(expect.arrayContaining([a.id, b.id, SESSION_NODE_ID]))
  })

  // NOTE: there is no "no sessionId → no snap" case here. The editor endpoint makes
  // sessionId (and filePath) MANDATORY — it FAILS with INVALID_PARAMS when either is
  // missing (unlike the browser path, where a missing session means a standalone widget).
  // So the browser test's "no session → no membership" path is not reachable for editors.
  // Instead we cover the "session slots full → widget created, no membership" branch below.

  it('all 9 slots full → editor still created, no membership and no dangling snap edge', async () => {
    // Fill every slot so no free slot remains, and leave the session node unslotted
    // (forces the new-group branch, which finds no free slot).
    let g = emptyGraph(SPACE_ID)
    for (const s of ['1','2','3','4','5','6','7','8','9'] as const) g = addMember(g, `filler-${s}`, s)
    t.docStore.upsertConstellationGraph(SPACE_ID, g)

    const p = writeSource(t.tmpRoot, 'full.ts', 'export const full = 1')
    const res = await t.fetch('/api/editor-widgets', { method: 'POST', body: JSON.stringify({ sessionId: SESSION_ID, filePath: p }) })
    expect(res.status).toBe(200)
    const editor = (await res.json()).data
    expect(editor.id).toBeDefined()
    const graph = t.docStore.getConstellationGraph(SPACE_ID)!
    expect(slotsForNode(graph, editor.id).length).toBe(0)
    expect(snapNeighbors(graph, editor.id)).not.toContain(SESSION_NODE_ID)
  })

  // Seed the on-disk layouts that lookupNodeLayout reads (loadConfigMerged → <root>/config.json).
  function writeLayouts(entries: Record<string, { x: number; y: number; width: number; height: number }>) {
    writeFileSync(join(t.tmpRoot, 'config.json'),
      JSON.stringify({ ui: { layouts: { [`tinstar-layouts-v3-${SPACE_ID}`]: entries } } }))
  }

  it('seeds a tiled position after the session right edge (full browser parity)', async () => {
    // Session occupies x:0..1000. The editor tiles right after it.
    writeLayouts({ [SESSION_NODE_ID]: { x: 0, y: 0, width: 1000, height: 600 } })
    const p = writeSource(t.tmpRoot, 'tiled.ts', 'export const tiled = 1')
    const editor = (await (await t.fetch('/api/editor-widgets', { method: 'POST', body: JSON.stringify({ sessionId: SESSION_ID, filePath: p }) })).json()).data
    const widget = t.docStore.getAllEditorWidgets().find(w => w.id === editor.id)!
    expect(widget.position!.x).toBe(1020) // 1000 + PLACEMENT_GAP(20)
    expect(widget.position!.y).toBe(0)
    expect(widget.size).toEqual({ width: 640, height: 480 })
    // Membership still holds — same slot as the session node.
    const graph = t.docStore.getConstellationGraph(SPACE_ID)!
    const editorSlots = slotsForNode(graph, editor.id)
    expect(editorSlots.length).toBe(1)
    expect(slotsForNode(graph, SESSION_NODE_ID)).toEqual(editorSlots)
  })
})
