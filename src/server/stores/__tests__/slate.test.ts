// @vitest-environment node
//
// The Slate store model (U3): store-backed points with merge-by-id projection.
// The load-bearing invariant (KTD1) is that a file re-projection MERGES BY id and
// never clobbers a store-owned thread or status.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SlateStore, derivePointStatus, assignOrderSlots, type SlateChange, type PointInput } from '../slate'
import { DocumentStore } from '../document-store'
import type { Point, Run } from '../../../domain/types'
import type { Reply } from '../../../domain/pinSet'

const RUN = 'CLD-run-1'

function body(text: string) {
  return { root: 'r', components: [{ component: 'Text', id: 'r', text }] }
}

function input(id: string, text: string, over: Partial<PointInput> = {}): PointInput {
  return { id, author: 'agent', headline: `h:${id}`, content: body(text), ...over }
}

function reply(author: 'user' | 'agent', text: string, createdAt: number): Reply {
  return { id: `rep-${createdAt}`, author, text, createdAt }
}

/** Collect the changes a SlateStore emits so we can assert emit-count / payloads. */
function makeStore(): { store: SlateStore; emit: ReturnType<typeof vi.fn>; changes: SlateChange[] } {
  const changes: SlateChange[] = []
  const emit = vi.fn((e: SlateChange) => { changes.push(e) })
  return { store: new SlateStore(emit), emit, changes }
}

describe('derivePointStatus', () => {
  it('no replies → open', () => {
    expect(derivePointStatus({ replies: [] })).toBe('open')
    expect(derivePointStatus({})).toBe('open')
  })
  it('last reply by user → waiting', () => {
    expect(derivePointStatus({ replies: [reply('user', 'q', 1)] })).toBe('waiting')
  })
  it('last reply by agent → discussing', () => {
    expect(derivePointStatus({ replies: [reply('user', 'q', 1), reply('agent', 'a', 2)] })).toBe('discussing')
  })
  it('explicit resolved/dismissed win over any derivation', () => {
    expect(derivePointStatus({ replies: [reply('agent', 'a', 2)], resolvedAt: 5 })).toBe('resolved')
    expect(derivePointStatus({ replies: [reply('user', 'q', 1)], dismissedAt: 5 })).toBe('dismissed')
  })
})

