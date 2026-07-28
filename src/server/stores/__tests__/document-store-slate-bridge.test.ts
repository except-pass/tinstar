// @vitest-environment node
//
// `Run.slate` — the ONE channel the run card renders — derived from CANONICAL
// Surfaces through the run's compatibility aliases (plan KTD3, U2). Before U2 this
// derived from the legacy `SlateStore`; the swap is what this unit is for, and this
// file is where the swapped behaviour is pinned.
//
// Nothing is mocked between the layers: the seed goes through the real source
// reconciler, the writes go through the real `SurfaceService`, and the assertions
// read the real derived projection off the run record.
import { describe, it, expect } from 'vitest'
import { DocumentStore } from '../document-store'
import { OBJECTIVE_ORDER, OBJECTIVE_POINT_ID } from '../../../domain/types'
import type { Run } from '../../../domain/types'
import { seedRunSlate } from './seedRunSlate'
import { RunSlateBridge } from '../../surfaces/run-slate-bridge'
import { SurfaceService } from '../../surfaces/surface-service'
import type { Surface, SurfacePrincipalRef } from '../../../domain/types'
import { inRunSlate } from '../run-slate-projection'

const USER: SurfacePrincipalRef = { kind: 'human', id: 'actor-1' }

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r1', sessionId: 'r1', taskId: 't1', worktreeId: 'wt1',
    status: 'running', background: false, blocked: false,
    initiative: 'i', epic: 'e', task: 't', repo: 'r', worktree: 'w',
    touchedFiles: [], recapEntries: [], rawLogs: '',
    port: null, backend: null, createdAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  }
}

function setup(overrides: Partial<Run> = {}) {
  const store = new DocumentStore()
  const run = makeRun(overrides)
  store.upsertRun(run.id, run)
  const bridge = new RunSlateBridge(store, new SurfaceService(store))
  return {
    store,
    runId: run.id,
    bridge,
    slate: () => store.getRun(run.id)?.slate,
    ids: () => (store.getRun(run.id)?.slate ?? []).map(s => s.id),
  }
}

describe('Run.slate derives from canonical Surfaces', () => {
  it('projects a reconciled Surface as an open-point entry keyed by its LOCAL id', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'p1', headline: 'Which rollback path?' }])

    expect(h.slate()).toHaveLength(1)
    expect(h.slate()![0]).toMatchObject({
      id: 'p1', kind: 'open-point', headline: 'Which rollback path?', status: 'open', author: 'agent',
    })
  })

  it('excludes the run compatibility ROOT, which contains the Slate rather than sitting in it', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'p1', headline: 'Q?' }])

    // The root exists as a canonical record; it just never renders.
    expect(h.store.getSurfacesForRunAlias(h.runId).filter(s => s.compatibilityOnly)).toHaveLength(1)
    expect(h.ids()).toEqual(['p1'])
  })

  it('reflects a reply — thread grows and status becomes waiting', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'p1', headline: 'Q?' }])

    await h.bridge.appendReply(h.runId, 'p1', 'revert', USER)

    expect(h.slate()![0]!.thread).toHaveLength(1)
    expect(h.slate()![0]!.status).toBe('waiting') // last author = user
  })

  it('an explicit resolve survives a later source re-observation', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'p1', headline: 'Q?' }])
    await h.bridge.setDisposition(h.runId, 'p1', 'resolve', USER)
    expect(h.slate()![0]!.status).toBe('resolved')

    // Even one that CHANGES the body: a source may replace authored content and
    // nothing else (KTD4).
    await seedRunSlate(h.store, h.runId, [{ id: 'p1', headline: 'Q, restated?' }], 2_000)
    expect(h.slate()![0]).toMatchObject({ headline: 'Q, restated?', status: 'resolved' })
  })

  it('a reply REOPENS a resolved point instead of being swallowed by it', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'p1', headline: 'Q?' }])
    await h.bridge.setDisposition(h.runId, 'p1', 'resolve', USER)

    await h.bridge.appendReply(h.runId, 'p1', 'actually, no', USER)

    expect(h.slate()![0]!.status).toBe('waiting')
    expect(h.slate()![0]!.thread).toHaveLength(1)
  })

  // THE BEHAVIOUR CHANGE U2 MAKES, stated as a test because it is what a user sees.
  // The legacy projection RETRACTED a file-owned point that vanished from the files.
  // A canonical record is not retracted by an omission — it is marked source-missing
  // and stays on the Slate with its thread, and only the deletion service removes it.
  it('does NOT clear the Slate when the source files go away', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'p1', headline: 'Q?' }])
    await h.bridge.appendReply(h.runId, 'p1', 'my answer', USER)

    await seedRunSlate(h.store, h.runId, [], 2_000) // the agent deleted its files

    expect(h.ids()).toEqual(['p1'])
    expect(h.slate()![0]!.thread).toHaveLength(1)
    const surface = h.store.surfaceForRunAlias(h.runId, 'p1')!
    expect(surface.source).toMatchObject({ state: 'missing', missingSince: 2_000 })
    expect(surface.freshness.phase).toBe('possibly-stale')
  })

  it('drops the Slate entirely once the surfaces are deleted', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'p1', headline: 'Q?' }])

    expect(await h.bridge.clean(h.runId, USER)).toBe(1)
    expect(h.slate()).toBeUndefined()
  })

  // Three legacy fields are gone by author ruling: `anchor` (the card-vs-row
  // distinction does not exist in the target model), `group` (grouping is a
  // container Surface, a shape rather than a field), and `stalledAt`.
  it('carries no anchor, group, or stalledAt onto the projection', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'q1', headline: 'a' }, { id: 'q2', headline: 'b' }])

    for (const entry of h.slate()!) {
      expect(entry.anchor).toBeUndefined()
      expect(entry.group).toBeUndefined()
      expect(entry.stalledAt).toBeUndefined()
      expect(entry.kind).toBe('open-point')
    }
  })

  it('carries the author-declared recipe through as `refresh`', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'p1', headline: 'a', recipe: 'rebuild me' }])
    expect(h.slate()![0]!.refresh).toBe('rebuild me')
  })
})

