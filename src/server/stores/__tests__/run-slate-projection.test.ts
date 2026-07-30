// @vitest-environment node
//
// `unwitnessed`, derived at projection (plan U7, R18 / KTD1).
//
// KTD1 rules this out of the freshness phase union: a sixth `SurfaceFreshnessPhase`
// would be switched on exhaustively by the freshness service and the refresh
// coordinator to carry a fact neither of them asks about, and R18 is explicit that
// `unwitnessed` gates no controls and changes no scheduling. So it is a READING of
// the authored claims tri-state, taken here, on the way to the client.
//
// The chain assertion at the foot is the one that matters. A projected field that
// never reaches `Run.slate` is a silently invisible feature — the render layer's
// tests pass on a prop production never sends.
import { describe, it, expect } from 'vitest'
import { isUnwitnessed, slateSurfaceFromCanonical } from '../run-slate-projection'
import { deriveDueAt, effectiveDeclaration } from '../../surfaces/surface-trigger-matcher'
import { DocumentStore } from '../document-store'
import { seedRunSlate } from './seedRunSlate'
import { OBJECTIVE_POINT_ID } from '../../../domain/types'
import type { Run, Surface, SurfaceClaim, SurfaceContent, SurfaceFreshness } from '../../../domain/types'

const CLAIM: SurfaceClaim = { id: 'c1', witness: 'unit-landed', locus: 'repo' }

function freshness(over: Partial<SurfaceFreshness> = {}): SurfaceFreshness {
  return { phase: 'current', overdue: false, ...over }
}

function surface(content: Partial<SurfaceContent>, over: Partial<Surface> = {}): Surface {
  return {
    id: 'sf-1',
    spaceId: 'space-1',
    home: { kind: 'canvas', spaceId: 'space-1' },
    content: { headline: 'a surface', ...content },
    contentAuthority: 'source-binding',
    author: 'agent',
    thread: { replies: [], status: 'open' },
    freshness: freshness(),
    rev: 1,
    homeRev: 1,
    createdAt: 1_000,
    amendedAt: 2_000,
    ...over,
  }
}

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

describe('isUnwitnessed — both empty claim states collapse (KTD4)', () => {
  it('absent claims: the author never said', () => {
    expect(isUnwitnessed(surface({}))).toBe(true)
  })

  it('`claims: []`: the author checked and found nothing witnessable', () => {
    expect(isUnwitnessed(surface({ claims: [] }))).toBe(true)
  })

  it('a declared claim is witnessable, whether or not anybody has looked yet', () => {
    expect(isUnwitnessed(surface({ claims: [CLAIM] }))).toBe(false)
  })
})

describe('slateSurfaceFromCanonical — unwitnessed on the projected surface', () => {
  // AE3. A claimless surface reports unwitnessed rather than passing for verified.
  it('projects `unwitnessed` for a claimless surface', () => {
    expect(slateSurfaceFromCanonical(surface({}), 'p1').unwitnessed).toBe(true)
    expect(slateSurfaceFromCanonical(surface({ claims: [] }), 'p1').unwitnessed).toBe(true)
  })

  it('omits the key entirely for a claim-bearing surface', () => {
    const projected = slateSurfaceFromCanonical(surface({ claims: [CLAIM] }), 'p1')
    expect(projected.unwitnessed).toBeUndefined()
    expect('unwitnessed' in projected).toBe(false)
  })

  // R18: reporting unwitnessed changes NO scheduling. It is a reading of what the
  // author declared, and it may not touch what the host decided — a projection that
  // downgraded the phase or dropped the deadline would turn an honest label into a
  // behaviour change nothing asked for.
  it('leaves freshness — phase, deadline, overdue — exactly as the record states it', () => {
    const stated = freshness({ phase: 'queued', overdue: true, dueAt: 5_000, verifiedAt: 3_000 })
    const projected = slateSurfaceFromCanonical(surface({}, { freshness: stated }), 'p1')
    expect(projected.unwitnessed).toBe(true)
    expect(projected.freshness).toEqual(stated)
  })

  // AE3, the other half. R18's "changing no scheduling" is a claim about the HOST,
  // not just about the projection: an honest label must not become a reason to go
  // looking. A claimless surface with no recipe still earns no deadline — the same
  // answer it gave before U7 — so nothing wakes up on its account.
  it('earns a claimless surface no deadline it did not already have', () => {
    const s = surface({})
    expect(isUnwitnessed(s)).toBe(true)
    expect(deriveDueAt(s, effectiveDeclaration(s), 6 * 60 * 60_000)).toBeUndefined()
    // …while a surface that DOES declare a claim earns one (R14), which is what makes
    // the previous line a statement about claimlessness rather than about nothing.
    const claimed = surface({ claims: [CLAIM] })
    expect(deriveDueAt(claimed, effectiveDeclaration(claimed), 6 * 60 * 60_000)).toBeDefined()
  })

  // The witness timestamp has to survive the projection or the render layer has
  // nothing to read: `SurfaceAge` takes it from `surface.freshness?.witnessedAt`.
  it('carries `witnessedAt` through, distinct from `amendedAt` (KTD7)', () => {
    const s = surface({ claims: [CLAIM] }, { amendedAt: 9_000, freshness: freshness({ witnessedAt: 4_000 }) })
    const projected = slateSurfaceFromCanonical(s, 'p1')
    expect(projected.freshness!.witnessedAt).toBe(4_000)
    expect(projected.amendedAt).toBe(9_000)
  })

  // The Objective declares no claims, so `unwitnessed` is TRUE of it — and saying so
  // under a sentence the user typed thirty seconds ago is the same nonsense as an
  // amber "unverified", which is why `freshness` is already withheld from it.
  it('withholds it from the Objective, in the same breath as freshness', () => {
    const obj = surface({}, { contentAuthority: 'canonical-direct', author: 'user' })
    const projected = slateSurfaceFromCanonical(obj, OBJECTIVE_POINT_ID)
    expect(projected.kind).toBe('objective')
    expect(projected.unwitnessed).toBeUndefined()
    expect(projected.freshness).toBeUndefined()
  })
})

// THE CHAIN. Back out the spread in `slateSurfaceFromCanonical` and the pure tests
// above still pass while nothing reaches the client; this is the test that notices.
describe('unwitnessed reaches Run.slate', () => {
  it('a surface reconciled from a claimless file arrives at the client as unwitnessed', async () => {
    const store = new DocumentStore()
    store.upsertRun('run-1', makeRun())
    await seedRunSlate(store, 'run-1', [{ id: 'p1', headline: 'pick a name' }], 100)
    expect(store.getRun('run-1')!.slate![0]!.unwitnessed).toBe(true)
  })

  it('…and a surface whose file declares a claim does not', async () => {
    const store = new DocumentStore()
    store.upsertRun('run-1', makeRun())
    await seedRunSlate(store, 'run-1', [{ id: 'p1', headline: 'pick a name', claims: [CLAIM] }], 100)
    expect(store.getRun('run-1')!.slate![0]!.unwitnessed).toBeUndefined()
  })
})
