// @vitest-environment node
//
// The canonical Surface store (U1): global identity, one home per Surface, derived
// parent indexes, and revision-gated mutation.
//
// The named U1 scenarios this file owns:
//   · a byte-identical canonical upsert emits no change;
//   · a canonical snapshot reload reconstructs parent indexes and topology
//     revision exactly (the PURE rebuild-from-records path — disk is a later unit);
//   · two runs using the same local Surface slug receive different global ids;
//   · cycle and cross-space parentage rejection on group/reparent.
// Plus happy-path, edge (empty store, single node, deep chain), and error-path
// (unknown id, stale revision) coverage.
import { describe, it, expect, vi } from 'vitest'
import {
  SurfaceStore,
  buildTopologyIndex,
  deriveLegacySurfaceId,
  deriveRunIncarnation,
  homeKey,
  newSurfaceId,
  type SurfaceBatch,
  type SurfaceInit,
} from '../surfaces'
import type { Surface, SurfaceHome } from '../../../domain/types'

const SPACE = 'space-1'
const CANVAS: SurfaceHome = { kind: 'canvas', spaceId: SPACE }

function body(text: string) {
  return { root: 'r', components: [{ component: 'Text', id: 'r', text }] }
}

function init(headline: string, over: Partial<SurfaceInit> = {}): SurfaceInit {
  return { spaceId: SPACE, home: CANVAS, content: { headline, body: body(headline) }, ...over }
}

/** Collect emitted batches so emit-count and atomicity are assertable. */
function makeStore(): { store: SurfaceStore; emit: ReturnType<typeof vi.fn>; batches: SurfaceBatch[] } {
  const batches: SurfaceBatch[] = []
  const emit = vi.fn((b: SurfaceBatch) => { batches.push(b) })
  return { store: new SurfaceStore(emit), emit, batches }
}

/** Create and return the record, failing loudly if the mutation was rejected —
 *  test setup should never silently proceed against an empty store. */
function create(store: SurfaceStore, i: SurfaceInit, at?: number): Surface {
  const res = store.createSurface(i, at != null ? { at } : {})
  if (!res.applied) throw new Error(`create rejected: ${res.reason}`)
  return res.surfaces[0]!
}