describe('SlateStore.applyProjection — merge by id (KTD1)', () => {
  it('a re-projection that changes a surface body preserves the existing thread and resolved status', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('p1', 'step 1/3')], 100)
    store.addReply(RUN, 'p1', reply('user', 'why this way?', 110))
    store.addReply(RUN, 'p1', reply('agent', 'because X', 120))
    store.resolve(RUN, 'p1', 130)

    // The file amends the body (e.g. a tinstar-run progress write).
    store.applyProjection(RUN, [input('p1', 'step 2/3')], 140)

    const p = store.getPoint(RUN, 'p1')!
    expect(p.content).toEqual(body('step 2/3'))     // file-owned body overwritten
    expect(p.replies).toHaveLength(2)               // store-owned thread preserved
    expect(p.replies?.map(r => r.text)).toEqual(['why this way?', 'because X'])
    expect(p.resolvedAt).toBe(130)                  // explicit resolve preserved
    expect(p.status).toBe('resolved')               // not reverted to derived
  })

  it('a point present in the store but absent from the file is retracted', () => {
    const { store, changes } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a'), input('p2', 'b')], 100)
    expect(store.getPointsForRun(RUN).map(p => p.id)).toEqual(['p1', 'p2'])

    changes.length = 0
    store.applyProjection(RUN, [input('p1', 'a')], 200) // p2 gone from the file
    expect(store.getPoint(RUN, 'p2')).toBeUndefined()
    expect(store.getPoint(RUN, 'p1')).toBeDefined()
    // The retract emits a null-data change for the dropped point (only).
    expect(changes).toEqual([{ entity: 'slatePoint', id: 'p2', runId: RUN, data: null }])
  })

  it('does NOT retract a source:user point absent from the file (U7 reconciliation)', () => {
    const { store, changes } = makeStore()
    store.applyProjection(RUN, [input('p1', 'file body')], 100)
    const userPoint = store.addUserPoint(RUN, { headline: 'user asked this', content: body('u') })
    expect(userPoint.source).toBe('user')

    changes.length = 0
    // A file re-projection that omits the user point (the file never knew about it).
    store.applyProjection(RUN, [input('p1', 'file body')], 200)

    // The file point is untouched; the user point SURVIVES (would be nuked without
    // the source:'user' retraction exemption).
    expect(store.getPoint(RUN, 'p1')).toBeDefined()
    expect(store.getPoint(RUN, userPoint.id)).toBeDefined()
    // No retract was emitted for the user point.
    expect(changes.filter(c => c.data === null)).toEqual([])
  })

  it('does not retract points belonging to a different run', () => {
    const { store } = makeStore()
    store.applyProjection('runA', [input('a1', 'x')], 100)
    store.applyProjection('runB', [input('b1', 'y')], 100)
    store.applyProjection('runA', [], 200) // clears runA only
    expect(store.getPointsForRun('runA')).toHaveLength(0)
    expect(store.getPointsForRun('runB')).toHaveLength(1)
  })

  it('an identical re-projection emits ZERO change events (file-watch storm guard)', () => {
    const { store, emit } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a'), input('p2', 'b')], 100)
    emit.mockClear()

    // Fresh input objects, identical values, a different wall-clock `now`.
    store.applyProjection(RUN, [input('p1', 'a'), input('p2', 'b')], 999)
    expect(emit).not.toHaveBeenCalled()
  })

  it('emits exactly one change for the one point whose body changed', () => {
    const { store, emit } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a'), input('p2', 'b')], 100)
    emit.mockClear()

    store.applyProjection(RUN, [input('p1', 'a'), input('p2', 'CHANGED')], 200)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]![0]).toMatchObject({ entity: 'slatePoint', id: 'p2', runId: RUN })
    expect(store.getPoint(RUN, 'p2')?.amendedAt).toBe(200) // bumped only on real change
    expect(store.getPoint(RUN, 'p1')?.amendedAt).toBe(100) // untouched point keeps its stamp
  })
})

