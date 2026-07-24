// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DocumentStore } from '../document-store'
import { OBJECTIVE_ORDER, OBJECTIVE_POINT_ID } from '../../../domain/types'
import type { Run } from '../../../domain/types'

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

// The reconciliation: store-backed points are the source of truth, but the client
// renders ONE channel (RunData.slate). DocumentStore bridges points -> run.slate
// after every mutation, so the run card reflects points + threads + status without
// subscribing to a second stream.
describe('DocumentStore — Slate points bridge to run.slate', () => {
  it('projects a store point onto run.slate as an open-point surface', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)

    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'Which rollback path?' }])

    const slate = store.getRun(run.id)?.slate
    expect(slate).toHaveLength(1)
    expect(slate?.[0]).toMatchObject({ id: 'p1', kind: 'open-point', headline: 'Which rollback path?', status: 'open' })
  })

  it('reflects a reply on run.slate — thread grows and status becomes waiting', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'Q?' }])

    store.addSlateReply(run.id, 'p1', { id: 'rep1', author: 'user', text: 'revert', createdAt: 10 })

    const s = store.getRun(run.id)?.slate?.[0]
    expect(s?.thread).toHaveLength(1)
    expect(s?.status).toBe('waiting') // last author = user
  })

  it('reflects an explicit resolve on run.slate and it survives a re-projection', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'Q?' }])
    store.resolveSlatePoint(run.id, 'p1')

    expect(store.getRun(run.id)?.slate?.[0]?.status).toBe('resolved')

    // A later file re-projection of the same point (body unchanged) must not revert
    // the store-owned resolve.
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'Q?' }])
    expect(store.getRun(run.id)?.slate?.[0]?.status).toBe('resolved')
  })

  it('clears run.slate when the run retracts all its points', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'Q?' }])
    expect(store.getRun(run.id)?.slate).toHaveLength(1)

    store.applyRunSlateProjection(run.id, []) // file emptied → retract
    expect(store.getRun(run.id)?.slate).toBeUndefined()
  })

  // S4 — the workbench set id must survive the bridge. This is the leg that fails
  // SILENTLY: without the `group` spread in projectRunToSlate the store holds the
  // field, the server tests all pass, and the client just never sees a workbench.
  it('carries a point\'s `group` onto run.slate (workbench set id, S4)', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)

    store.applyRunSlateProjection(run.id, [
      { id: 'q1', headline: 'Which rollback path?', group: 'launch-qs' },
      { id: 'q2', headline: 'Who owns the migration?', group: 'launch-qs' },
      { id: 'q3', headline: 'An ordinary point' },
    ])

    const slate = store.getRun(run.id)!.slate!
    expect(slate.find(s => s.id === 'q1')!.group).toBe('launch-qs')
    expect(slate.find(s => s.id === 'q2')!.group).toBe('launch-qs')
    expect(slate.find(s => s.id === 'q3')!.group).toBeUndefined()
    // Grouping is presentational only — the kind is still an ordinary open-point,
    // so nothing about dispatch/reorder/pinning changes.
    expect(slate.every(s => s.kind === 'open-point')).toBe(true)
  })

  it('a grouped point still sorts by `order`, so the objective pin survives grouping', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection(run.id, [{ id: 'q1', headline: 'a', group: 'g' }], 100)
    store.addUserSlatePoint(run.id, { id: OBJECTIVE_POINT_ID, author: 'user', headline: 'the goal' })

    const slate = store.getRun(run.id)!.slate!
    expect(Math.min(...slate.map(s => s.order!))).toBe(OBJECTIVE_ORDER)
    expect(slate.find(s => s.id === 'q1')!.group).toBe('g')
  })
})