// `inRunSlate` is the gate the derivation and the point projection share. Tested
// directly because its two exclusions are independent and, on a real store today,
// overlap: every compatibility root also carries a hidden alias, so a store-level
// test cannot tell which gate did the work.
describe('inRunSlate', () => {
  const surface = (over: Partial<Surface> = {}): Surface => ({
    id: 'sf-1', spaceId: 'spc-a', home: { kind: 'canvas', spaceId: 'spc-a' },
    content: { headline: 'h' }, contentAuthority: 'canonical-direct', author: 'agent',
    thread: { replies: [], status: 'open' }, freshness: { phase: 'current', overdue: false },
    rev: 1, homeRev: 1, createdAt: 1, amendedAt: 1, ...over,
  })
  const alias = { bucket: { kind: 'run' as const, runId: 'r1' }, localId: 'p1', visible: true }

  it('admits a visible alias on an ordinary Surface', () => {
    expect(inRunSlate(surface(), alias)).toBe(true)
  })

  it('excludes a compatibility root even when its alias is visible', () => {
    expect(inRunSlate(surface({ compatibilityOnly: true }), alias)).toBe(false)
  })

  it('excludes a hidden alias, and a Surface with no alias for this run', () => {
    expect(inRunSlate(surface(), { ...alias, visible: false })).toBe(false)
    expect(inRunSlate(surface(), undefined)).toBe(false)
  })
})

describe('the Objective projection (S2)', () => {
  it("projects the reserved user point as kind 'objective', pinned FIRST", async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'p1', headline: 'first' }, { id: 'p2', headline: 'second' }])
    await h.bridge.upsertUserPoint(h.runId, { id: OBJECTIVE_POINT_ID, headline: 'Ship the objective surface' }, USER)

    const objective = h.slate()!.find(s => s.id === OBJECTIVE_POINT_ID)!
    expect(objective.kind).toBe('objective')
    expect(objective.headline).toBe('Ship the objective surface')
    expect(objective.author).toBe('user')

    // Pinned by a FINITE sentinel — `-Infinity` would serialize to null over SSE and
    // the client's sort (missing order sinks LAST) would flip the pin to the bottom.
    expect(objective.order).toBe(OBJECTIVE_ORDER)
    expect(Number.isFinite(objective.order!)).toBe(true)
    expect(JSON.parse(JSON.stringify(objective)).order).toBe(OBJECTIVE_ORDER)
    expect(Math.min(...h.slate()!.map(s => s.order!))).toBe(objective.order)
  })

  it('a SOURCE-owned Surface at the reserved id is NOT an objective', async () => {
    const h = setup()
    // The watcher drops this upstream; the projection is the second gate, and it
    // gates on content AUTHORITY rather than on the id alone.
    await seedRunSlate(h.store, h.runId, [{ id: OBJECTIVE_POINT_ID, headline: 'not yours' }])

    const s = h.slate()![0]!
    expect(s.kind).toBe('open-point')
    expect(s.order).not.toBe(OBJECTIVE_ORDER)
  })

  it('CLAIMS a source-owned Surface at the reserved id, keeping its thread', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: OBJECTIVE_POINT_ID, headline: 'squatting' }])
    await h.bridge.appendReply(h.runId, OBJECTIVE_POINT_ID, 'a prior discussion', USER)

    await h.bridge.upsertUserPoint(h.runId, { id: OBJECTIVE_POINT_ID, headline: 'the real goal' }, USER, { claim: true })

    const objective = h.slate()!.find(s => s.id === OBJECTIVE_POINT_ID)!
    expect(objective.kind).toBe('objective')
    expect(objective.headline).toBe('the real goal')
    expect(objective.thread).toHaveLength(1) // an amend, not a delete-and-re-add

    // And the file can no longer take it back — later epochs report divergence.
    await seedRunSlate(h.store, h.runId, [{ id: OBJECTIVE_POINT_ID, headline: 'squatting again' }], 3_000)
    expect(h.slate()!.find(s => s.id === OBJECTIVE_POINT_ID)!.headline).toBe('the real goal')
  })

  it('survives a source epoch that knows nothing about it', async () => {
    const h = setup()
    await h.bridge.upsertUserPoint(h.runId, { id: OBJECTIVE_POINT_ID, headline: 'the goal' }, USER)

    await seedRunSlate(h.store, h.runId, [{ id: 'file-pt', headline: 'from a file' }])

    expect(h.slate()!.find(s => s.id === OBJECTIVE_POINT_ID)?.kind).toBe('objective')
  })

  it('amending the objective replaces it in place — never a second one', async () => {
    const h = setup()
    await h.bridge.upsertUserPoint(h.runId, { id: OBJECTIVE_POINT_ID, headline: 'v1' }, USER)
    await h.bridge.upsertUserPoint(h.runId, { id: OBJECTIVE_POINT_ID, headline: 'v2' }, USER)

    const objectives = h.slate()!.filter(s => s.kind === 'objective')
    expect(objectives).toHaveLength(1)
    expect(objectives[0]!.headline).toBe('v2')
  })
})