describe('SlateStore — status lifecycle', () => {
  it('derives open → waiting → discussing as the thread grows', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a')], 100)
    expect(store.getPoint(RUN, 'p1')?.status).toBe('open')

    store.addReply(RUN, 'p1', reply('user', 'question', 110))
    expect(store.getPoint(RUN, 'p1')?.status).toBe('waiting')

    store.addReply(RUN, 'p1', reply('agent', 'answer', 120))
    expect(store.getPoint(RUN, 'p1')?.status).toBe('discussing')
  })

  it('an explicit resolve survives a subsequent file re-projection (does not revert to derived)', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a')], 100)
    store.addReply(RUN, 'p1', reply('agent', 'fyi', 110))
    store.resolve(RUN, 'p1', 120)
    expect(store.getPoint(RUN, 'p1')?.status).toBe('resolved')

    store.applyProjection(RUN, [input('p1', 'body v2')], 130)
    expect(store.getPoint(RUN, 'p1')?.status).toBe('resolved')
    expect(store.getPoint(RUN, 'p1')?.resolvedAt).toBe(120)
  })

  it('resolve/dismiss/reopen are explicit and mutually exclusive', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a')], 100)

    store.dismiss(RUN, 'p1', 110)
    expect(store.getPoint(RUN, 'p1')).toMatchObject({ status: 'dismissed', dismissedAt: 110 })

    store.resolve(RUN, 'p1', 120)
    expect(store.getPoint(RUN, 'p1')?.dismissedAt).toBeUndefined() // resolve clears dismiss
    expect(store.getPoint(RUN, 'p1')).toMatchObject({ status: 'resolved', resolvedAt: 120 })

    store.reopen(RUN, 'p1', 130)
    expect(store.getPoint(RUN, 'p1')?.resolvedAt).toBeUndefined()
    expect(store.getPoint(RUN, 'p1')?.status).toBe('open') // back to derived (no replies)
  })

  it('never auto-resolves: a fully-answered thread stays discussing, not resolved (CMT-1302)', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a')], 100)
    store.addReply(RUN, 'p1', reply('user', 'q', 110))
    store.addReply(RUN, 'p1', reply('agent', 'done, I think', 120))
    expect(store.getPoint(RUN, 'p1')?.status).toBe('discussing')
    expect(store.getPoint(RUN, 'p1')?.resolvedAt).toBeUndefined()
  })

  it('addReply is append-only and emits one change', () => {
    const { store, emit } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a')], 100)
    emit.mockClear()
    store.addReply(RUN, 'p1', reply('user', 'first', 110))
    store.addReply(RUN, 'p1', reply('user', 'second', 120))
    expect(store.getPoint(RUN, 'p1')?.replies).toHaveLength(2)
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('mutators no-op on an unknown point / wrong run (no emit)', () => {
    const { store, emit } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a')], 100)
    emit.mockClear()
    store.addReply(RUN, 'nope', reply('user', 'x', 1))
    store.resolve('other-run', 'p1', 1) // right point, wrong run
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('SlateStore — id synthesis for file entries without an id', () => {
  it('synthesizes a deterministic id so a re-projection of the same content keeps the thread', () => {
    const { store } = makeStore()
    // No `id` in the file entry.
    store.applyProjection(RUN, [{ author: 'agent', headline: 'orphan?', content: body('a') }], 100)
    const created = store.getPointsForRun(RUN)
    expect(created).toHaveLength(1)
    const synthId = created[0]!.id
    expect(synthId.startsWith('pt-syn-')).toBe(true)

    // A user replies to the synthesized point.
    store.addReply(RUN, synthId, reply('user', 'a question', 110))

    // The same content is projected again (e.g. from a renamed file — filename is
    // incidental, identity is the content-derived id). The thread must survive.
    store.applyProjection(RUN, [{ author: 'agent', headline: 'orphan?', content: body('a') }], 200)
    expect(store.getPointsForRun(RUN)).toHaveLength(1)
    expect(store.getPoint(RUN, synthId)?.replies).toHaveLength(1)
  })

  it('the synthesized id is stable across store instances (pure function of content)', () => {
    const a = makeStore(); const b = makeStore()
    const entry = { author: 'agent' as const, headline: 'same', content: body('x') }
    a.store.applyProjection(RUN, [entry], 1)
    b.store.applyProjection(RUN, [entry], 999)
    expect(a.store.getPointsForRun(RUN)[0]!.id).toBe(b.store.getPointsForRun(RUN)[0]!.id)
  })
})

describe('SlateStore.addUserPoint (U7)', () => {
  it('creates a source:user point with a generated id, author user, and emits', () => {
    const { store, emit } = makeStore()
    const p = store.addUserPoint(RUN, { headline: 'why is CI red?' })
    expect(p.source).toBe('user')
    expect(p.author).toBe('user')
    expect(p.runId).toBe(RUN)
    expect(p.id).toMatch(/^pt-user-/)
    expect(p.status).toBe('open')
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('amends an existing user point by id, preserving its thread', () => {
    const { store } = makeStore()
    store.addUserPoint(RUN, { id: 'up1', headline: 'first' })
    store.addReply(RUN, 'up1', reply('agent', 'looking', 110))
    const amended = store.addUserPoint(RUN, { id: 'up1', headline: 'first (edited)' })
    expect(amended.headline).toBe('first (edited)')
    expect(amended.replies).toHaveLength(1)   // thread preserved across amend
    expect(amended.source).toBe('user')
  })

  it('a byte-identical amend is a no-op (no emit)', () => {
    const { store, emit } = makeStore()
    store.addUserPoint(RUN, { id: 'up1', headline: 'same' })
    emit.mockClear()
    store.addUserPoint(RUN, { id: 'up1', headline: 'same' })
    expect(emit).not.toHaveBeenCalled()
  })

  // `claim` (S2 — taking over the reserved Objective id). The plain amend inherits the
  // prior point's provenance AND its author; claim takes both, in ONE mutation, without
  // discarding what the store has accumulated on the point.
  it('claim TAKES source and author from a file point, keeping thread and stamps', () => {
    const { store, emit, changes } = makeStore()
    // A file point is created author:'agent' — the exact attribution that must not stick.
    store.applyProjection(RUN, [input('objective', 'agent-authored goal')], 1000)
    store.addReply(RUN, 'objective', { id: 'r1', author: 'user', text: 'why?', createdAt: 1 })
    store.resolve(RUN, 'objective', 5)
    expect(store.getPoint(RUN, 'objective')!.source).toBe('file')
    expect(store.getPoint(RUN, 'objective')!.author).toBe('agent')
    emit.mockClear()
    changes.length = 0

    store.addUserPoint(RUN, { id: 'objective', author: 'user', headline: 'the real goal' }, 2000, { claim: true })

    const after = store.getPoint(RUN, 'objective')!
    expect(after.source).toBe('user')
    expect(after.author).toBe('user') // NOT the file point's 'agent'
    expect(after.headline).toBe('the real goal')
    // An amend, not a replace: everything store-owned survives.
    expect(after.replies).toHaveLength(1)
    expect(after.resolvedAt).toBe(5)
    expect(after.createdAt).toBe(1000) // a re-add would stamp `now` (2000)
    // ONE emit — a flip-then-amend would publish an intermediate frame carrying the
    // agent's headline under the objective's identity.
    expect(emit).toHaveBeenCalledTimes(1)
    expect(changes[0]!.data).not.toBeNull()
  })

  it('claim also drops the file-owned body (the agent’s A2UI is not the goal)', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [{ id: 'objective', headline: 'agent goal', content: body('a') }])
    expect(store.getPoint(RUN, 'objective')!.content).toBeDefined()

    store.addUserPoint(RUN, { id: 'objective', author: 'user', headline: 'the real goal' }, 2000, { claim: true })

    expect(store.getPoint(RUN, 'objective')!.content).toBeUndefined()
  })

  it('claim on an already-user point that changes nothing still emits nothing', () => {
    const { store, emit } = makeStore()
    store.addUserPoint(RUN, { id: 'objective', author: 'user', headline: 'same' })
    emit.mockClear()
    store.addUserPoint(RUN, { id: 'objective', author: 'user', headline: 'same' }, Date.now(), { claim: true })
    expect(emit).not.toHaveBeenCalled()
  })

  it('without claim, an amend still INHERITS the prior provenance (unchanged behaviour)', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('fp', 'from a file')])
    store.addUserPoint(RUN, { id: 'fp', author: 'user', headline: 'amended' })
    expect(store.getPoint(RUN, 'fp')!.source).toBe('file')
  })
})

// --- DocumentStore integration: prune cascade + persistence ---

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: 'run-1', sessionId: 'run-1', taskId: 't1', worktreeId: 'wt1',
    status: 'running', background: false, blocked: false,
    initiative: 'i', epic: 'e', task: 't', repo: 'r', worktree: 'w',
    touchedFiles: [], recapEntries: [], rawLogs: '',
    port: null, backend: null, createdAt: '2026-07-21T00:00:00.000Z',
    ...over,
  } as unknown as Run
}