describe('identity derivation', () => {
  it('mints a distinct global id every time', () => {
    const ids = new Set([newSurfaceId(), newSurfaceId(), newSurfaceId()])
    expect(ids.size).toBe(3)
    for (const id of ids) expect(id.startsWith('sf-')).toBe(true)
  })

  it('derives a run incarnation deterministically', () => {
    const a = deriveRunIncarnation('CLD-run-1', '2026-07-13T00:00:00.000Z')
    const b = deriveRunIncarnation('CLD-run-1', '2026-07-13T00:00:00.000Z')
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it('refuses (rather than guesses) an incarnation with a missing input', () => {
    expect(deriveRunIncarnation('', '2026-07-13T00:00:00.000Z')).toBeNull()
    expect(deriveRunIncarnation('CLD-run-1', undefined)).toBeNull()
  })

  // NAMED U1 SCENARIO. Agents reuse slugs (`decisions`, `blockers`, `objective`)
  // across runs; without the incarnation in the basis those would collide into one
  // global record and two unrelated runs would share a thread.
  it('gives two runs the same local slug DIFFERENT global ids', () => {
    const one = deriveRunIncarnation('CLD-run-1', '2026-07-13T00:00:00.000Z')!
    const two = deriveRunIncarnation('CLD-run-2', '2026-07-13T00:00:00.000Z')!
    expect(deriveLegacySurfaceId(one, 'blockers')).not.toBe(deriveLegacySurfaceId(two, 'blockers'))
  })

  // The reason `createdAt` is in the incarnation basis at all: a run id is a tmux
  // session name and a user may delete and recreate it.
  it('does not reuse an identity when a run name is deleted and recreated', () => {
    const first = deriveRunIncarnation('CLD-run-1', '2026-07-13T00:00:00.000Z')!
    const reborn = deriveRunIncarnation('CLD-run-1', '2026-07-20T09:15:00.000Z')!
    expect(first).not.toBe(reborn)
    expect(deriveLegacySurfaceId(first, 'objective')).not.toBe(deriveLegacySurfaceId(reborn, 'objective'))
  })

  it('is stable for the same incarnation + local id', () => {
    const inc = deriveRunIncarnation('CLD-run-1', '2026-07-13T00:00:00.000Z')!
    expect(deriveLegacySurfaceId(inc, 'x')).toBe(deriveLegacySurfaceId(inc, 'x'))
    expect(deriveLegacySurfaceId(inc, 'x')).not.toBe(deriveLegacySurfaceId(inc, 'y'))
  })

  it('keeps the two home kinds from colliding on a shared id string', () => {
    expect(homeKey({ kind: 'canvas', spaceId: 'a' })).not.toBe(homeKey({ kind: 'surface', surfaceId: 'a' }))
  })
})

describe('createSurface', () => {
  it('mints a record with host-assigned identity, revisions, and derived defaults', () => {
    const { store, batches } = makeStore()
    const s = create(store, init('hello'), 1000)
    expect(s.id.startsWith('sf-')).toBe(true)
    expect(s.rev).toBe(1)
    expect(s.homeRev).toBe(1)
    expect(s.createdAt).toBe(1000)
    expect(s.thread).toEqual({ replies: [], status: 'open' })
    expect(s.freshness).toEqual({ phase: 'current', overdue: false })
    // No source binding ⇒ the record itself is authoritative; the alternative
    // would hand authority to a source that does not exist.
    expect(s.contentAuthority).toBe('canonical-direct')
    expect(store.getRoots(SPACE)).toEqual([s])
    expect(batches).toHaveLength(1)
    expect(batches[0]!.topologyRev).toBe(1)
  })

  it('defaults to source-binding authority when a source is supplied', () => {
    const { store } = makeStore()
    const s = create(store, init('bound', {
      source: { adapter: 'slate-file', locator: '.tinstar/slate/a.json', generation: 3 },
    }))
    expect(s.contentAuthority).toBe('source-binding')
    expect(s.source?.generation).toBe(3)
  })

  it('derives thread status from a seeded thread rather than trusting the caller', () => {
    const { store } = makeStore()
    const s = create(store, init('q', {
      thread: { replies: [{ id: 'r1', author: 'user', text: 'what about x?', createdAt: 5 }] },
    }))
    // Last reply by the user ⇒ the agent owes an answer.
    expect(s.thread.status).toBe('waiting')
  })

  it('accepts a caller-supplied id so migration can install a derived identity', () => {
    const { store } = makeStore()
    const s = create(store, init('legacy', { id: 'sf-lg-fixed' }))
    expect(s.id).toBe('sf-lg-fixed')
  })

  it('refuses to reuse an existing id — identity is non-reusable', () => {
    const { store, batches } = makeStore()
    create(store, init('a', { id: 'sf-dup' }))
    const res = store.createSurface(init('b', { id: 'sf-dup' }))
    expect(res).toEqual({ applied: false, reason: 'duplicate-id', topologyRev: 1 })
    expect(batches).toHaveLength(1)
  })

  it('rejects a canvas home in another space', () => {
    const { store } = makeStore()
    const res = store.createSurface(init('x', { home: { kind: 'canvas', spaceId: 'other-space' } }))
    expect(res).toEqual({ applied: false, reason: 'cross-space', topologyRev: 0 })
  })

  it('rejects a home naming a Surface that does not exist', () => {
    const { store } = makeStore()
    const res = store.createSurface(init('x', { home: { kind: 'surface', surfaceId: 'sf-ghost' } }))
    expect(res).toEqual({ applied: false, reason: 'unknown-home', topologyRev: 0 })
  })

  it('bumps the space topology revision once per create', () => {
    const { store } = makeStore()
    create(store, init('a'))
    create(store, init('b'))
    expect(store.getTopologyRev(SPACE)).toBe(2)
  })

  it('honours an expected topology revision', () => {
    const { store } = makeStore()
    create(store, init('a'))
    const stale = store.createSurface(init('b'), { expectedTopologyRev: 0 })
    expect(stale).toEqual({ applied: false, reason: 'stale-topology-revision', topologyRev: 1 })
    const ok = store.createSurface(init('b'), { expectedTopologyRev: 1 })
    expect(ok.applied).toBe(true)
  })
})

describe('upsertSurface — revision gate and equality short-circuit', () => {
  // NAMED U1 SCENARIO. The file-watch storm guard: re-writing the same content
  // must not wake every SSE subscriber.
  it('emits NO change for a byte-identical upsert', () => {
    const { store, batches } = makeStore()
    const s = create(store, init('same'))
    batches.length = 0
    expect(store.upsertSurface({ ...s })).toBe(false)
    // Even with a dutifully bumped revision and fresh amendedAt, nothing a client
    // renders has changed, so nothing is emitted.
    expect(store.upsertSurface({ ...s, rev: s.rev + 1, amendedAt: s.amendedAt + 5000 })).toBe(false)
    expect(batches).toHaveLength(0)
    expect(store.getSurface(s.id)!.rev).toBe(s.rev)
  })

  it('applies a real content change and emits one batch', () => {
    const { store, batches } = makeStore()
    const s = create(store, init('before'))
    batches.length = 0
    const next: Surface = { ...s, content: { ...s.content, headline: 'after' }, rev: s.rev + 1, amendedAt: 9 }
    expect(store.upsertSurface(next)).toBe(true)
    expect(store.getSurface(s.id)!.content.headline).toBe('after')
    expect(batches).toHaveLength(1)
    expect(batches[0]!.changes).toEqual([{ entity: 'surface', id: s.id, spaceId: SPACE, data: next }])
  })

  it('rejects a stale-or-equal revision', () => {
    const { store } = makeStore()
    const s = create(store, init('v1'))
    const bumped: Surface = { ...s, content: { headline: 'v2' }, rev: 2 }
    expect(store.upsertSurface(bumped)).toBe(true)
    // Equal revision: a redundant re-PUT.
    expect(store.upsertSurface({ ...bumped, content: { headline: 'v2-again' } })).toBe(false)
    // Older revision arriving after a newer one: a stale intent, not a rollback.
    expect(store.upsertSurface({ ...s, content: { headline: 'v0' }, rev: 1 })).toBe(false)
    expect(store.getSurface(s.id)!.content.headline).toBe('v2')
  })

  it('rejects an unknown id rather than creating one behind the topology checks', () => {
    const { store, batches } = makeStore()
    const s = create(store, init('a'))
    expect(store.upsertSurface({ ...s, id: 'sf-nope', rev: 99 })).toBe(false)
    expect(store.getSurface('sf-nope')).toBeUndefined()
    expect(batches).toHaveLength(1) // the create only
  })

  it('refuses to move a Surface through the content path', () => {
    const { store } = makeStore()
    const parent = create(store, init('parent'))
    const child = create(store, init('child'))
    const moved: Surface = { ...child, home: { kind: 'surface', surfaceId: parent.id }, rev: child.rev + 1 }
    expect(store.upsertSurface(moved)).toBe(false)
    expect(store.getChildren(parent.id)).toEqual([])
    // …nor reorder, re-space, or forge the topology stamp.
    expect(store.upsertSurface({ ...child, order: 42, rev: child.rev + 1 })).toBe(false)
    expect(store.upsertSurface({ ...child, spaceId: 'other', rev: child.rev + 1 })).toBe(false)
    expect(store.upsertSurface({ ...child, homeRev: 99, rev: child.rev + 1 })).toBe(false)
  })

  it('does not touch the space topology revision', () => {
    const { store } = makeStore()
    const s = create(store, init('a'))
    const before = store.getTopologyRev(SPACE)
    store.upsertSurface({ ...s, content: { headline: 'b' }, rev: s.rev + 1 })
    expect(store.getTopologyRev(SPACE)).toBe(before)
  })
})

describe('reparent / setHome', () => {
  it('moves a Surface, preserving identity, thread, and provenance', () => {
    const { store, batches } = makeStore()
    const parent = create(store, init('parent'))
    const child = create(store, init('child', {
      thread: { replies: [{ id: 'r1', author: 'agent', text: 'hi', createdAt: 1 }] },
      provenance: { runId: 'CLD-run-1', worktreeId: 'wt-1' },
    }))
    batches.length = 0

    const res = store.setHome(child.id, { kind: 'surface', surfaceId: parent.id }, { at: 77 })
    expect(res.applied).toBe(true)
    const moved = store.getSurface(child.id)!
    expect(moved.id).toBe(child.id)
    expect(moved.thread).toEqual(child.thread)
    expect(moved.provenance).toEqual(child.provenance)
    expect(moved.rev).toBe(child.rev + 1)
    expect(moved.homeRev).toBe(store.getTopologyRev(SPACE))
    expect(moved.amendedAt).toBe(77)
    expect(store.getChildren(parent.id)).toEqual([moved])
    expect(store.getRoots(SPACE)).toEqual([store.getSurface(parent.id)])
    expect(batches).toHaveLength(1)
  })

  it('moves a set atomically in one batch', () => {
    const { store, batches } = makeStore()
    const parent = create(store, init('parent'))
    const a = create(store, init('a'), 10)
    const b = create(store, init('b'), 20)
    batches.length = 0

    const res = store.reparent([a.id, b.id], { kind: 'surface', surfaceId: parent.id })
    expect(res.applied).toBe(true)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.changes.map(c => c.id)).toEqual([a.id, b.id])
    expect(store.getChildren(parent.id).map(s => s.id)).toEqual([a.id, b.id])
  })

  it('reports no-change (and emits nothing) when every target is already home', () => {
    const { store, batches } = makeStore()
    const s = create(store, init('a'))
    batches.length = 0
    expect(store.setHome(s.id, CANVAS)).toEqual({ applied: false, reason: 'no-change', topologyRev: 1 })
    expect(batches).toHaveLength(0)
  })

  it('rejects an unknown Surface id, leaving the rest of the batch untouched', () => {
    const { store, batches } = makeStore()
    const parent = create(store, init('parent'))
    const a = create(store, init('a'))
    batches.length = 0
    const res = store.reparent([a.id, 'sf-ghost'], { kind: 'surface', surfaceId: parent.id })
    expect(res.applied).toBe(false)
    expect(store.getChildren(parent.id)).toEqual([]) // validated before ANY write
    expect(batches).toHaveLength(0)
  })

  it('rejects a stale topology revision and a stale per-Surface revision', () => {
    const { store } = makeStore()
    const parent = create(store, init('parent'))
    const a = create(store, init('a'))
    const home = { kind: 'surface' as const, surfaceId: parent.id }
    expect(store.reparent([a.id], home, { expectedTopologyRev: 1 }))
      .toEqual({ applied: false, reason: 'stale-topology-revision', topologyRev: 2 })
    expect(store.reparent([a.id], home, { expectedRevs: { [a.id]: 99 } }))
      .toEqual({ applied: false, reason: 'stale-surface-revision', topologyRev: 2 })
    expect(store.reparent([a.id], home, { expectedTopologyRev: 2, expectedRevs: { [a.id]: a.rev } }).applied)
      .toBe(true)
  })

  // NAMED U1 SCENARIO — cycles.
  it('rejects homing a Surface on itself', () => {
    const { store } = makeStore()
    const s = create(store, init('a'))
    expect(store.setHome(s.id, { kind: 'surface', surfaceId: s.id }))
      .toEqual({ applied: false, reason: 'cycle', topologyRev: 1 })
  })

  it('rejects homing a Surface on its own descendant', () => {
    const { store } = makeStore()
    const gp = create(store, init('gp'))
    const p = create(store, init('p'))
    const c = create(store, init('c'))
    store.setHome(p.id, { kind: 'surface', surfaceId: gp.id })
    store.setHome(c.id, { kind: 'surface', surfaceId: p.id })
    // gp → p → c already; putting gp under c would close the loop.
    const res = store.setHome(gp.id, { kind: 'surface', surfaceId: c.id })
    expect(res.applied).toBe(false)
    expect(res).toMatchObject({ reason: 'cycle' })
    expect(store.getAncestors(c.id).map(s => s.id)).toEqual([p.id, gp.id])
  })

  it('rejects a batch whose members would enclose each other', () => {
    const { store } = makeStore()
    const a = create(store, init('a'))
    const b = create(store, init('b'))
    // Moving {a, b} under b is a cycle for b even though it is legal for a.
    expect(store.reparent([a.id, b.id], { kind: 'surface', surfaceId: b.id }))
      .toMatchObject({ applied: false, reason: 'cycle' })
    expect(store.getChildren(b.id)).toEqual([])
  })

  // NAMED U1 SCENARIO — cross-space parentage.
  it('rejects a parent in another space', () => {
    const { store } = makeStore()
    const here = create(store, init('here'))
    const there = create(store, init('there', { spaceId: 'space-2', home: { kind: 'canvas', spaceId: 'space-2' } }))
    expect(store.setHome(here.id, { kind: 'surface', surfaceId: there.id }))
      .toMatchObject({ applied: false, reason: 'cross-space' })
    expect(store.setHome(here.id, { kind: 'canvas', spaceId: 'space-2' }))
      .toMatchObject({ applied: false, reason: 'cross-space' })
    expect(store.getSurface(here.id)!.home).toEqual(CANVAS)
  })

  it('rejects a batch that spans two spaces', () => {
    const { store } = makeStore()
    const parent = create(store, init('parent'))
    const here = create(store, init('here'))
    const there = create(store, init('there', { spaceId: 'space-2', home: { kind: 'canvas', spaceId: 'space-2' } }))
    expect(store.reparent([here.id, there.id], { kind: 'surface', surfaceId: parent.id }))
      .toMatchObject({ applied: false, reason: 'cross-space' })
  })

  it('ungroups by moving children back to the canvas', () => {
    const { store } = makeStore()
    const parent = create(store, init('parent'))
    const a = create(store, init('a'))
    store.setHome(a.id, { kind: 'surface', surfaceId: parent.id })
    expect(store.getChildren(parent.id).map(s => s.id)).toEqual([a.id])
    expect(store.setHome(a.id, CANVAS).applied).toBe(true)
    expect(store.getChildren(parent.id)).toEqual([])
    expect(store.getRoots(SPACE).map(s => s.id).sort()).toEqual([a.id, parent.id].sort())
  })
})

describe('group', () => {
  it('creates one parent and moves the siblings under it in a single batch', () => {
    const { store, batches } = makeStore()
    const a = create(store, init('a'), 10)
    const b = create(store, init('b'), 20)
    batches.length = 0

    const res = store.group([a.id, b.id], { content: { headline: 'group' } }, { at: 50 })
    expect(res.applied).toBe(true)
    if (!res.applied) return
    const [parent] = res.surfaces
    expect(parent!.home).toEqual(CANVAS) // inherits the children's shared home
    // ONE batch, parent first, so no consumer sees a child pointing at a home it
    // has not been told about.
    expect(batches).toHaveLength(1)
    expect(batches[0]!.changes.map(c => c.id)).toEqual([parent!.id, a.id, b.id])
    expect(store.getChildren(parent!.id).map(s => s.id)).toEqual([a.id, b.id])
    expect(store.getRoots(SPACE).map(s => s.id)).toEqual([parent!.id])
    // Children keep their identity, content, and revision lineage.
    expect(store.getSurface(a.id)!.content).toEqual(a.content)
    expect(store.getSurface(a.id)!.rev).toBe(a.rev + 1)
  })

  it('groups nested children under a new parent inside their existing parent', () => {
    const { store } = makeStore()
    const outer = create(store, init('outer'))
    const a = create(store, init('a'), 10)
    const b = create(store, init('b'), 20)
    store.reparent([a.id, b.id], { kind: 'surface', surfaceId: outer.id })
    const res = store.group([a.id, b.id], { content: { headline: 'inner' } })
    expect(res.applied).toBe(true)
    if (!res.applied) return
    const inner = res.surfaces[0]!
    expect(inner.home).toEqual({ kind: 'surface', surfaceId: outer.id })
    expect(store.getChildren(outer.id).map(s => s.id)).toEqual([inner.id])
    expect(store.getAncestors(a.id).map(s => s.id)).toEqual([inner.id, outer.id])
  })

  it('rejects gathering Surfaces that do not share a home', () => {
    const { store, batches } = makeStore()
    const outer = create(store, init('outer'))
    const a = create(store, init('a'))
    const b = create(store, init('b'))
    store.setHome(b.id, { kind: 'surface', surfaceId: outer.id })
    batches.length = 0
    expect(store.group([a.id, b.id], { content: { headline: 'g' } }))
      .toMatchObject({ applied: false, reason: 'mixed-home' })
    expect(batches).toHaveLength(0)
  })

  it('rejects a cross-space set and an unknown member without writing anything', () => {
    const { store } = makeStore()
    const a = create(store, init('a'))
    const there = create(store, init('there', { spaceId: 'space-2', home: { kind: 'canvas', spaceId: 'space-2' } }))
    expect(store.group([a.id, there.id], { content: { headline: 'g' } }))
      .toMatchObject({ applied: false, reason: 'cross-space' })
    expect(store.group([a.id, 'sf-ghost'], { content: { headline: 'g' } }))
      .toMatchObject({ applied: false, reason: 'unknown-surface' })
    expect(store.getAllSurfaces()).toHaveLength(2)
  })

  it('honours the revision gates', () => {
    const { store } = makeStore()
    const a = create(store, init('a'))
    expect(store.group([a.id], { content: { headline: 'g' } }, { expectedTopologyRev: 0 }))
      .toMatchObject({ applied: false, reason: 'stale-topology-revision' })
    expect(store.group([a.id], { content: { headline: 'g' } }, { expectedRevs: { [a.id]: 42 } }))
      .toMatchObject({ applied: false, reason: 'stale-surface-revision' })
    expect(store.getAllSurfaces()).toHaveLength(1)
  })
})

describe('derived indexes', () => {
  it('orders siblings by order, then createdAt, then id', () => {
    const { store } = makeStore()
    const late = create(store, init('late'), 300)
    const early = create(store, init('early'), 100)
    const pinned = create(store, init('pinned', { order: -1 }), 200)
    expect(store.getRoots(SPACE).map(s => s.id)).toEqual([pinned.id, early.id, late.id])
  })

  it('breaks a createdAt tie deterministically by id', () => {
    const { store } = makeStore()
    const a = create(store, init('a', { id: 'sf-b' }), 100)
    const b = create(store, init('b', { id: 'sf-a' }), 100)
    expect(store.getRoots(SPACE).map(s => s.id)).toEqual([b.id, a.id])
  })

  it('treats a leaf as an ordinary Surface with an empty child list', () => {
    const { store } = makeStore()
    const s = create(store, init('leaf'))
    expect(store.getChildren(s.id)).toEqual([])
    expect(store.getAncestors(s.id)).toEqual([])
  })

  it('returns empty reads on an empty store', () => {
    const { store } = makeStore()
    expect(store.getAllSurfaces()).toEqual([])
    expect(store.getRoots(SPACE)).toEqual([])
    expect(store.getChildren('sf-ghost')).toEqual([])
    expect(store.getAncestors('sf-ghost')).toEqual([])
    expect(store.getTopologyRev(SPACE)).toBe(0)
  })

  it('keeps a deep chain walkable', () => {
    const { store } = makeStore()
    const chain = [create(store, init('n0'))]
    for (let i = 1; i < 12; i++) {
      const next = create(store, init(`n${i}`))
      store.setHome(next.id, { kind: 'surface', surfaceId: chain[i - 1]!.id })
      chain.push(next)
    }
    const leaf = chain[11]!
    expect(store.getAncestors(leaf.id)).toHaveLength(11)
    expect(store.getRoots(SPACE).map(s => s.id)).toEqual([chain[0]!.id])
    // Moving the whole chain's root under its own leaf is still a cycle 11 deep.
    expect(store.setHome(chain[0]!.id, { kind: 'surface', surfaceId: leaf.id }))
      .toMatchObject({ applied: false, reason: 'cycle' })
  })

  it('scopes reads by space', () => {
    const { store } = makeStore()
    const here = create(store, init('here'))
    const there = create(store, init('there', { spaceId: 'space-2', home: { kind: 'canvas', spaceId: 'space-2' } }))
    expect(store.getSurfacesForSpace(SPACE).map(s => s.id)).toEqual([here.id])
    expect(store.getRoots('space-2').map(s => s.id)).toEqual([there.id])
    expect(store.getTopologyRev(SPACE)).toBe(1)
    expect(store.getTopologyRev('space-2')).toBe(1)
  })
})

describe('snapshot reload', () => {
  /** Build a small two-space tree with a group, a move, and a content edit. */
  function populate(store: SurfaceStore): void {
    const a = create(store, init('a'), 10)
    const b = create(store, init('b'), 20)
    const c = create(store, init('c'), 30)
    const grouped = store.group([a.id, b.id], { content: { headline: 'group' } }, { at: 40 })
    if (!grouped.applied) throw new Error('setup group rejected')
    store.setHome(c.id, { kind: 'surface', surfaceId: grouped.surfaces[0]!.id }, { at: 50 })
    const fresh = store.getSurface(a.id)!
    store.upsertSurface({ ...fresh, content: { headline: 'a2' }, rev: fresh.rev + 1, amendedAt: 60 })
    create(store, init('elsewhere', { spaceId: 'space-2', home: { kind: 'canvas', spaceId: 'space-2' } }), 70)
  }

  // NAMED U1 SCENARIO. Disk is a later unit; what matters here is that the flat
  // record list is SUFFICIENT — if it were not, the sidecar would need a second,
  // separately-maintained copy of the tree that could drift from the records.
  it('reconstructs parent indexes and topology revision exactly from the records alone', () => {
    const { store } = makeStore()
    populate(store)

    // Round-trip through JSON, which is what a sidecar actually stores.
    const records: Surface[] = JSON.parse(JSON.stringify(store.getAllSurfaces()))
    const { store: reloaded } = makeStore()
    reloaded.load(records)

    for (const space of [SPACE, 'space-2']) {
      expect(reloaded.getTopologyRev(space)).toBe(store.getTopologyRev(space))
      expect(reloaded.getRoots(space).map(s => s.id)).toEqual(store.getRoots(space).map(s => s.id))
    }
    for (const s of store.getAllSurfaces()) {
      expect(reloaded.getChildren(s.id).map(c => c.id)).toEqual(store.getChildren(s.id).map(c => c.id))
      expect(reloaded.getAncestors(s.id).map(a => a.id)).toEqual(store.getAncestors(s.id).map(a => a.id))
    }
    expect(reloaded.getAllSurfaces()).toEqual(store.getAllSurfaces())
  })

  it('rebuilds identically regardless of record order', () => {
    const { store } = makeStore()
    populate(store)
    const records = store.getAllSurfaces()
    const forward = buildTopologyIndex(records)
    const backward = buildTopologyIndex([...records].reverse())
    expect([...backward.children.entries()].sort()).toEqual([...forward.children.entries()].sort())
    expect([...backward.topologyRevs.entries()].sort()).toEqual([...forward.topologyRevs.entries()].sort())
  })

  it('hydrates without emitting — a reload is not a mutation', () => {
    const { store } = makeStore()
    populate(store)
    const records = store.getAllSurfaces()
    const { store: reloaded, batches } = makeStore()
    reloaded.load(records)
    expect(batches).toHaveLength(0)
  })

  it('continues mutating from the reloaded topology revision', () => {
    const { store } = makeStore()
    populate(store)
    const before = store.getTopologyRev(SPACE)
    const { store: reloaded } = makeStore()
    reloaded.load(store.getAllSurfaces())
    const res = reloaded.createSurface(init('after-reload'))
    expect(res).toMatchObject({ applied: true, topologyRev: before + 1 })
  })

  it('skips records that cannot be indexed rather than corrupting the tree', () => {
    const { store } = makeStore()
    const good = create(store, init('good'))
    const records = store.getAllSurfaces()
    const { store: reloaded } = makeStore()
    reloaded.load([
      ...records,
      { ...good, id: '' },
      { ...good, id: 'sf-no-space', spaceId: '' },
      undefined as unknown as Surface,
    ])
    expect(reloaded.getAllSurfaces().map(s => s.id)).toEqual([good.id])
  })

  it('does not hang on a cycle that arrived through a corrupt snapshot', () => {
    const { store } = makeStore()
    const a = create(store, init('a'))
    const b = create(store, init('b'))
    const { store: reloaded } = makeStore()
    // Hand-forged: the mutation path could never produce this.
    reloaded.load([
      { ...a, home: { kind: 'surface', surfaceId: b.id } },
      { ...b, home: { kind: 'surface', surfaceId: a.id } },
    ])
    expect(reloaded.getAncestors(a.id).length).toBeLessThanOrEqual(3)
    // And it will not extend the broken chain.
    const c = reloaded.createSurface(init('c', { home: { kind: 'surface', surfaceId: a.id } }))
    expect(c).toMatchObject({ applied: false, reason: 'cycle' })
  })
})

describe('lifecycle cascade', () => {
  it('drops a space silently and leaves the other space intact', () => {
    const { store, batches } = makeStore()
    create(store, init('a'))
    const there = create(store, init('there', { spaceId: 'space-2', home: { kind: 'canvas', spaceId: 'space-2' } }))
    batches.length = 0
    store.clearSpaceSilently(SPACE)
    expect(batches).toHaveLength(0)
    expect(store.getSurfacesForSpace(SPACE)).toEqual([])
    expect(store.getTopologyRev(SPACE)).toBe(0)
    expect(store.getAllSurfaces().map(s => s.id)).toEqual([there.id])
    expect(store.getTopologyRev('space-2')).toBe(1)
  })

  it('clears everything for the no-active-space branch', () => {
    const { store, batches } = makeStore()
    create(store, init('a'))
    batches.length = 0
    store.clearAll()
    expect(store.getAllSurfaces()).toEqual([])
    expect(store.getRoots(SPACE)).toEqual([])
    expect(store.getTopologyRev(SPACE)).toBe(0)
    expect(batches).toHaveLength(0)
  })
})