// The Objective (S2) rides this same bridge — it is a reserved USER point, projected
// as its own kind and pinned ahead of everything else. No new RunData field.
describe('DocumentStore — the Objective projection (S2)', () => {
  it("projects the reserved user point as kind 'objective', pinned FIRST", () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)

    // Two ordinary surfaces first, so creation order alone would put the objective last.
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'first' }], 100)
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'first' }, { id: 'p2', headline: 'second' }], 200)
    store.addUserSlatePoint(run.id, { id: OBJECTIVE_POINT_ID, author: 'user', headline: 'Ship the objective surface' })

    const slate = store.getRun(run.id)!.slate!
    const objective = slate.find(s => s.id === OBJECTIVE_POINT_ID)!
    expect(objective.kind).toBe('objective')
    expect(objective.headline).toBe('Ship the objective surface')
    expect(objective.author).toBe('user')

    // Pinned by a FINITE sentinel — `-Infinity` would serialize to null over SSE and
    // the client's sort (missing order sinks LAST) would flip the pin to the bottom.
    expect(objective.order).toBe(OBJECTIVE_ORDER)
    expect(Number.isFinite(objective.order!)).toBe(true)
    expect(JSON.parse(JSON.stringify(objective)).order).toBe(OBJECTIVE_ORDER)
    expect(Math.min(...slate.map(s => s.order!))).toBe(objective.order)
  })

  it('a FILE point that happens to carry the reserved id is NOT an objective', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)

    // The watcher drops this upstream; the projection is the second gate.
    store.applyRunSlateProjection(run.id, [{ id: OBJECTIVE_POINT_ID, headline: 'not yours' }])

    const s = store.getRun(run.id)!.slate![0]!
    expect(s.kind).toBe('open-point')
    expect(s.order).not.toBe(OBJECTIVE_ORDER)
  })

  it('a user reorder cannot strand the objective — the pin is forced, not stored', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'a' }], 100)
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'a' }, { id: 'p2', headline: 'b' }], 200)
    store.addUserSlatePoint(run.id, { id: OBJECTIVE_POINT_ID, author: 'user', headline: 'the goal' })

    // A reorder that sweeps the objective into the middle writes a store `order` on it.
    store.reorderSlatePoints(run.id, ['p1', OBJECTIVE_POINT_ID, 'p2'])

    const objective = store.getRun(run.id)!.slate!.find(s => s.id === OBJECTIVE_POINT_ID)!
    expect(objective.order).toBe(OBJECTIVE_ORDER) // still pinned ahead of everything
  })

  it('survives a file re-projection that knows nothing about it (source:user exemption)', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.addUserSlatePoint(run.id, { id: OBJECTIVE_POINT_ID, author: 'user', headline: 'the goal' })

    store.applyRunSlateProjection(run.id, [{ id: 'file-pt', headline: 'from a file' }])

    const slate = store.getRun(run.id)!.slate!
    expect(slate.find(s => s.id === OBJECTIVE_POINT_ID)?.kind).toBe('objective')
  })

  it('amending the objective replaces it in place — never a second one', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.addUserSlatePoint(run.id, { id: OBJECTIVE_POINT_ID, author: 'user', headline: 'v1' })
    store.addUserSlatePoint(run.id, { id: OBJECTIVE_POINT_ID, author: 'user', headline: 'v2' })

    const objectives = store.getRun(run.id)!.slate!.filter(s => s.kind === 'objective')
    expect(objectives).toHaveLength(1)
    expect(objectives[0]!.headline).toBe('v2')
  })
})

// "Clean the Slate" (the 🧹 button) wipes the run's points in one shot. The
// Objective is the deliberate survivor: it is the run's pinned goal, it has its
// own explicit clear, and it sits outside the surface machinery everywhere else.
describe('DocumentStore — clearSlateForRun ("clean the slate")', () => {
  it('drops every surface point but keeps the Objective', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection(run.id, [
      { id: 'q1', headline: 'file surface a' },
      { id: 'q2', headline: 'file surface b' },
    ], 100)
    store.addUserSlatePoint(run.id, { id: 'mine', author: 'user', headline: 'my own point' })
    store.addUserSlatePoint(run.id, { id: OBJECTIVE_POINT_ID, author: 'user', headline: 'the goal' })

    // Three go (two file-authored + one user-authored); the objective stays.
    expect(store.clearSlateForRun(run.id)).toBe(3)

    const slate = store.getRun(run.id)!.slate!
    expect(slate.map(s => s.id)).toEqual([OBJECTIVE_POINT_ID])
    expect(slate[0]!.kind).toBe('objective')
  })

  it('is idempotent — a second clean is a no-op that reports zero', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection(run.id, [{ id: 'q1', headline: 'a' }], 100)

    expect(store.clearSlateForRun(run.id)).toBe(1)
    expect(store.clearSlateForRun(run.id)).toBe(0)
    expect(store.getRun(run.id)!.slate ?? []).toEqual([])
  })

  it('cleans a run that only ever had an Objective without touching it', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.addUserSlatePoint(run.id, { id: OBJECTIVE_POINT_ID, author: 'user', headline: 'the goal' })

    expect(store.clearSlateForRun(run.id)).toBe(0)
    expect(store.getRun(run.id)!.slate!.map(s => s.id)).toEqual([OBJECTIVE_POINT_ID])
  })

  it('clears only the named run, never a neighbour\'s Slate', () => {
    const store = new DocumentStore()
    const a = makeRun({ id: 'ra', sessionId: 'ra' })
    const b = makeRun({ id: 'rb', sessionId: 'rb' })
    store.upsertRun(a.id, a)
    store.upsertRun(b.id, b)
    store.applyRunSlateProjection(a.id, [{ id: 'q1', headline: 'a' }], 100)
    store.applyRunSlateProjection(b.id, [{ id: 'q2', headline: 'b' }], 100)

    store.clearSlateForRun(a.id)

    expect(store.getRun(a.id)!.slate ?? []).toEqual([])
    expect(store.getRun(b.id)!.slate!.map(s => s.id)).toEqual(['q2'])
  })
})