describe('DocumentStore — Slate prune cascade', () => {
  it('deleteRun prunes the run\'s points via the direct key-match path', () => {
    const store = new DocumentStore()
    const run = makeRun({ id: 'run-1', sessionId: 'run-1' })
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection('run-1', [input('p1', 'a'), input('p2', 'b')], 100)
    expect(store.getSlatePointsForRun('run-1')).toHaveLength(2)

    store.deleteRun('run-1') // direct key match
    expect(store.getSlatePointsForRun('run-1')).toHaveLength(0)
    expect(store.getAllSlatePoints()).toHaveLength(0)
  })

  it('deleteRun prunes the run\'s points via the sessionId fallback path', () => {
    const store = new DocumentStore()
    // Simulator shape: keyed by run id R-xxx, deleted by session name CLD-xxx.
    const run = makeRun({ id: 'R-123', sessionId: 'CLD-abc' })
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection('R-123', [input('p1', 'a')], 100)
    expect(store.getSlatePointsForRun('R-123')).toHaveLength(1)

    store.deleteRun('CLD-abc') // fallback: matched by sessionId
    expect(store.getSlatePointsForRun('R-123')).toHaveLength(0)
  })

  it('deleteRun emits a retract (data:null) per pruned point', () => {
    const store = new DocumentStore()
    store.upsertRun('run-1', makeRun())
    store.applyRunSlateProjection('run-1', [input('p1', 'a')], 100)
    const nulls: string[] = []
    store.changes.on('change', (e: SlateChange) => {
      if (e.entity === 'slatePoint' && e.data === null) nulls.push(e.id)
    })
    store.deleteRun('run-1')
    expect(nulls).toEqual(['p1'])
  })

  it('clear() drops all Slate points', () => {
    const store = new DocumentStore() // no active space → the inline clear branch
    store.upsertRun('run-1', makeRun())
    store.applyRunSlateProjection('run-1', [input('p1', 'a')], 100)
    store.clear()
    expect(store.getAllSlatePoints()).toHaveLength(0)
  })

  it('a projection through the store persists in snapshotAll and reloads', () => {
    // Round-trips a point through disk to prove it rides persistence like notices.
    const dir = mkdtempSync(join(tmpdir(), 'slate-persist-'))
    const file = join(dir, 'state.json')
    try {
      const a = new DocumentStore()
      a.enablePersistence(file)
      a.upsertRun('run-1', makeRun())
      a.applyRunSlateProjection('run-1', [input('p1', 'a')], 100)
      a.addSlateReply('run-1', 'p1', reply('user', 'q', 110))
      a.flush()

      const b = new DocumentStore()
      b.enablePersistence(file)
      const loaded = b.getSlatePointsForRun('run-1')
      expect(loaded).toHaveLength(1)
      expect(loaded[0]!.replies).toHaveLength(1)
      expect(loaded[0]!.status).toBe('waiting')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('SlateStore — refresh recipe (U3 file-owned field)', () => {
  it('a projection carrying `refresh` sets it on the point', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('p1', 'body', { refresh: 'Re-run the PR eval' })], 100)
    expect(store.getPoint(RUN, 'p1')!.refresh).toBe('Re-run the PR eval')
  })

  it('re-projecting an UNCHANGED recipe emits ZERO change (short-circuit holds)', () => {
    const { store, emit } = makeStore()
    store.applyProjection(RUN, [input('p1', 'body', { refresh: 'recipe A' })], 100)
    emit.mockClear()
    store.applyProjection(RUN, [input('p1', 'body', { refresh: 'recipe A' })], 200)
    expect(emit).not.toHaveBeenCalled()          // byte-identical re-projection is a no-op
    expect(store.getPoint(RUN, 'p1')!.amendedAt).toBe(100) // amendedAt untouched
  })

  it('a recipe-ONLY change DOES emit and updates the point (zero-change guard must not swallow it)', () => {
    const { store, emit } = makeStore()
    store.applyProjection(RUN, [input('p1', 'body', { refresh: 'recipe A' })], 100)
    emit.mockClear()
    // headline + content identical — ONLY the recipe changes.
    store.applyProjection(RUN, [input('p1', 'body', { refresh: 'recipe B' })], 200)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(store.getPoint(RUN, 'p1')!.refresh).toBe('recipe B')
    expect(store.getPoint(RUN, 'p1')!.amendedAt).toBe(200) // a recipe change bumps amendedAt
  })

  it('clears `refresh` when a later projection omits the recipe', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('p1', 'body', { refresh: 'recipe A' })], 100)
    store.applyProjection(RUN, [input('p1', 'body')], 200) // recipe omitted → cleared
    expect(store.getPoint(RUN, 'p1')!.refresh).toBeUndefined()
  })

  it('projects `refresh` onto run.slate and a recipe-only change updates the surface', () => {
    const store = new DocumentStore()
    store.upsertRun('run-1', makeRun())
    store.applyRunSlateProjection('run-1', [input('p1', 'body', { refresh: 'recipe A' })], 100)
    expect(store.getRun('run-1')!.slate![0]!.refresh).toBe('recipe A')

    store.applyRunSlateProjection('run-1', [input('p1', 'body', { refresh: 'recipe B' })], 200)
    expect(store.getRun('run-1')!.slate![0]!.refresh).toBe('recipe B')
  })
})

