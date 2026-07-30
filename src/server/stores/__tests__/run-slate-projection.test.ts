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
import { bindClaimSteps, isUnwitnessed, slateSurfaceFromCanonical } from '../run-slate-projection'
import { deriveDueAt, effectiveDeclaration } from '../../surfaces/surface-trigger-matcher'
import { DocumentStore } from '../document-store'
import { seedRunSlate } from './seedRunSlate'
import { OBJECTIVE_POINT_ID } from '../../../domain/types'
import type {
  A2uiContent, Run, Surface, SurfaceClaim, SurfaceClaimObservation, SurfaceClaimValue,
  SurfaceContent, SurfaceFreshness,
} from '../../../domain/types'

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

// ---------------------------------------------------------------------------
// Claim-bound step statuses (plan U8, R22).
//
// The roadmap card the slice ships states no status anywhere in its body: each step
// names a claim and the value that means finished, and the host fills the rest in
// from what it last WITNESSED. These tests are the pure half; `slice-cards.test.ts`
// drives the same binding over the real file→witness→render chain.
// ---------------------------------------------------------------------------

/** A stepper body whose rows are bound to claims, as an author writes it. */
function railBody(steps: Record<string, unknown>[]): A2uiContent {
  return {
    root: 'root',
    components: [
      { id: 'root', component: 'Column', children: ['rail'] },
      { id: 'rail', component: 'Stepper', steps },
    ],
  }
}

function boundSteps(body: A2uiContent | undefined): Record<string, unknown>[] {
  const rail = body?.components.find(c => c.component === 'Stepper')
  return (rail?.steps as Record<string, unknown>[] | undefined) ?? []
}

function observed(values: Record<string, SurfaceClaimValue>): Record<string, SurfaceClaimObservation> {
  return Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value, at: 1 }]))
}

describe('bindClaimSteps — a rail derives from claim values, never from an author', () => {
  const steps = [
    { label: 'U1', claim: 'u1', done: 'landed' },
    { label: 'U4', claim: 'u4', done: 'landed' },
  ]

  it('marks a step done only when a completed lookup returned its `done` value', () => {
    const bound = boundSteps(bindClaimSteps(railBody(steps), observed({ u1: 'landed', u4: 'pending' })))
    expect(bound.map(s => s.status)).toEqual(['done', 'pending'])
  })

  // The whole point of the two-key binding: an author's own status may not survive.
  // Author `done` on a unit that has not landed, and the host still says pending.
  it('overrides an authored status rather than trusting it', () => {
    const lying = [{ label: 'U4', claim: 'u4', done: 'landed', status: 'done' }]
    const bound = boundSteps(bindClaimSteps(railBody(lying), observed({ u4: 'pending' })))
    expect(bound[0]!.status).toBe('pending')
  })

  // There are only four step statuses and none of them means "unknown". `pending` is
  // the honest one: the card says separately, through the freshness badge, that a
  // claim could not be checked.
  it('reads pending for a claim nobody has observed yet', () => {
    expect(boundSteps(bindClaimSteps(railBody(steps), undefined)).map(s => s.status))
      .toEqual(['pending', 'pending'])
    expect(boundSteps(bindClaimSteps(railBody(steps), observed({ u1: 'landed' })))[1]!.status)
      .toBe('pending')
  })

  // An observation that has ONLY ever been unresolved carries no `value` key, and an
  // absent value may never satisfy a `done` — that is KTD8 reaching the rail.
  it('reads pending for a claim that has only ever been unresolved', () => {
    const problem: Record<string, SurfaceClaimObservation> = {
      u1: { problem: { status: 'unresolved', detail: 'could not fetch' }, at: 1 },
    }
    expect(boundSteps(bindClaimSteps(railBody(steps), problem))[0]!.status).toBe('pending')
  })

  // A failed fetch says nothing about whether the world moved, so the last completed
  // lookup still governs the rail. Blanking it would report a change that did not
  // happen.
  it('keeps reading the last completed value when the latest attempt failed', () => {
    const stale: Record<string, SurfaceClaimObservation> = {
      u1: { value: 'landed', problem: { status: 'unresolved', detail: 'offline' }, at: 1 },
    }
    expect(boundSteps(bindClaimSteps(railBody(steps), stale))[0]!.status).toBe('done')
  })

  // A typo in `claim`, or a `done` the author forgot, must not render a green tick —
  // which is what leaving the authored status in place would do, silently.
  it('never reads done from a dangling claim id or a missing `done`', () => {
    const broken = [
      { label: 'typo', claim: 'u9', done: 'landed', status: 'done' },
      { label: 'no done', claim: 'u1', status: 'done' },
    ]
    expect(boundSteps(bindClaimSteps(railBody(broken), observed({ u1: 'landed' }))).map(s => s.status))
      .toEqual(['pending', 'pending'])
  })

  it('leaves an unbound step, and an unbound body, exactly as authored', () => {
    const plain = railBody([{ label: 'hand-written', status: 'active' }])
    const out = bindClaimSteps(plain, observed({ u1: 'landed' }))
    // Identity, not equality: an unbound body must cost the document store's
    // `JSON.stringify` storm guard nothing extra.
    expect(out).toBe(plain)
  })

  it('binds nothing into the record — the author\'s file keeps the author\'s statuses', () => {
    const body = railBody(steps)
    const s = surface({ body, claims: [CLAIM] }, {
      freshness: freshness({ claimObservations: observed({ u1: 'landed', u4: 'pending' }) }),
    })
    slateSurfaceFromCanonical(s, 'p1')
    expect(boundSteps(s.content.body).map(st => st.status)).toEqual([undefined, undefined])
  })
})

// THE CHAIN, again. The binding could be perfect and never reach the browser.
describe('a bound rail reaches Run.slate and the point routes alike', () => {
  const steps = [
    { label: 'U1', claim: 'u1', done: 'landed' },
    { label: 'U4', claim: 'u4', done: 'landed' },
  ]

  it('projects the host\'s statuses onto the client-facing surface', async () => {
    const store = new DocumentStore()
    store.upsertRun('run-1', makeRun())
    await seedRunSlate(store, 'run-1', [
      { id: 'roadmap', headline: 'Roadmap', body: railBody(steps), claims: [CLAIM] },
    ], 100)
    const id = store.surfaceForRunAlias('run-1', 'roadmap')!.id
    const before = store.getSurface(id)!
    store.loadSurfaces([{
      ...before,
      freshness: { ...before.freshness, claimObservations: observed({ u1: 'landed', u4: 'pending' }) },
    }])

    expect(boundSteps(store.getRun('run-1')!.slate![0]!.body).map(s => s.status))
      .toEqual(['done', 'pending'])
    // Two projections of ONE record. A card that says `done` through one door and
    // `pending` through the other is a card disagreeing with itself.
    expect(boundSteps(store.getSlatePoint('run-1', 'roadmap')!.content).map(s => s.status))
      .toEqual(['done', 'pending'])
  })
})
