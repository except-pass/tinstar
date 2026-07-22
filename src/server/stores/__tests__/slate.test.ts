// @vitest-environment node
//
// The Slate store model (U3): store-backed points with merge-by-id projection.
// The load-bearing invariant (KTD1) is that a file re-projection MERGES BY id and
// never clobbers a store-owned thread or status.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SlateStore, derivePointStatus, type SlateChange, type PointInput } from '../slate'
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

    const p = store.getPoint('p1')!
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
    expect(store.getPoint('p2')).toBeUndefined()
    expect(store.getPoint('p1')).toBeDefined()
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
    expect(store.getPoint('p1')).toBeDefined()
    expect(store.getPoint(userPoint.id)).toBeDefined()
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
    expect(store.getPoint('p2')?.amendedAt).toBe(200) // bumped only on real change
    expect(store.getPoint('p1')?.amendedAt).toBe(100) // untouched point keeps its stamp
  })
})

describe('SlateStore — status lifecycle', () => {
  it('derives open → waiting → discussing as the thread grows', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a')], 100)
    expect(store.getPoint('p1')?.status).toBe('open')

    store.addReply(RUN, 'p1', reply('user', 'question', 110))
    expect(store.getPoint('p1')?.status).toBe('waiting')

    store.addReply(RUN, 'p1', reply('agent', 'answer', 120))
    expect(store.getPoint('p1')?.status).toBe('discussing')
  })

  it('an explicit resolve survives a subsequent file re-projection (does not revert to derived)', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a')], 100)
    store.addReply(RUN, 'p1', reply('agent', 'fyi', 110))
    store.resolve(RUN, 'p1', 120)
    expect(store.getPoint('p1')?.status).toBe('resolved')

    store.applyProjection(RUN, [input('p1', 'body v2')], 130)
    expect(store.getPoint('p1')?.status).toBe('resolved')
    expect(store.getPoint('p1')?.resolvedAt).toBe(120)
  })

  it('resolve/dismiss/reopen are explicit and mutually exclusive', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a')], 100)

    store.dismiss(RUN, 'p1', 110)
    expect(store.getPoint('p1')).toMatchObject({ status: 'dismissed', dismissedAt: 110 })

    store.resolve(RUN, 'p1', 120)
    expect(store.getPoint('p1')?.dismissedAt).toBeUndefined() // resolve clears dismiss
    expect(store.getPoint('p1')).toMatchObject({ status: 'resolved', resolvedAt: 120 })

    store.reopen(RUN, 'p1', 130)
    expect(store.getPoint('p1')?.resolvedAt).toBeUndefined()
    expect(store.getPoint('p1')?.status).toBe('open') // back to derived (no replies)
  })

  it('never auto-resolves: a fully-answered thread stays discussing, not resolved (CMT-1302)', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a')], 100)
    store.addReply(RUN, 'p1', reply('user', 'q', 110))
    store.addReply(RUN, 'p1', reply('agent', 'done, I think', 120))
    expect(store.getPoint('p1')?.status).toBe('discussing')
    expect(store.getPoint('p1')?.resolvedAt).toBeUndefined()
  })

  it('addReply is append-only and emits one change', () => {
    const { store, emit } = makeStore()
    store.applyProjection(RUN, [input('p1', 'a')], 100)
    emit.mockClear()
    store.addReply(RUN, 'p1', reply('user', 'first', 110))
    store.addReply(RUN, 'p1', reply('user', 'second', 120))
    expect(store.getPoint('p1')?.replies).toHaveLength(2)
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
    expect(store.getPoint(synthId)?.replies).toHaveLength(1)
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

// A compile-time nod that Point stays the source of truth for the store shape.
const _typecheck: Point['status'] = 'open'
void _typecheck