// A compile-time nod that Point stays the source of truth for the store shape.
const _typecheck: Point['status'] = 'open'
void _typecheck

describe('SlateStore - per-(runId, id) scoping (cross-run collision fix)', () => {
  it('a generic id reused across runs does NOT collide - each run keeps its own point', () => {
    const { store } = makeStore()
    // The factory bug: two runs each write a file with the SAME generic id.
    store.applyProjection('run-A', [input('session-arc', 'A content')], 100)
    store.applyProjection('run-B', [input('session-arc', 'B content')], 100)

    const a = store.getPoint('run-A', 'session-arc')!
    const b = store.getPoint('run-B', 'session-arc')!
    expect(a.runId).toBe('run-A')
    expect(b.runId).toBe('run-B')
    // run-B must NOT have clobbered run-A's body (the content-bleed symptom).
    expect(a.content).toEqual(body('A content'))
    expect(b.content).toEqual(body('B content'))
    expect(store.getPointsForRun('run-A')).toHaveLength(1)
    expect(store.getPointsForRun('run-B')).toHaveLength(1)
  })

  it("retracting one run's file leaves the other run's same-id point intact", () => {
    const { store } = makeStore()
    store.applyProjection('run-A', [input('decisions', 'A')], 100)
    store.applyProjection('run-B', [input('decisions', 'B')], 100)
    store.applyProjection('run-B', [], 200) // run-B's file empties (retract)
    expect(store.getPoint('run-A', 'decisions')).toBeDefined()   // survives
    expect(store.getPoint('run-B', 'decisions')).toBeUndefined() // retracted
  })

  it('a user point and a file point with the same id on different runs are independent', () => {
    const { store } = makeStore()
    store.addUserPoint('run-A', { id: 'blockers', author: 'user', headline: 'user A' })
    store.applyProjection('run-B', [input('blockers', 'file B')], 100)
    expect(store.getPoint('run-A', 'blockers')!.source).toBe('user')
    expect(store.getPoint('run-A', 'blockers')!.runId).toBe('run-A')
    expect(store.getPoint('run-B', 'blockers')!.runId).toBe('run-B')
    expect(store.getPoint('run-B', 'blockers')!.content).toEqual(body('file B'))
  })
})