describe('"clean the slate"', () => {
  it('drops every surface but keeps the Objective', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [
      { id: 'q1', headline: 'file surface a' },
      { id: 'q2', headline: 'file surface b' },
    ])
    await h.bridge.upsertUserPoint(h.runId, { id: 'mine', headline: 'my own point' }, USER)
    await h.bridge.upsertUserPoint(h.runId, { id: OBJECTIVE_POINT_ID, headline: 'the goal' }, USER)

    expect(await h.bridge.clean(h.runId, USER)).toBe(3)

    expect(h.ids()).toEqual([OBJECTIVE_POINT_ID])
    expect(h.slate()![0]!.kind).toBe('objective')
  })

  it('uses the RECOVERABLE deletion service — a cleaned surface is restorable', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'q1', headline: 'a' }])
    const id = h.store.surfaceForRunAlias(h.runId, 'q1')!.id
    await h.bridge.appendReply(h.runId, 'q1', 'said something', USER)

    await h.bridge.clean(h.runId, USER)

    // Not erased: it moved into the per-space recovery store with everything intact.
    const recovered = h.store.getSurface(id)!
    expect(recovered.home.kind).toBe('recovery')
    expect(recovered.thread.replies).toHaveLength(1)
    expect(h.store.getSurfaceRecoveryRoots(recovered.spaceId).map(s => s.id)).toEqual([id])
  })

  it('leaves a PROMOTED surface alone — it is no longer the run workspace\'s to wipe', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'q1', headline: 'promoted' }, { id: 'q2', headline: 'ordinary' }])
    const promoted = h.store.surfaceForRunAlias(h.runId, 'q1')!
    const svc = new SurfaceService(h.store)
    const moved = await svc.reparent({ ids: [promoted.id], home: { kind: 'canvas', spaceId: promoted.spaceId } }, { actor: USER })
    expect(moved.ok).toBe(true)

    expect(await h.bridge.clean(h.runId, USER)).toBe(1)

    expect(h.store.getSurface(promoted.id)!.home).toEqual({ kind: 'canvas', spaceId: promoted.spaceId })
    // Still reachable from the Run Workspace: promotion does not remove the alias.
    expect(h.ids()).toEqual(['q1'])
  })

  it('is idempotent — a second clean is a no-op that reports zero', async () => {
    const h = setup()
    await seedRunSlate(h.store, h.runId, [{ id: 'q1', headline: 'a' }])

    expect(await h.bridge.clean(h.runId, USER)).toBe(1)
    expect(await h.bridge.clean(h.runId, USER)).toBe(0)
    expect(h.slate() ?? []).toEqual([])
  })

  it('cleans a run that only ever had an Objective without touching it', async () => {
    const h = setup()
    await h.bridge.upsertUserPoint(h.runId, { id: OBJECTIVE_POINT_ID, headline: 'the goal' }, USER)

    expect(await h.bridge.clean(h.runId, USER)).toBe(0)
    expect(h.ids()).toEqual([OBJECTIVE_POINT_ID])
  })

  it('clears only the named run, never a neighbour\'s Slate', async () => {
    const store = new DocumentStore()
    const a = makeRun({ id: 'ra', sessionId: 'ra' })
    const b = makeRun({ id: 'rb', sessionId: 'rb' })
    store.upsertRun(a.id, a)
    store.upsertRun(b.id, b)
    await seedRunSlate(store, a.id, [{ id: 'q1', headline: 'a' }])
    await seedRunSlate(store, b.id, [{ id: 'q2', headline: 'b' }])
    const bridge = new RunSlateBridge(store, new SurfaceService(store))

    await bridge.clean(a.id, USER)

    expect(store.getRun(a.id)!.slate ?? []).toEqual([])
    expect(store.getRun(b.id)!.slate!.map(s => s.id)).toEqual(['q2'])
  })
})