// ── S6 U2: reorder ─────────────────────────────────────────────────────────
//
// `order` is a THREE-place flow: the store assigns it (reorderPoints), the merge
// preserves it across a file re-projection (mergeFileOwned's `...prior`), and the
// projection reads it (`p.order ?? p.createdAt` in projectRunToSlate). Miss any one
// and the feature fails SILENTLY — the reorder appears to work and then quietly
// reverts. Each test below fails if one of those three spots is backed out.

describe('assignOrderSlots (S6 U2)', () => {
  it('re-issues the same slots ascending so the group does not move as a whole', () => {
    expect(assignOrderSlots([300, 100, 200])).toEqual([100, 200, 300])
    expect(assignOrderSlots([])).toEqual([])
    expect(assignOrderSlots([42])).toEqual([42])
  })

  it('forces strictly increasing values so an order tie cannot ignore the sequence', () => {
    // Two points created in the same millisecond would otherwise share a slot, and
    // the render sort's createdAt tiebreak would silently undo the reorder.
    expect(assignOrderSlots([100, 100, 100])).toEqual([100, 101, 102])
    expect(assignOrderSlots([100, 100, 105])).toEqual([100, 101, 105])
  })
})

describe('SlateStore.reorderPoints (S6 U2)', () => {
  it('permutes the listed points within the slots they already occupy', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('a', 'a')], 100)
    store.applyProjection(RUN, [input('a', 'a'), input('b', 'b')], 200)
    store.applyProjection(RUN, [input('a', 'a'), input('b', 'b'), input('c', 'c')], 300)
    expect(store.getPointsForRun(RUN).map(p => p.id)).toEqual(['a', 'b', 'c'])

    store.reorderPoints(RUN, ['c', 'a', 'b'])

    expect(store.getPointsForRun(RUN).map(p => p.id)).toEqual(['c', 'a', 'b'])
    // The slots themselves are unchanged — only who holds them. That's what keeps
    // the group from jumping ahead of the run's other (unlisted) surfaces.
    expect(store.getPointsForRun(RUN).map(p => p.order)).toEqual([100, 200, 300])
  })

  it('leaves points of the run that are NOT listed untouched', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('a', 'a')], 100)
    store.applyProjection(RUN, [input('a', 'a'), input('b', 'b')], 200)
    store.applyProjection(RUN, [input('a', 'a'), input('b', 'b'), input('keep', 'k')], 300)

    store.reorderPoints(RUN, ['b', 'a'])

    expect(store.getPoint(RUN, 'keep')!.order).toBeUndefined()
    expect(store.getPointsForRun(RUN).map(p => p.id)).toEqual(['b', 'a', 'keep'])
  })

  it('emits once per moved point, and nothing at all for an identical reorder', () => {
    const { store, changes } = makeStore()
    store.applyProjection(RUN, [input('a', 'a')], 100)
    store.applyProjection(RUN, [input('a', 'a'), input('b', 'b')], 200)
    changes.length = 0

    store.reorderPoints(RUN, ['b', 'a'])
    expect(changes.map(c => c.id).sort()).toEqual(['a', 'b'])

    // Re-asserting the same sequence changes nothing → zero events (the storm guard).
    changes.length = 0
    store.reorderPoints(RUN, ['b', 'a'])
    expect(changes).toHaveLength(0)
  })

  it('ignores unknown ids, duplicates, and a list too short to permute', () => {
    const { store, changes } = makeStore()
    store.applyProjection(RUN, [input('a', 'a')], 100)
    store.applyProjection(RUN, [input('a', 'a'), input('b', 'b')], 200)
    changes.length = 0

    store.reorderPoints(RUN, ['nope'])           // unknown only → nothing to do
    store.reorderPoints(RUN, ['a'])              // single id → nothing to permute
    store.reorderPoints(RUN, ['a', 'a', 'a'])    // dedup collapses to one
    expect(changes).toHaveLength(0)

    store.reorderPoints(RUN, ['b', 'ghost', 'a'])  // unknown id is simply skipped
    expect(store.getPointsForRun(RUN).map(p => p.id)).toEqual(['b', 'a'])
  })

  it('does NOT bump amendedAt (a reorder is not a re-authoring)', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('a', 'a')], 100)
    store.applyProjection(RUN, [input('a', 'a'), input('b', 'b')], 200)
    const before = store.getPointsForRun(RUN).map(p => p.amendedAt)
    store.reorderPoints(RUN, ['b', 'a'])
    const after = store.getPointsForRun(RUN)
      .sort((x, y) => x.createdAt - y.createdAt)
      .map(p => p.amendedAt)
    expect(after).toEqual(before)
  })

  it('SURVIVES a file re-projection that rewrites the point bodies', () => {
    // The silent-failure guard: `order` is store-owned, so mergeFileOwned's
    // `...prior` spread is the only thing preserving it. Back that out and this
    // reverts to creation order with no error anywhere.
    const { store } = makeStore()
    store.applyProjection(RUN, [input('a', 'a')], 100)
    store.applyProjection(RUN, [input('a', 'a'), input('b', 'b')], 200)
    store.reorderPoints(RUN, ['b', 'a'])
    expect(store.getPointsForRun(RUN).map(p => p.id)).toEqual(['b', 'a'])

    // The agent rewrites the file (new bodies, same ids).
    store.applyProjection(RUN, [input('a', 'a2'), input('b', 'b2')], 900)

    expect(store.getPointsForRun(RUN).map(p => p.id)).toEqual(['b', 'a'])
    expect(store.getPoint(RUN, 'a')!.content).toEqual(body('a2'))
  })
})

describe('DocumentStore.reorderSlatePoints — the projection leg (S6 U2)', () => {
  it('re-projects run.slate in the new order, with createdAt as the fallback', () => {
    const store = new DocumentStore()
    store.upsertRun('run-1', makeRun())
    store.applyRunSlateProjection('run-1', [input('a', 'a')], 100)
    store.applyRunSlateProjection('run-1', [input('a', 'a'), input('b', 'b')], 200)

    // Before any reorder, surface.order IS createdAt — unchanged behavior.
    const before = store.getRun('run-1')!.slate!
    expect(before.map(s => s.id)).toEqual(['a', 'b'])
    expect(before.map(s => s.order)).toEqual([100, 200])

    store.reorderSlatePoints('run-1', ['b', 'a'])

    // The third place: projectRunToSlate must read p.order, not p.createdAt. If it
    // still read createdAt, run.slate would come back in the OLD order with no error.
    const after = store.getRun('run-1')!.slate!
    expect(after.map(s => s.id)).toEqual(['b', 'a'])
    expect(after.map(s => s.order)).toEqual([100, 200])
  })
})

describe('SlateStore.deletePoint (S2 — clearing the Objective)', () => {
  it('removes only the targeted (runId, id) and emits ONE retract', () => {
    const { store, emit, changes } = makeStore()
    store.addUserPoint(RUN, { id: 'objective', headline: 'ship S2' })
    store.applyProjection(RUN, [input('other', 'x')])
    emit.mockClear()
    changes.length = 0

    expect(store.deletePoint(RUN, 'objective')).toBe(true)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(changes[0]).toMatchObject({ entity: 'slatePoint', id: 'objective', runId: RUN, data: null })
    expect(store.getPoint(RUN, 'objective')).toBeUndefined()
    expect(store.getPoint(RUN, 'other')).toBeDefined() // sibling untouched
  })

  it("leaves ANOTHER run's point with the same id alone (composite-key scoping)", () => {
    const { store } = makeStore()
    store.addUserPoint(RUN, { id: 'objective', headline: 'mine' })
    store.addUserPoint('other-run', { id: 'objective', headline: 'theirs' })

    store.deletePoint(RUN, 'objective')

    expect(store.getPoint(RUN, 'objective')).toBeUndefined()
    expect(store.getPoint('other-run', 'objective')?.headline).toBe('theirs')
  })

  it('deleting an absent point is a no-op — false, no emit', () => {
    const { store, emit } = makeStore()
    expect(store.deletePoint(RUN, 'nope')).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it('DocumentStore.deleteSlatePoint re-projects run.slate (and is inert when absent)', () => {
    const store = new DocumentStore()
    store.upsertRun('run-1', makeRun())
    store.addUserSlatePoint('run-1', { id: 'objective', author: 'user', headline: 'the goal' })
    expect(store.getRun('run-1')!.slate).toHaveLength(1)

    expect(store.deleteSlatePoint('run-1', 'objective')).toBe(true)
    // An empty projection clears the field entirely (setRunSlate's own convention).
    expect(store.getRun('run-1')!.slate).toBeUndefined()

    expect(store.deleteSlatePoint('run-1', 'objective')).toBe(false)
  })
})
