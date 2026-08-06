// @vitest-environment node
//
// U3's service invariants. The plan's Execution note for this unit is "Build
// service invariants test-first; route and CLI layers should remain thin
// adapters", so this file is the specification and `routes.surfaces.test.ts` only
// proves the adapter carries it faithfully.
//
// Most of the file runs the service against an in-memory DocumentStore with NO
// sidecar attached, because that is the fastest way to pin validation and
// topology behaviour. The final block does the opposite deliberately: a real
// temp-dir sidecar, a real `SSEBroadcaster`, a real DocumentStore, and a real
// backend singleton, with nothing mocked between them — the plan's requirement
// for "at least one integration test exercising the real chain without mocking
// the layers that interact". Ordering claims (durable → install → emit → ack) are
// only worth anything when the layers are the real ones.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { DocumentStore } from '../../stores/document-store'
import { SurfaceSidecar } from '../../stores/surface-persistence'
import { acquireBackendSingleton } from '../../infra/lock'
import { SSEBroadcaster, SURFACE_BATCH_EVENT } from '../../api/sse'
import type { SurfaceBatch } from '../../stores/surfaces'
import { SurfaceService, type SurfaceCallContext, type SurfaceMutation, type SurfaceResult } from '../surface-service'
import { surfaceCapabilities, summarizeSurface, resolveContributors } from '../surface-context'
import type { Surface, SurfaceClaimValue, SurfacePrincipalRef } from '../../../domain/types'
import type { WitnessOutcome } from '../witness-registry'

const SPACE = 'spc-a'
const HUMAN: SurfacePrincipalRef = { kind: 'human', id: 'actor-1' }
const AGENT: SurfacePrincipalRef = { kind: 'session', id: 'sess-a' }

function ctx(over: Partial<SurfaceCallContext> = {}): SurfaceCallContext {
  return { actor: HUMAN, at: 1_000, ...over }
}

/** Deterministic ids, so a failing assertion names the Surface rather than a
 *  UUID. Sequence is per-service instance. */
function counterIds(prefix = 'sf'): () => string {
  let n = 0
  return () => `${prefix}-${++n}`
}

function unwrap<T>(r: SurfaceResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  return r.data
}

function err<T>(r: SurfaceResult<T>): NonNullable<Extract<SurfaceResult<T>, { ok: false }>['error']> {
  if (r.ok) throw new Error('expected an error, got ok')
  return r.error
}

interface Harness {
  docStore: DocumentStore
  svc: SurfaceService
  batches: SurfaceBatch[]
  create(headline: string, over?: Record<string, unknown>): Promise<Surface>
}

function harness(opts: ConstructorParameters<typeof SurfaceService>[1] = {}): Harness {
  const docStore = new DocumentStore()
  const batches: SurfaceBatch[] = []
  docStore.surfaceChanges.on('batch', (b: SurfaceBatch) => batches.push(b))
  const svc = new SurfaceService(docStore, { newId: counterIds(), ...opts })
  return {
    docStore,
    svc,
    batches,
    async create(headline, over = {}) {
      const r = await svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline }, ...over }, ctx())
      return unwrap(r).surfaces[0]!.surface
    },
  }
}

describe('create', () => {
  it('returns the canonical record, its revisions, provenance, and capabilities', async () => {
    const h = harness()
    const created = await h.create('first', { provenance: { runId: 'run-1', worktreeId: 'wt-1' } })
    expect(created.id).toBe('sf-1')
    expect(created.rev).toBe(1)
    expect(created.homeRev).toBe(1)
    expect(created.provenance).toEqual({ runId: 'run-1', worktreeId: 'wt-1' })
    const view = unwrap(h.svc.get('sf-1'))
    expect(view.capabilities.group).toBe(true)
    expect(view.capabilities.delete).toBe(true)
    expect(view.capabilities.restore).toBe(false)
    expect(view.capabilities.contentAuthority).toBe('canonical-direct')
  })

  it('gives an agent and a human identical canonical records for the same request, bar attribution', async () => {
    const a = harness()
    const b = harness()
    const body = { spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'same' } }
    const fromHuman = unwrap(await a.svc.create(body, ctx({ actor: HUMAN })))
    const fromAgent = unwrap(await b.svc.create(body, ctx({ actor: AGENT })))
    const human = fromHuman.surfaces[0]!.surface
    const agent = fromAgent.surfaces[0]!.surface
    // `author` is the ONE field that must differ, and it is derived from the
    // acting principal rather than taken from the body — see the create body's
    // rejection test below. Everything else is identical: no ownership gate, no
    // second-class agent record.
    expect(human.author).toBe('user')
    expect(agent.author).toBe('agent')
    const { author: _h, ...humanRest } = human
    const { author: _a, ...agentRest } = agent
    expect(agentRest).toEqual(humanRest)
    expect(fromAgent.surfaces[0]!.capabilities).toEqual(fromHuman.surfaces[0]!.capabilities)
    expect(fromAgent.topologyRev).toBe(fromHuman.topologyRev)
  })

  it('assigns a run compatibility alias when a run is declared', async () => {
    const h = harness()
    const created = await h.create('runful', { provenance: { runId: 'run-7' } })
    expect(created.aliases).toEqual([{ bucket: { kind: 'run', runId: 'run-7' }, localId: 'sf-1', visible: true }])
  })

  it('assigns the workspace-recovery alias when there is no source run', async () => {
    const h = harness()
    const created = await h.create('runless')
    expect(created.aliases).toEqual([{ bucket: { kind: 'workspace-recovery' }, localId: 'sf-1', visible: true }])
  })

  it.each([
    ['id', { id: 'sf-forged' }],
    ['rev', { rev: 99 }],
    ['homeRev', { homeRev: 99 }],
    ['createdAt', { createdAt: 5 }],
    ['amendedAt', { amendedAt: 5 }],
    ['freshness', { freshness: { phase: 'current', overdue: false } }],
    ['deleted', { deleted: { at: 1, formerHome: { kind: 'canvas', spaceId: SPACE }, disposition: 'delete-subtree' } }],
    ['aliases', { aliases: [] }],
    ['thread', { thread: { replies: [] } }],
    ['order', { order: 3 }],
  ])('rejects the host-owned field %s before persistence', async (field, extra) => {
    const h = harness()
    const r = await h.svc.create(
      { spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'x' }, ...extra },
      ctx(),
    )
    expect(err(r).code).toBe('invalid')
    expect(err(r).message).toContain(field)
    expect(h.docStore.getAllSurfaces()).toHaveLength(0)
  })

  it('rejects invalid A2UI before persistence', async () => {
    const h = harness()
    const r = await h.svc.create(
      { spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'x', body: { root: 'a' } } },
      ctx(),
    )
    expect(err(r).code).toBe('invalid')
    expect(err(r).message).toMatch(/A2UI/)
    expect(h.docStore.getAllSurfaces()).toHaveLength(0)
  })

  it('accepts valid A2UI from the bounded catalog', async () => {
    const h = harness()
    const created = await h.create('charted', {
      content: { headline: 'charted', body: { root: 'r', components: [{ component: 'Text', id: 'r', text: 'hi' }] } },
    })
    expect(created.content.body?.root).toBe('r')
  })

  it('refuses a caller-supplied source generation', async () => {
    const h = harness()
    const r = await h.svc.create({
      spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'x' },
      source: { adapter: 'slate-file', locator: '/a.json', generation: 9 },
    }, ctx())
    expect(err(r).message).toMatch(/generation is host-owned/)
  })

  it('refuses the recovery store as a home a caller can name', async () => {
    const h = harness()
    const r = await h.svc.create(
      { spaceId: SPACE, home: { kind: 'recovery', spaceId: SPACE }, content: { headline: 'x' } }, ctx(),
    )
    expect(err(r).code).toBe('invalid')
    expect(err(r).message).toMatch(/home.kind must be/)
  })
})

describe('update-content', () => {
  it('changes nothing and returns the current record on a stale revision', async () => {
    const h = harness()
    const created = await h.create('before')
    h.batches.length = 0
    const r = await h.svc.updateContent('sf-1', { headline: 'after', expectedRev: 99 }, ctx())
    expect(err(r).code).toBe('conflict')
    expect(err(r).current?.[0]).toEqual(created)
    expect(h.docStore.getSurface('sf-1')!.content.headline).toBe('before')
    expect(h.batches).toHaveLength(0)
  })

  it('applies a whitelisted change and bumps only the record revision', async () => {
    const h = harness()
    await h.create('before')
    const r = unwrap(await h.svc.updateContent('sf-1', { headline: 'after', expectedRev: 1 }, ctx({ at: 2_000 })))
    const next = r.surfaces[0]!.surface
    expect(next.content.headline).toBe('after')
    expect(next.rev).toBe(2)
    expect(next.homeRev).toBe(1)
    expect(r.baseTopologyRev).toBe(r.topologyRev)
  })

  it('clears body with an explicit null and leaves it alone when omitted', async () => {
    const h = harness()
    await h.create('x', {
      content: { headline: 'x', body: { root: 'r', components: [{ component: 'Text', id: 'r', text: 'hi' }] } },
    })
    const kept = unwrap(await h.svc.updateContent('sf-1', { headline: 'y', expectedRev: 1 }, ctx()))
    expect(kept.surfaces[0]!.surface.content.body).toBeDefined()
    const cleared = unwrap(await h.svc.updateContent('sf-1', { body: null, expectedRev: 2 }, ctx()))
    expect(cleared.surfaces[0]!.surface.content).not.toHaveProperty('body')
  })

  it('rejects a topology field smuggled into a content write', async () => {
    const h = harness()
    await h.create('x')
    const r = await h.svc.updateContent('sf-1', { home: { kind: 'canvas', spaceId: SPACE }, expectedRev: 1 }, ctx())
    expect(err(r).code).toBe('invalid')
    expect(err(r).message).toMatch(/home is topology/)
  })

  it('requires expectedRev', async () => {
    const h = harness()
    await h.create('x')
    expect(err(await h.svc.updateContent('sf-1', { headline: 'y' }, ctx())).message).toMatch(/expectedRev is required/)
  })
})

describe('claims (plan U1, R1)', () => {
  const claim = { id: 'u1', witness: 'unit-landed', params: { plan: 'docs/plans/x.md', unit: 'U1' }, locus: 'repo' }

  it('accepts a declaration on create and keeps `[]` distinct from absent', async () => {
    const h = harness()
    const declared = await h.create('declared', { content: { headline: 'declared', claims: [claim] } })
    const checked = await h.create('checked', { content: { headline: 'checked', claims: [] } })
    const silent = await h.create('silent')

    expect(declared.content.claims).toEqual([claim])
    // `[]` is the author saying they looked and found nothing witnessable; absent is
    // the author never having said. The two must not collapse into each other.
    expect(checked.content.claims).toEqual([])
    expect(silent.content).not.toHaveProperty('claims')
  })

  it('preserves claims through a headline-only content patch', async () => {
    const h = harness()
    await h.create('declared', { content: { headline: 'declared', claims: [claim] } })
    const patched = unwrap(await h.svc.updateContent('sf-1', { headline: 'renamed', expectedRev: 1 }, ctx()))
    // The whole reason the carry-forward exists: this endpoint takes a whitelist, so
    // omitting `claims` here means "unchanged", never "delete them".
    expect(patched.surfaces[0]!.surface.content.claims).toEqual([claim])
    expect(patched.surfaces[0]!.surface.content.headline).toBe('renamed')
  })

  it('replaces claims when they are named and clears them on an explicit null', async () => {
    const h = harness()
    await h.create('declared', { content: { headline: 'declared', claims: [claim] } })
    const replaced = unwrap(await h.svc.updateContent(
      'sf-1', { claims: [{ id: 'up', witness: 'http-status', params: { url: 'https://x.test' }, locus: 'infra' }], expectedRev: 1 }, ctx(),
    ))
    expect(replaced.surfaces[0]!.surface.content.claims)
      .toEqual([{ id: 'up', witness: 'http-status', params: { url: 'https://x.test' }, locus: 'infra' }])
    const emptied = unwrap(await h.svc.updateContent('sf-1', { claims: [], expectedRev: 2 }, ctx()))
    expect(emptied.surfaces[0]!.surface.content.claims).toEqual([])
    const cleared = unwrap(await h.svc.updateContent('sf-1', { claims: null, expectedRev: 3 }, ctx()))
    expect(cleared.surfaces[0]!.surface.content).not.toHaveProperty('claims')
  })

  it('REFUSES an oversized claims list whole rather than truncating it', async () => {
    const h = harness()
    const many = Array.from({ length: 33 }, (_, i) => ({ id: `c${i}`, witness: 'http-status', locus: 'infra' }))
    // Truncating would persist a Surface declaring fewer claims than its author sent,
    // and the caller would read back something it did not write with no way to tell
    // that from its own bug — the same argument the headline cap is documented with.
    const created = await h.svc.create(
      { spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'big', claims: many } }, ctx(),
    )
    expect(err(created).code).toBe('invalid')
    expect(err(created).message).toMatch(/more than 32 claims/)

    await h.create('ok')
    const patched = await h.svc.updateContent('sf-1', { claims: many, expectedRev: 1 }, ctx())
    expect(err(patched).message).toMatch(/more than 32 claims/)
    expect(h.docStore.getSurface('sf-1')!.rev).toBe(1)
  })

  it('names the claim it will not accept instead of dropping it in silence', async () => {
    const h = harness()
    await h.create('x')
    const cases: Array<[unknown, RegExp]> = [
      [{ id: 'u1', witness: 'unit-landed' }, /must declare a locus/],
      [{ id: 'u1', witness: 'unit-landed', locus: 'slate' }, /must declare a locus/],
      [{ id: 'u1', locus: 'repo' }, /needs a witness kind/],
      [{ witness: 'unit-landed', locus: 'repo' }, /needs a non-empty id/],
      [{ id: 'u1', witness: 'unit-landed', locus: 'repo', params: { nested: { a: 1 } } }, /must be a string, number, or boolean/],
      ['not an object', /a claim must be an object/],
      // The registry gate (U2's `validateClaim`, wired into the parser by U6). This
      // door REFUSES where the file door drops — same check, opposite disposition —
      // and the message has to name the kind, or a typo leaves the author with
      // nothing to look up.
      [{ id: 'u1', witness: 'unit-lands', locus: 'repo', params: { plan: 'docs/plans/x.md', unit: 'U1' } },
        /no such witness kind — this host implements unit-landed, http-status/],
      [{ id: 'u1', witness: 'unit-landed', locus: 'repo' }, /params\.plan must be a `docs\/plans\/<file>\.md` path/],
      [{ id: 'u1', witness: 'unit-landed', locus: 'infra', params: { plan: 'docs/plans/x.md', unit: 'U1' } },
        /this kind observes repo, not infra/],
    ]
    for (const [bad, expected] of cases) {
      const r = await h.svc.updateContent('sf-1', { claims: [bad], expectedRev: 1 }, ctx())
      expect(err(r).code).toBe('invalid')
      expect(err(r).message).toMatch(expected)
    }
    // Both claims are individually VALID here, deliberately: the registry gate above
    // runs per claim and would otherwise refuse the first one before the duplicate
    // check was ever reached, and this case exists to prove the duplicate check.
    const dup = await h.svc.updateContent('sf-1', {
      claims: [
        { id: 'u1', witness: 'unit-landed', locus: 'repo', params: { plan: 'docs/plans/x.md', unit: 'U1' } },
        { id: 'u1', witness: 'http-status', locus: 'infra', params: { url: 'https://x.test/' } },
      ],
      expectedRev: 1,
    }, ctx())
    expect(err(dup).message).toMatch(/declares "u1" twice/)
    expect(h.docStore.getSurface('sf-1')!.content).not.toHaveProperty('claims')
  })

  it('preserves claims through a successful rebuild', async () => {
    const h = harness()
    await h.create('declared', { content: { headline: 'declared', recipe: 'rebuild me', claims: [claim] } })
    await h.svc.enqueueRefresh('sf-1', { jobId: 'job-1' }, ctx({ at: 2_000 }))
    await h.svc.beginRefresh('sf-1', { jobId: 'job-1', expectedRev: h.docStore.getSurface('sf-1')!.rev }, ctx({ at: 2_100 }))
    // A worker restates the OUTPUT only — `parseStagedResult` cannot even express a
    // claims list — so the barrier has to carry the declaration itself.
    const done = unwrap(await h.svc.completeRefresh('sf-1', {
      jobId: 'job-1',
      expectedRev: h.docStore.getSurface('sf-1')!.rev,
      observedGeneration: 0,
      content: { headline: 'rebuilt' },
    }, ctx({ at: 3_000 })))
    expect(done.surfaces[0]!.surface.content.headline).toBe('rebuilt')
    expect(done.surfaces[0]!.surface.content.claims).toEqual([claim])
    expect(done.surfaces[0]!.surface.content.recipe).toEqual({ kind: 'agent', prompt: 'rebuild me' })
  })

  it('sorts params so reordering keys is not an edit', async () => {
    const h = harness()
    // A REAL witness kind with its required parameters present, plus two spare keys
    // whose order is what this asserts. `witness: 'w'` used to do here, and U6's
    // registry gate refuses it — a claim naming a kind this host does not implement
    // no longer reaches the record through this door at all.
    const params = { z: 1, a: 2, plan: 'docs/plans/x.md', unit: 'U1' }
    const a = await h.create('a', { content: { headline: 'a', claims: [{ id: 'c', witness: 'unit-landed', locus: 'repo', params }] } })
    const b = await h.create('b', {
      content: { headline: 'b', claims: [{ id: 'c', witness: 'unit-landed', locus: 'repo', params: { unit: 'U1', plan: 'docs/plans/x.md', a: 2, z: 1 } }] },
    })
    // Digests over content are what the refresh barrier compares, and the entry
    // watermark hashes the same structure — a key reorder must not read as a move.
    expect(JSON.stringify(a.content.claims)).toBe(JSON.stringify(b.content.claims))
  })
})

describe('witness results (plan U3, R8/R10/R11/R19)', () => {
  const repo = { id: 'u3', witness: 'unit-landed', params: { plan: 'docs/plans/p.md', unit: 'U3' }, locus: 'repo' as const }
  const infra = { id: 'up', witness: 'http-status', params: { url: 'https://x.test/' }, locus: 'infra' as const }

  const saw = (value: SurfaceClaimValue): WitnessOutcome => ({ status: 'value', value })
  const unresolved = (detail = 'could not fetch origin/main'): WitnessOutcome => ({ status: 'unresolved', detail })
  const broke = (detail = 'witness exceeded its budget'): WitnessOutcome => ({ status: 'failed', detail })

  /** A Surface carrying `claims`, plus a helper that records one outcome per claim. */
  function claimed(claims: unknown[], over: Record<string, unknown> = {}) {
    const h = harness()
    const record = (
      observations: Array<{ claimId: string; outcome: WitnessOutcome }>, at: number,
    ) => h.svc.recordWitnessResult('sf-1', { observations }, ctx({ at }))
    return {
      ...h,
      record,
      /** Seed then confirm: the first look can never MATCH (nothing was stored to
       *  match against), so a witnessed Surface always takes two runs. */
      async settle(observations: Array<{ claimId: string; outcome: WitnessOutcome }>) {
        await record(observations, 2_000)
        return record(observations, 3_000)
      },
      surface: () => h.docStore.getSurface('sf-1')!,
      ready: h.create('claimed', {
        content: { headline: 'claimed', ...over, claims },
      }),
    }
  }

  const staleFrom = (kind: string, key: string) => ({ kind: kind as never, key, detail: `${kind} moved`, at: 1_500 })

  it('stamps witnessedAt and clears the claim-derived stale reason when every value matches', async () => {
    const h = claimed([repo])
    await h.ready
    await h.svc.markPossiblyStale('sf-1', staleFrom('git-revision', 'sha-1'), ctx({ at: 1_500 }))
    expect(h.surface().freshness.phase).toBe('possibly-stale')

    // THE FIRST LOOK IS NOT A VERIFICATION. Nothing was stored, so there was nothing
    // the witness could have agreed with — stamping here would let a Surface be
    // "verified" against a value it invented one millisecond earlier.
    unwrap(await h.record([{ claimId: 'u3', outcome: saw('landed') }], 2_000))
    expect(h.surface().freshness.witnessedAt).toBeUndefined()
    expect(h.surface().freshness.claimObservations).toEqual({ u3: { value: 'landed', at: 2_000 } })
    expect(h.surface().freshness.phase).toBe('possibly-stale')

    unwrap(await h.record([{ claimId: 'u3', outcome: saw('landed') }], 3_000))
    const f = h.surface().freshness
    expect(f.witnessedAt).toBe(3_000)
    expect(f.phase).toBe('current')
    expect(f.overdue).toBe(false)
    expect(f).not.toHaveProperty('staleReason')
    // The observation itself did not MOVE, so its own timestamp did not either.
    expect(f.claimObservations).toEqual({ u3: { value: 'landed', at: 2_000 } })
  })

  it('leaves verifiedAt alone — the witness stamp is its own field (KTD7)', async () => {
    const h = claimed([repo])
    await h.ready
    // `observeSource` writes `verifiedAt` on creation and on every file save whose
    // watermark moved, so it already means "content last arrived or was rebuilt".
    // If a witness pass wrote it too, an author's save would reset the host's
    // claim-check deadline and no Surface could ever be honestly never-witnessed.
    const before = h.surface().freshness.verifiedAt
    await h.settle([{ claimId: 'u3', outcome: saw('landed') }])
    expect(h.surface().freshness.verifiedAt).toBe(before)
    expect(h.surface().freshness.witnessedAt).toBe(3_000)
  })

  it('counts a stored absence re-observed as still absent (covers AE1)', async () => {
    const h = claimed([infra])
    await h.ready
    // `null` is an absence a lookup COMPLETED and reported (R7) — the one absence
    // allowed to match. The three-valued outcome is what keeps this honest: a
    // witness that could not look reports `unresolved`, never `null`.
    unwrap(await h.settle([{ claimId: 'up', outcome: saw(null) }]))
    expect(h.surface().freshness.witnessedAt).toBe(3_000)
    expect(h.surface().freshness.claimObservations).toEqual({ up: { value: null, at: 2_000 } })
  })

  it('never advances witnessedAt on an unresolved or failed outcome (KTD8)', async () => {
    for (const outcome of [unresolved(), broke()]) {
      const h = claimed([repo])
      await h.ready
      await h.settle([{ claimId: 'u3', outcome: saw('landed') }])
      expect(h.surface().freshness.witnessedAt).toBe(3_000)

      unwrap(await h.record([{ claimId: 'u3', outcome }], 4_000))
      const f = h.surface().freshness
      // Not advanced, and — this is the half a two-valued contract would get wrong —
      // the last known value SURVIVES rather than being erased into a fake change.
      expect(f.witnessedAt).toBe(3_000)
      expect(f.claimObservations!.u3).toEqual({
        value: 'landed',
        problem: { status: outcome.status, detail: (outcome as { detail: string }).detail },
        at: 4_000,
      })
    }
  })

  it('never matches an unresolved outcome against a stored absence', async () => {
    const h = claimed([infra])
    await h.ready
    await h.settle([{ claimId: 'up', outcome: saw(null) }])
    unwrap(await h.record([{ claimId: 'up', outcome: unresolved('host unreachable') }], 4_000))
    // The exact failure KTD8 exists for: a witness broken for a week keeps agreeing
    // with its stored absence and keeps stamping the card verified.
    expect(h.surface().freshness.witnessedAt).toBe(3_000)
  })

  it('leaves a pending human-requested refresh entirely alone', async () => {
    const h = claimed([repo], { recipe: 'rebuild me' })
    await h.ready
    unwrap(await h.svc.enqueueRefresh('sf-1', { jobId: 'job-1' }, ctx({ at: 1_500 })))

    unwrap(await h.settle([{ claimId: 'u3', outcome: saw('landed') }]))
    const f = h.surface().freshness
    // Clearing `jobId` orphans the queued rebuild, and `dispatch` then cancels it
    // with "another refresh (none) took this Surface over" — so a deadline pass
    // would silently swallow a human pressing ⟳.
    expect(f.jobId).toBe('job-1')
    expect(f.phase).toBe('queued')
    expect(f.witnessedAt).toBe(3_000)
  })

  it('leaves a stale reason at a kind no claim observes', async () => {
    const h = claimed([infra])
    await h.ready
    // `infra` is only invalidated by time passing, so a commit on the worktree is
    // not something this Surface's witness can answer.
    await h.svc.markPossiblyStale('sf-1', staleFrom('git-revision', 'sha-1'), ctx({ at: 1_500 }))

    unwrap(await h.settle([{ claimId: 'up', outcome: saw(200) }]))
    const f = h.surface().freshness
    expect(f.staleReason).toMatchObject({ kind: 'git-revision', key: 'sha-1' })
    // And the phase does not contradict the reason still sitting on the record.
    expect(f.phase).toBe('possibly-stale')
    expect(f.witnessedAt).toBe(3_000)
    expect(f.overdue).toBe(false)
  })

  it('answers a periodic reason at either locus, because time invalidates both', async () => {
    for (const claim of [repo, infra]) {
      const h = claimed([claim])
      await h.ready
      await h.svc.markPossiblyStale('sf-1', staleFrom('periodic', 'due-1'), ctx({ at: 1_500 }))
      unwrap(await h.settle([{ claimId: claim.id, outcome: saw('x') }]))
      expect(h.surface().freshness).not.toHaveProperty('staleReason')
      expect(h.surface().freshness.phase).toBe('current')
    }
  })

  it('carries lastReasonKeys forward, so the next unchanged trigger re-stales nothing', async () => {
    const h = claimed([repo])
    await h.ready
    await h.svc.markPossiblyStale('sf-1', staleFrom('git-revision', 'sha-1'), ctx({ at: 1_500 }))
    unwrap(await h.settle([{ claimId: 'u3', outcome: saw('landed') }]))
    expect(h.surface().freshness.lastReasonKeys).toEqual({ 'git-revision': 'sha-1' })

    const revBefore = h.surface().rev
    const batchesBefore = h.batches.length
    // The measured incident behind the field: without the carry-forward the very
    // next poll of the same SHA re-stales what was just witnessed against it, and
    // each cycle launched a real background agent in the user's worktree.
    unwrap(await h.svc.markPossiblyStale('sf-1', staleFrom('git-revision', 'sha-1'), ctx({ at: 4_000 })))
    expect(h.surface().rev).toBe(revBefore)
    expect(h.surface().freshness.phase).toBe('current')
    expect(h.batches).toHaveLength(batchesBefore)
  })

  it('writes nothing when an unchanged observation is recorded twice', async () => {
    const h = claimed([repo])
    await h.ready
    unwrap(await h.record([{ claimId: 'u3', outcome: unresolved('no such remote') }], 2_000))
    const revBefore = h.surface().rev
    const batchesBefore = h.batches.length

    // The storm case, and the one the sweep actually produces: an unresolved claim
    // is retried on every deadline and nothing about it moves. Nothing stored here
    // records a mere LOOK, so a steady state reads as steady however long it lasts.
    unwrap(await h.record([{ claimId: 'u3', outcome: unresolved('no such remote') }], 9_000))
    unwrap(await h.record([{ claimId: 'u3', outcome: unresolved('no such remote') }], 99_000))
    expect(h.surface().rev).toBe(revBefore)
    expect(h.batches).toHaveLength(batchesBefore)
    expect(h.surface().freshness.claimObservations!.u3!.at).toBe(2_000)
  })

  it('writes once for a passing result recorded twice at the same instant', async () => {
    const h = claimed([repo])
    await h.ready
    await h.record([{ claimId: 'u3', outcome: saw('landed') }], 2_000)
    unwrap(await h.record([{ claimId: 'u3', outcome: saw('landed') }], 3_000))
    const revBefore = h.surface().rev
    const batchesBefore = h.batches.length

    unwrap(await h.record([{ claimId: 'u3', outcome: saw('landed') }], 3_000))
    expect(h.surface().rev).toBe(revBefore)
    expect(h.batches).toHaveLength(batchesBefore)
  })

  it('DOES write when a later pass moves the witness age, which is the product', async () => {
    const h = claimed([repo])
    await h.ready
    await h.settle([{ claimId: 'u3', outcome: saw('landed') }])
    const revBefore = h.surface().rev

    // Deliberately asserted, because the opposite is the tempting bug: freezing
    // `witnessedAt` would make every no-op run free, and would also make the card
    // report "witnessed six hours ago" one second after a passing check, and pin
    // `dueAt` to a deadline that has already passed — so the sweep would re-run the
    // witnesses forever. The write cadence here is the verification interval
    // (floored at a minute), not the five-second sweep.
    unwrap(await h.record([{ claimId: 'u3', outcome: saw('landed') }], 9_000))
    expect(h.surface().rev).toBe(revBefore + 1)
    expect(h.surface().freshness.witnessedAt).toBe(9_000)
  })

  it('records a partial run without stamping the Surface witnessed', async () => {
    const h = claimed([repo, infra])
    await h.ready
    await h.settle([{ claimId: 'u3', outcome: saw('landed') }, { claimId: 'up', outcome: saw(200) }])
    expect(h.surface().freshness.witnessedAt).toBe(3_000)

    // Only the repo claim re-run — a commit's locus. The infra claim was not
    // checked, so this run cannot say the Surface as a whole still holds.
    unwrap(await h.record([{ claimId: 'u3', outcome: saw('landed') }], 4_000))
    expect(h.surface().freshness.witnessedAt).toBe(3_000)
  })

  it('drops a result for a claim the author has since deleted, and prunes its value', async () => {
    const h = claimed([repo, infra])
    await h.ready
    await h.settle([{ claimId: 'u3', outcome: saw('landed') }, { claimId: 'up', outcome: saw(200) }])
    unwrap(await h.svc.updateContent('sf-1', { claims: [repo], expectedRev: h.surface().rev }, ctx({ at: 4_000 })))

    // The re-check the collect/run/commit split needs: witnesses were collected
    // against a declaration the author edited while they ran.
    unwrap(await h.record([
      { claimId: 'u3', outcome: saw('landed') }, { claimId: 'up', outcome: saw(500) },
    ], 5_000))
    expect(h.surface().freshness.claimObservations).toEqual({ u3: { value: 'landed', at: 2_000 } })
    expect(h.surface().freshness.witnessedAt).toBe(5_000)
  })

  it('records a moved value, its delta, and the rebuild debt in ONE commit (plan U4)', async () => {
    const h = claimed([repo], { recipe: 'rebuild me' })
    await h.ready
    await h.settle([{ claimId: 'u3', outcome: saw('landed') }])
    const rev = h.surface().rev

    unwrap(await h.record([{ claimId: 'u3', outcome: saw('pending') }], 4_000))
    const f = h.surface().freshness
    // ONE revision, not two. Splitting the new value from the debt it creates is how
    // a rebuild is lost: a host that stored `pending` and then died would compare the
    // world against `pending` on its next look, agree with itself, and stamp the card
    // witnessed with nothing owed.
    expect(h.surface().rev).toBe(rev + 1)
    expect(f.claimObservations).toEqual({ u3: { value: 'pending', at: 4_000 } })
    expect(f.claimRebuild).toEqual({ moves: [{ claimId: 'u3', from: 'landed', to: 'pending' }], at: 4_000 })
    expect(f.phase).toBe('possibly-stale')
    expect(f.staleReason).toMatchObject({
      kind: 'git-revision',
      detail: 'a claim it makes no longer holds: u3 was landed, now pending',
    })
    // R11 wants both values reported BEFORE any rebuild runs, and this mutator queues
    // nothing — three different callers reach it and none of them asked for an agent.
    expect(f.witnessedAt).toBe(3_000)
  })

  it('does not treat a FIRST look as a move', async () => {
    const h = claimed([repo], { recipe: 'rebuild me' })
    await h.ready
    unwrap(await h.record([{ claimId: 'u3', outcome: saw('landed') }], 2_000))
    // Nothing was stored to contradict. Counting this as a move would queue a rebuild
    // for every claim the moment its author wrote it.
    expect(h.surface().freshness).not.toHaveProperty('claimRebuild')
    expect(h.surface().freshness.phase).not.toBe('possibly-stale')
  })

  it('does not treat an unresolved outcome as a move', async () => {
    const h = claimed([repo], { recipe: 'rebuild me' })
    await h.ready
    await h.settle([{ claimId: 'u3', outcome: saw('landed') }])
    unwrap(await h.record([{ claimId: 'u3', outcome: unresolved('host unreachable') }], 4_000))
    // Nobody could look, so nothing was contradicted. A rebuild queued here would be
    // an agent woken by an outage.
    expect(h.surface().freshness).not.toHaveProperty('claimRebuild')
  })

  it('keeps a rebuild debt through every later pass that agrees with the new value', async () => {
    const h = claimed([repo], { recipe: 'rebuild me' })
    await h.ready
    await h.settle([{ claimId: 'u3', outcome: saw('landed') }])
    unwrap(await h.record([{ claimId: 'u3', outcome: saw('pending') }], 4_000))

    // From here the world and the record agree, so every look matches. Without the
    // marker the pass below would retire the badge for a change no rebuild consumed —
    // and a recipe-less Surface, which never gets one, would settle back to `current`
    // while its card still showed the old value.
    unwrap(await h.record([{ claimId: 'u3', outcome: saw('pending') }], 5_000))
    const f = h.surface().freshness
    expect(f.claimRebuild!.moves).toEqual([{ claimId: 'u3', from: 'landed', to: 'pending' }])
    expect(f.phase).toBe('possibly-stale')
    expect(f.staleReason).toBeDefined()
    // The host DID look and was not contradicted, and that much is still recorded.
    expect(f.witnessedAt).toBe(5_000)
  })

  it('refuses to stamp a Surface that declares no claims', async () => {
    const h = harness()
    await h.create('silent')
    await h.create('checked', { content: { headline: 'checked', claims: [] } })
    for (const id of ['sf-1', 'sf-2']) {
      const r = await h.svc.recordWitnessResult(id, { observations: [{ claimId: 'u3', outcome: saw('landed') }] }, ctx())
      // `unwitnessed` has to be UNREACHABLE from the witness path, not merely
      // unwritten — one stray call would otherwise have a claimless Surface
      // asserting a verification that never happened.
      expect(err(r).code).toBe('invalid')
      expect(err(r).message).toMatch(/declares no claims/)
      expect(h.docStore.getSurface(id)!.freshness).not.toHaveProperty('witnessedAt')
    }
    expect(err(await h.svc.recordWitnessResult('sf-99', { observations: [] }, ctx())).code).toBe('not-found')
  })

  it('is not settable through the content-update path', async () => {
    const h = claimed([repo])
    await h.ready
    const rev = () => h.surface().rev

    // Host-owned, and blocked on every operation rather than on this one.
    const viaFreshness = await h.svc.updateContent(
      'sf-1', { freshness: { phase: 'current', overdue: false, witnessedAt: 9_000 }, expectedRev: rev() }, ctx(),
    )
    expect(err(viaFreshness).code).toBe('invalid')
    expect(err(viaFreshness).message).toMatch(/freshness is host-owned/)

    // And smuggling a value onto the DECLARATION does not work either: the claim
    // parser is a whitelist, so the observed value is simply not a thing an author
    // can write. This is KTD2's split enforced from the ingress side — and the
    // refusal is `no-change`, which is the strongest form of the claim: the smuggled
    // keys did not merely fail to reach `freshness`, they did not survive the parse
    // at all, so the record the request would produce is the one already stored.
    const smuggled = await h.svc.updateContent('sf-1', {
      claims: [{ ...repo, value: 'landed', observedAt: 9_000 }], expectedRev: rev(),
    }, ctx({ at: 4_000 }))
    expect(err(smuggled).reason).toBe('no-change')
    expect(h.surface().content.claims).toEqual([repo])
    expect(h.surface().freshness).not.toHaveProperty('witnessedAt')
    expect(h.surface().freshness).not.toHaveProperty('claimObservations')
  })
})

describe('content authority (KTD4)', () => {
  const sourceBound = {
    source: { adapter: 'slate-file', locator: '/w/.tinstar/slate/a.json' },
    contentAuthority: 'source-binding',
  }

  it('refuses a direct write to source-bound content when no adapter is registered', async () => {
    const h = harness()
    await h.create('file-owned', sourceBound)
    const r = await h.svc.updateContent('sf-1', { headline: 'hand-edited', expectedRev: 1 }, ctx())
    expect(err(r).code).toBe('conflict')
    expect(err(r).reason).toBe('content-authority')
    expect(err(r).message).toMatch(/transfer-content-authority/)
    expect(h.docStore.getSurface('sf-1')!.content.headline).toBe('file-owned')
  })

  it('routes a source-bound write through the adapter and persists its watermark', async () => {
    const seen: unknown[] = []
    const h = harness({
      sourceAdapters: {
        'slate-file': {
          async write(input) { seen.push(input.expectedWatermark); return { ok: true, watermark: 'sha-new' } },
        },
      },
    })
    await h.create('file-owned', { ...sourceBound, source: { ...sourceBound.source, watermark: 'sha-old' } })
    const r = unwrap(await h.svc.updateContent(
      'sf-1', { headline: 'via adapter', expectedRev: 1, expectedWatermark: 'sha-old' }, ctx(),
    ))
    expect(seen).toEqual(['sha-old'])
    expect(r.surfaces[0]!.surface.source?.watermark).toBe('sha-new')
    expect(r.surfaces[0]!.surface.content.headline).toBe('via adapter')
  })

  it('persists nothing when the adapter refuses the source write', async () => {
    const h = harness({
      sourceAdapters: { 'slate-file': { async write() { return { ok: false, message: 'source moved' } } } },
    })
    await h.create('file-owned', sourceBound)
    const r = await h.svc.updateContent('sf-1', { headline: 'nope', expectedRev: 1 }, ctx())
    expect(err(r).message).toBe('source moved')
    expect(h.docStore.getSurface('sf-1')!.content.headline).toBe('file-owned')
    expect(h.docStore.getSurface('sf-1')!.rev).toBe(1)
  })

  it('transfers authority explicitly, behind a revision check, and then allows the write', async () => {
    const h = harness()
    await h.create('file-owned', sourceBound)
    expect(err(await h.svc.transferContentAuthority('sf-1', { to: 'canonical-direct', expectedRev: 9 }, ctx())).code)
      .toBe('conflict')
    const moved = unwrap(await h.svc.transferContentAuthority('sf-1', { to: 'canonical-direct', expectedRev: 1 }, ctx()))
    expect(moved.surfaces[0]!.surface.contentAuthority).toBe('canonical-direct')
    // The binding SURVIVES the transfer — that is exactly KTD4's
    // divergence-reporting case, not a leftover.
    expect(moved.surfaces[0]!.surface.source?.adapter).toBe('slate-file')
    const written = unwrap(await h.svc.updateContent('sf-1', { headline: 'now mine', expectedRev: 2 }, ctx()))
    expect(written.surfaces[0]!.surface.content.headline).toBe('now mine')
  })

  it('refuses to hand authority to a source binding that does not exist', async () => {
    const h = harness()
    await h.create('plain')
    const r = await h.svc.transferContentAuthority('sf-1', { to: 'source-binding', expectedRev: 1 }, ctx())
    expect(err(r).code).toBe('invalid')
  })
})

describe('append-thread', () => {
  it('persists the reply and re-derives the discussion status', async () => {
    const h = harness()
    await h.create('question')
    const r = unwrap(await h.svc.appendThread('sf-1', { text: '  needs a decision  ' }, ctx({ at: 5_000 })))
    const next = r.surfaces[0]!.surface
    expect(next.thread.replies).toHaveLength(1)
    expect(next.thread.replies[0]!.text).toBe('needs a decision')
    expect(next.thread.replies[0]!.author).toBe('user')
    expect(next.thread.status).toBe('waiting')
  })

  it('defaults the author from the actor kind', async () => {
    const h = harness()
    await h.create('question')
    const r = unwrap(await h.svc.appendThread('sf-1', { text: 'on it' }, ctx({ actor: AGENT })))
    expect(r.surfaces[0]!.surface.thread.replies[0]!.author).toBe('agent')
    expect(r.surfaces[0]!.surface.thread.status).toBe('discussing')
  })

  it('rejects empty text', async () => {
    const h = harness()
    await h.create('q')
    expect(err(await h.svc.appendThread('sf-1', { text: '   ' }, ctx())).code).toBe('invalid')
  })
})

describe('group', () => {
  it('creates one parent and reparents every child in ONE batch', async () => {
    const h = harness()
    await h.create('a'); await h.create('b'); await h.create('c')
    h.batches.length = 0
    const r = unwrap(await h.svc.group({ childIds: ['sf-1', 'sf-2'], content: { headline: 'group' } }, ctx()))
    expect(h.batches).toHaveLength(1)
    const batch = h.batches[0]!
    expect(batch.changes.map(c => c.id)).toEqual(['sf-4', 'sf-1', 'sf-2'])
    expect(batch.baseTopologyRev).toBe(3)
    expect(batch.topologyRev).toBe(4)
    expect(r.surfaces).toHaveLength(3)
    expect(h.docStore.getSurfaceChildren('sf-4').map(s => s.id)).toEqual(['sf-1', 'sf-2'])
    // The untouched sibling stayed a root.
    expect(h.docStore.getSurfaceRoots(SPACE).map(s => s.id)).toEqual(['sf-3', 'sf-4'])
  })

  it('preserves each child\'s identity, thread, provenance, freshness, and source binding', async () => {
    const h = harness()
    await h.create('a', {
      provenance: { runId: 'run-1', worktreeId: 'wt-1' },
      source: { adapter: 'slate-file', locator: '/a.json', watermark: 'sha-1' },
    })
    await h.svc.appendThread('sf-1', { text: 'hello' }, ctx())
    const before = h.docStore.getSurface('sf-1')!
    unwrap(await h.svc.group({ childIds: ['sf-1'], content: { headline: 'g' } }, ctx()))
    const after = h.docStore.getSurface('sf-1')!
    expect(after.id).toBe(before.id)
    expect(after.thread).toEqual(before.thread)
    expect(after.provenance).toEqual(before.provenance)
    expect(after.freshness).toEqual(before.freshness)
    expect(after.source).toEqual(before.source)
    expect(after.aliases).toEqual(before.aliases)
    expect(after.home).toEqual({ kind: 'surface', surfaceId: 'sf-2' })
  })

  it.each([
    ['an unknown child', { childIds: ['sf-1', 'ghost'] }, 'unknown-surface'],
    ['children that do not share a home', { childIds: ['sf-1', 'sf-2'] }, 'mixed-home'],
    ['a stale topology revision', { childIds: ['sf-1'], expectedTopologyRev: 1 }, 'stale-topology-revision'],
    ['a stale child revision', { childIds: ['sf-1'], expectedRevs: { 'sf-1': 42 } }, 'stale-surface-revision'],
  ])('leaves no parent and moves no child for %s', async (_label, extra, reason) => {
    const h = harness()
    await h.create('a'); await h.create('b')
    unwrap(await h.svc.group({ childIds: ['sf-2'], content: { headline: 'existing' } }, ctx()))
    await h.svc.create({ spaceId: SPACE, home: { kind: 'surface', surfaceId: 'sf-3' }, content: { headline: 'nested' } }, ctx())
    const before = h.docStore.getAllSurfaces().map(s => ({ ...s }))
    h.batches.length = 0

    const r = await h.svc.group({ content: { headline: 'attempt' }, ...extra } as Record<string, unknown>, ctx())
    expect(err(r).reason).toBe(reason)
    expect(h.docStore.getAllSurfaces()).toEqual(before)
    expect(h.batches).toHaveLength(0)
  })

  it('refuses a cross-space parent by refusing a cross-space child set', async () => {
    const h = harness()
    await h.create('a')
    await h.svc.create({ spaceId: 'spc-b', home: { kind: 'canvas', spaceId: 'spc-b' }, content: { headline: 'other' } }, ctx())
    const r = await h.svc.group({ childIds: ['sf-1', 'sf-2'], content: { headline: 'x' } }, ctx())
    expect(err(r).reason).toBe('cross-space')
    expect(h.docStore.getAllSurfaces()).toHaveLength(2)
  })
})

describe('reparent and ungroup', () => {
  it('rejects a cycle and leaves the tree untouched', async () => {
    const h = harness()
    await h.create('parent')
    await h.svc.create({ spaceId: SPACE, home: { kind: 'surface', surfaceId: 'sf-1' }, content: { headline: 'child' } }, ctx())
    const before = h.docStore.getAllSurfaces().map(s => ({ ...s }))
    const r = await h.svc.reparent({ ids: ['sf-1'], home: { kind: 'surface', surfaceId: 'sf-2' } }, ctx())
    expect(err(r).reason).toBe('cycle')
    expect(h.docStore.getAllSurfaces()).toEqual(before)
  })

  it('lets an agent move a human-arranged Surface directly, in one atomic batch', async () => {
    // The ratified decision: arrangement carries NO ownership gate. A human
    // arranged this; an agent moves it; nothing asks permission.
    const h = harness()
    // Authored BY the human — which is now stated by calling as the human, not by
    // putting `author: 'user'` in a body anyone could send.
    unwrap(await h.svc.create(
      {
        spaceId: SPACE,
        home: { kind: 'canvas', spaceId: SPACE },
        content: { headline: 'human work' },
        owner: { kind: 'human', id: 'actor-1' },
      },
      ctx({ actor: HUMAN }),
    ))
    await h.create('agent box')
    h.batches.length = 0
    const r = unwrap(await h.svc.reparent(
      { ids: ['sf-1'], home: { kind: 'surface', surfaceId: 'sf-2' } }, ctx({ actor: AGENT }),
    ))
    expect(r.surfaces).toHaveLength(1)
    expect(h.batches).toHaveLength(1)
    expect(h.docStore.getSurfaceChildren('sf-2').map(s => s.id)).toEqual(['sf-1'])
  })

  it('lets an agent reorganize its own unarranged Surfaces', async () => {
    const h = harness()
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'a' } }, ctx({ actor: AGENT }))
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'b' } }, ctx({ actor: AGENT }))
    const r = unwrap(await h.svc.group({ childIds: ['sf-1', 'sf-2'], content: { headline: 'mine' } }, ctx({ actor: AGENT })))
    expect(r.surfaces.map(s => s.surface.id)).toEqual(['sf-3', 'sf-1', 'sf-2'])
  })

  it('ungroup returns children to the former parent\'s home and preserves identity', async () => {
    const h = harness()
    await h.create('a'); await h.create('b')
    unwrap(await h.svc.group({ childIds: ['sf-1', 'sf-2'], content: { headline: 'box' } }, ctx()))
    const threadBefore = h.docStore.getSurface('sf-1')!.thread
    h.batches.length = 0

    const r = unwrap(await h.svc.ungroup('sf-3', {}, ctx()))
    expect(h.batches).toHaveLength(1)
    expect(h.docStore.getSurface('sf-1')!.home).toEqual({ kind: 'canvas', spaceId: SPACE })
    expect(h.docStore.getSurface('sf-2')!.home).toEqual({ kind: 'canvas', spaceId: SPACE })
    expect(h.docStore.getSurface('sf-1')!.thread).toEqual(threadBefore)
    // The dissolved box is recoverable rather than gone.
    expect(h.docStore.getSurface('sf-3')!.home).toEqual({ kind: 'recovery', spaceId: SPACE })
    expect(r.op).toBe('ungroup')
  })
})

describe('recoverable deletion (KTD15)', () => {
  async function tree(): Promise<Harness> {
    const h = harness()
    await h.create('root')
    await h.svc.create({ spaceId: SPACE, home: { kind: 'surface', surfaceId: 'sf-1' }, content: { headline: 'kid-a' } }, ctx())
    await h.svc.create({ spaceId: SPACE, home: { kind: 'surface', surfaceId: 'sf-2' }, content: { headline: 'grandkid' } }, ctx())
    return h
  }

  it('deletes a leaf directly, with no disposition needed', async () => {
    const h = harness()
    await h.create('leaf')
    const r = unwrap(await h.svc.delete('sf-1', {}, ctx({ at: 7_000 })))
    const deleted = r.surfaces[0]!.surface
    expect(deleted.home).toEqual({ kind: 'recovery', spaceId: SPACE })
    expect(deleted.deleted).toEqual({
      at: 7_000, by: HUMAN, formerHome: { kind: 'canvas', spaceId: SPACE }, disposition: 'delete-subtree',
    })
    expect(h.docStore.getSurfaceRoots(SPACE)).toHaveLength(0)
    expect(h.docStore.getSurfaceRecoveryRoots(SPACE).map(s => s.id)).toEqual(['sf-1'])
  })

  it('requires the exact displayed descendant set and a disposition for a non-empty parent', async () => {
    const h = await tree()
    const noDisposition = await h.svc.delete('sf-1', { descendants: ['sf-2', 'sf-3'] }, ctx())
    expect(err(noDisposition).reason).toBe('descendant-mismatch')

    const wrongSet = await h.svc.delete('sf-1', { descendants: ['sf-2'], disposition: 'delete-subtree' }, ctx())
    expect(err(wrongSet).reason).toBe('descendant-mismatch')
    expect(err(wrongSet).message).toContain('sf-2, sf-3')

    expect(h.docStore.getSurface('sf-1')!.home).toEqual({ kind: 'canvas', spaceId: SPACE })
  })

  it('subtree deletion removes exactly the approved set from the live tree', async () => {
    const h = await tree()
    unwrap(await h.svc.delete('sf-1', { descendants: ['sf-2', 'sf-3'], disposition: 'delete-subtree' }, ctx()))
    expect(h.docStore.getSurfaceRoots(SPACE)).toHaveLength(0)
    // Descendants keep their own homes; the subtree stays assembled inside the
    // recovery store rather than being flattened into it.
    expect(h.docStore.getSurface('sf-2')!.home).toEqual({ kind: 'surface', surfaceId: 'sf-1' })
    expect(h.docStore.getSurface('sf-3')!.home).toEqual({ kind: 'surface', surfaceId: 'sf-2' })
    expect(h.docStore.surfaceRecoveryRootFor('sf-3')!.id).toBe('sf-1')
  })

  it('reparent-children deletion preserves every child record', async () => {
    const h = await tree()
    const r = unwrap(await h.svc.delete(
      'sf-1', { descendants: ['sf-2', 'sf-3'], disposition: 'reparent-children' }, ctx(),
    ))
    expect(r.surfaces.map(s => s.surface.id)).toEqual(['sf-2', 'sf-1'])
    expect(h.docStore.getSurface('sf-2')!.home).toEqual({ kind: 'canvas', spaceId: SPACE })
    // The grandchild rode along under its own parent, untouched.
    expect(h.docStore.getSurface('sf-3')!.home).toEqual({ kind: 'surface', surfaceId: 'sf-2' })
    expect(h.docStore.getSurface('sf-3')!.rev).toBe(1)
    expect(h.docStore.getSurfaceRoots(SPACE).map(s => s.id)).toEqual(['sf-2'])
  })

  it('restores a subtree with identity, thread, provenance, and former home intact', async () => {
    const h = await tree()
    await h.svc.appendThread('sf-2', { text: 'keep me' }, ctx())
    const before = h.docStore.getSurface('sf-2')!
    unwrap(await h.svc.delete('sf-1', { descendants: ['sf-2', 'sf-3'], disposition: 'delete-subtree' }, ctx()))

    const r = unwrap(await h.svc.restore('sf-1', {}, ctx()))
    const restored = r.surfaces[0]!.surface
    expect(restored.home).toEqual({ kind: 'canvas', spaceId: SPACE })
    expect(restored).not.toHaveProperty('deleted')
    expect(h.docStore.getSurface('sf-2')).toEqual(before)
    expect(h.docStore.getSurfaceRoots(SPACE).map(s => s.id)).toEqual(['sf-1'])
    expect(h.docStore.getSurfaceRecoveryRoots(SPACE)).toHaveLength(0)
  })

  it('restores into the workspace recovery bucket when the former home is gone', async () => {
    const h = await tree()
    // Delete the child first, then its parent: two independent recovery roots.
    unwrap(await h.svc.delete('sf-2', { descendants: ['sf-3'], disposition: 'delete-subtree' }, ctx()))
    unwrap(await h.svc.delete('sf-1', {}, ctx()))
    unwrap(await h.svc.purge('sf-1', {}, ctx()))

    const r = unwrap(await h.svc.restore('sf-2', {}, ctx()))
    const restored = r.surfaces[0]!.surface
    expect(restored.home).toEqual({ kind: 'canvas', spaceId: SPACE })
    expect(restored.aliases).toContainEqual({ bucket: { kind: 'workspace-recovery' }, localId: 'sf-2', visible: true })
    expect(h.docStore.getSurface('sf-3')!.home).toEqual({ kind: 'surface', surfaceId: 'sf-2' })
  })

  it('a nested delete does not resurrect the separately-deleted child', async () => {
    const h = await tree()
    unwrap(await h.svc.delete('sf-3', {}, ctx()))
    unwrap(await h.svc.delete('sf-1', { descendants: ['sf-2'], disposition: 'delete-subtree' }, ctx()))
    unwrap(await h.svc.restore('sf-1', {}, ctx()))
    expect(h.docStore.surfaceRecoveryRootFor('sf-1')).toBeUndefined()
    expect(h.docStore.surfaceRecoveryRootFor('sf-2')).toBeUndefined()
    expect(h.docStore.surfaceRecoveryRootFor('sf-3')!.id).toBe('sf-3')
  })

  it('refuses to arrange or edit a Surface while it is in the recovery store', async () => {
    const h = await tree()
    unwrap(await h.svc.delete('sf-1', { descendants: ['sf-2', 'sf-3'], disposition: 'delete-subtree' }, ctx()))
    expect(err(await h.svc.updateContent('sf-1', { headline: 'x', expectedRev: 2 }, ctx())).reason).toBe('deleted')
    expect(err(await h.svc.appendThread('sf-2', { text: 'x' }, ctx())).reason).toBe('deleted')
    expect(err(await h.svc.reparent({ ids: ['sf-2'], home: { kind: 'canvas', spaceId: SPACE } }, ctx())).reason).toBe('deleted')
    expect(err(await h.svc.group({ childIds: ['sf-2'], content: { headline: 'x' } }, ctx())).reason).toBe('deleted')
    const view = unwrap(h.svc.get('sf-2'))
    expect(view.capabilities.reparent).toBe(false)
    expect(view.capabilities.restore).toBe(false)
    expect(unwrap(h.svc.get('sf-1')).capabilities.restore).toBe(true)
  })

  it('refuses to home a live Surface under something in the recovery store', async () => {
    const h = await tree()
    await h.create('outsider')
    unwrap(await h.svc.delete('sf-1', { descendants: ['sf-2', 'sf-3'], disposition: 'delete-subtree' }, ctx()))
    const r = await h.svc.reparent({ ids: ['sf-4'], home: { kind: 'surface', surfaceId: 'sf-2' } }, ctx())
    expect(err(r).reason).toBe('deleted')
    expect(h.docStore.getSurface('sf-4')!.home).toEqual({ kind: 'canvas', spaceId: SPACE })
  })

  it('purge erases the subtree and is refused for anything not already deleted', async () => {
    const h = await tree()
    expect(err(await h.svc.purge('sf-1', {}, ctx())).reason).toBe('not-deleted')
    unwrap(await h.svc.delete('sf-1', { descendants: ['sf-2', 'sf-3'], disposition: 'delete-subtree' }, ctx()))
    h.batches.length = 0
    // Naming the descendant set is REQUIRED: purge is irreversible, so it must not
    // be able to erase more than the caller agreed to.
    expect(err(await h.svc.purge('sf-1', {}, ctx())).reason).toBe('descendant-mismatch')
    const r = unwrap(await h.svc.purge('sf-1', { descendants: ['sf-2', 'sf-3'] }, ctx()))
    expect(r.purged).toEqual(['sf-1', 'sf-2', 'sf-3'])
    expect(h.docStore.getAllSurfaces()).toHaveLength(0)
    expect(h.batches[0]!.deletes).toEqual(['sf-1', 'sf-2', 'sf-3'])
  })

  it('lists deleted records only when asked, but always reports that they exist', async () => {
    const h = await tree()
    unwrap(await h.svc.delete('sf-1', { descendants: ['sf-2', 'sf-3'], disposition: 'delete-subtree' }, ctx()))
    const plain = unwrap(h.svc.list({ spaceId: SPACE }))
    expect(plain.surfaces).toHaveLength(0)
    expect(plain.recoveryIds).toEqual(['sf-1'])
    const all = unwrap(h.svc.list({ spaceId: SPACE, includeDeleted: true }))
    expect(all.surfaces).toHaveLength(3)
  })
})

// THE SERVICE NO LONGER HAS A `refreshRequest` MUTATOR (plan U5, KTD4).
//
// It moved `current → queued` at a human's request and REFUSED when a refresh was
// already in flight — semantics R14 reverses, because a second ask now joins the
// attempt rather than conflicting with it. Two mutators that both queue a refresh,
// disagreeing about the busy case, is exactly the duplicate entry point the plan
// forbids. `enqueueRefresh` is the one that remains, and the coordinator's
// `humanIntent` is the only thing that calls it.
describe('enqueue-refresh — the one queueing transition', () => {
  it('queues a Surface and reports whether the host can rebuild it unattended', async () => {
    const h = harness()
    await h.create('needs a rebuild', {
      content: { headline: 'needs a rebuild', recipe: { kind: 'agent', prompt: 'run the suite' } },
    })
    const r = unwrap(await h.svc.enqueueRefresh('sf-1', { jobId: 'job-1' }, ctx()))
    expect(r.surfaces[0]!.surface.freshness.phase).toBe('queued')
    expect(r.surfaces[0]!.capabilities.refreshRecipe).toBe(true)
  })

  it('accepts a Surface with no recipe but says it is a nudge', async () => {
    const h = harness()
    await h.create('no recipe')
    const r = unwrap(await h.svc.enqueueRefresh('sf-1', { jobId: 'job-1' }, ctx()))
    expect(r.surfaces[0]!.surface.freshness.phase).toBe('queued')
    expect(r.surfaces[0]!.capabilities.refreshRecipe).toBe(false)
  })

  it('carries an overdue flag through the transition rather than clearing it', async () => {
    const h = harness()
    await h.create('late')
    const surface = h.docStore.getSurface('sf-1')!
    await h.docStore.commitSurfaceContent({ ...surface, freshness: { phase: 'current', overdue: true }, rev: 2 })
    const r = unwrap(await h.svc.enqueueRefresh('sf-1', { jobId: 'job-1' }, ctx()))
    expect(r.surfaces[0]!.surface.freshness).toMatchObject({ phase: 'queued', overdue: true })
  })

  it('says a refresh is available even while one is in flight, because a second ask JOINS it', async () => {
    // The capability used to report `refresh: false` here, which disabled the
    // control whose behaviour R14 now defines. A capability that lies is worse than
    // an absent one: the caller has no reason to check.
    const h = harness()
    const created = await h.create('busy')
    await h.svc.enqueueRefresh('sf-1', { jobId: 'job-1' }, ctx())
    await h.svc.beginRefresh('sf-1', { jobId: 'job-1', expectedRev: h.docStore.getSurface('sf-1')!.rev }, ctx())
    expect(h.docStore.getSurface('sf-1')!.freshness.phase).toBe('refreshing')
    expect(unwrap(h.svc.get(created.id)).capabilities.refresh).toBe(true)
  })
})

describe('get-context and contributors', () => {
  it('carries ancestors root-first, immediate children only, and a descendant count', async () => {
    const h = harness()
    await h.create('root')
    await h.svc.create({ spaceId: SPACE, home: { kind: 'surface', surfaceId: 'sf-1' }, content: { headline: 'mid' } }, ctx())
    await h.svc.create({ spaceId: SPACE, home: { kind: 'surface', surfaceId: 'sf-2' }, content: { headline: 'leaf' } }, ctx())
    await h.svc.create({ spaceId: SPACE, home: { kind: 'surface', surfaceId: 'sf-3' }, content: { headline: 'deep' } }, ctx())

    const c = unwrap(h.svc.context('sf-2', ctx()))
    expect(c.ancestors.map(a => a.id)).toEqual(['sf-1'])
    expect(c.children.map(a => a.id)).toEqual(['sf-3'])
    expect(c.children[0]!.childCount).toBe(1)
    expect(c.descendantCount).toBe(2)
    expect(c.topologyRev).toBe(4)
  })

  it('withholds authored content outside the caller\'s worktree scope but still lists the child', async () => {
    const h = harness()
    await h.create('parent')
    await h.svc.create({
      spaceId: SPACE, home: { kind: 'surface', surfaceId: 'sf-1' },
      content: { headline: 'secret work' }, provenance: { worktreeId: 'wt-other' },
    }, ctx())
    const c = unwrap(h.svc.context('sf-1', ctx({ scope: { worktreeIds: ['wt-mine'] } })))
    expect(c.children).toHaveLength(1)
    expect(c.children[0]!.accessible).toBe(false)
    expect(c.children[0]!.headline).toBe('')
    expect(c.children[0]!.withheld).toContain('wt-other')
  })

  it('resolves a live session to a terminal, a retired one to Graveyard, and a source to evidence', async () => {
    const h = harness({
      probe: {
        isLiveSession: name => name === 'sess-live',
        hasGraveyardRecord: name => name === 'sess-dead',
      },
    })
    await h.create('live', { owner: { kind: 'session', id: 'sess-live' } })
    await h.create('dead', { owner: { kind: 'session', id: 'sess-dead' } })
    await h.create('filed', { source: { adapter: 'slate-file', locator: '/a.json' } })

    const live = unwrap(h.svc.contributors('sf-1')).contributors
    expect(live[0]!.resolution).toBe('live-session')
    expect(live[0]!.terminal).toBe(true)

    const dead = unwrap(h.svc.contributors('sf-2')).contributors
    expect(dead[0]!.resolution).toBe('graveyard')
    expect(dead[0]!.terminal).toBe(false)

    const filed = unwrap(h.svc.contributors('sf-3')).contributors
    expect(filed).toHaveLength(1)
    expect(filed[0]!.role).toBe('source')
    expect(filed[0]!.resolution).toBe('process-evidence')
    expect(filed[0]!.terminal).toBe(false)
    expect(filed[0]!.evidence?.source).toBe('/a.json')
  })

  it('reports an owner whose session is gone entirely as unavailable, with no terminal', async () => {
    const h = harness()
    await h.create('orphan', { owner: { kind: 'session', id: 'sess-vanished' } })
    const [contributor] = unwrap(h.svc.contributors('sf-1')).contributors
    expect(contributor!.resolution).toBe('unavailable')
    expect(contributor!.terminal).toBe(false)
  })

  it('deduplicates a principal that is both owner and provenance session', async () => {
    const h = harness()
    await h.create('one', { owner: { kind: 'session', id: 'sess-a' }, provenance: { sessionId: 'sess-a' } })
    expect(unwrap(h.svc.contributors('sf-1')).contributors).toHaveLength(1)
  })
})

describe('pure helpers', () => {
  const base: Surface = {
    id: 'sf-x', spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE },
    content: { headline: 'h' }, contentAuthority: 'canonical-direct', author: 'agent',
    thread: { replies: [], status: 'open' }, freshness: { phase: 'current', overdue: false },
    rev: 1, homeRev: 1, createdAt: 1, amendedAt: 1,
  }

  it('names a reason for every capability it turns off', () => {
    const caps = surfaceCapabilities(
      { ...base, contentAuthority: 'source-binding', source: { adapter: 'slate-file', locator: '/a', generation: 0 } },
      { deleted: false, recoveryRoot: false, sourceAdapterAvailable: false },
    )
    expect(caps.updateContent).toBe(false)
    expect(caps.blocked?.updateContent).toMatch(/transfer authority/)
  })

  it('summarizes without inlining the body', () => {
    const summary = summarizeSurface(
      { ...base, content: { headline: 'h', body: { root: 'r', components: [] } } }, 2,
    )
    expect(summary).not.toHaveProperty('body')
    expect(summary.childCount).toBe(2)
  })

  it('offers no contributor at all for a Surface with neither owner, provenance, nor source', () => {
    expect(resolveContributors(base, { isLiveSession: () => true, hasGraveyardRecord: () => true })).toEqual([])
  })
})

// --- The real chain: service → sidecar → SSE, nothing mocked ---------------

describe('durable integration', () => {
  let dir: string
  let release: (() => void) | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'surface-service-'))
    acquireBackendSingleton(join(dir, 'server.lock'))
    release = () => rmSync(`${join(dir, 'server.lock')}.mark`, { recursive: true, force: true })
  })
  afterEach(() => {
    release?.()
    rmSync(dir, { recursive: true, force: true })
  })

  /** A real DocumentStore with a real sidecar, a real SSEBroadcaster, and a real
   *  connected client. Nothing between the service and the bytes is a double. */
  function live() {
    const docStore = new DocumentStore()
    const sidecar = SurfaceSidecar.open({ dir, lockPath: join(dir, 'server.lock') })
    docStore.loadSurfaces(sidecar.outcome.records, sidecar.outcome.topologyRevs)
    docStore.enableSurfacePersistence(sidecar)
    docStore.activeSpaceId = SPACE
    const sse = new SSEBroadcaster(docStore)
    const frames: string[] = []
    const client = {
      destroyed: false,
      writeHead() { return client },
      write(chunk: string) { frames.push(chunk); return true },
      on() { return client },
      end() { /* no-op */ },
    } as unknown as ServerResponse
    sse.addClient(client)
    frames.length = 0
    const svc = new SurfaceService(docStore, { newId: counterIds() })
    const batches = () => frames
      .filter(f => f.startsWith(`event: ${SURFACE_BATCH_EVENT}`))
      .map(f => JSON.parse(f.split('\n')[1]!.replace('data: ', '')) as SurfaceBatch)
    return { docStore, sidecar, sse, svc, batches }
  }

  it('commits durably, installs, and emits exactly one batch that survives a restart', async () => {
    const first = live()
    await first.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'a' } }, ctx())
    await first.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'b' } }, ctx())
    const grouped = unwrap(await first.svc.group({ childIds: ['sf-1', 'sf-2'], content: { headline: 'box' } }, ctx()))
    expect(grouped.surfaces).toHaveLength(3)

    const batches = first.batches()
    expect(batches).toHaveLength(3)
    expect(batches[2]!.changes.map(c => c.id)).toEqual(['sf-3', 'sf-1', 'sf-2'])
    expect(batches[2]!.baseTopologyRev).toBe(2)
    expect(batches[2]!.topologyRev).toBe(3)
    first.sse.destroy()

    // A fresh process against the same directory: the topology came back off disk.
    const second = live()
    expect(second.docStore.getSurfaceRoots(SPACE).map(s => s.id)).toEqual(['sf-3'])
    expect(second.docStore.getSurfaceChildren('sf-3').map(s => s.id)).toEqual(['sf-1', 'sf-2'])
    expect(second.docStore.getSurfaceTopologyRev(SPACE)).toBe(3)
    second.sse.destroy()
  })

  it('a delete and its restore both survive a restart', async () => {
    const first = live()
    await first.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'a' } }, ctx())
    await first.svc.create({ spaceId: SPACE, home: { kind: 'surface', surfaceId: 'sf-1' }, content: { headline: 'kid' } }, ctx())
    unwrap(await first.svc.delete('sf-1', { descendants: ['sf-2'], disposition: 'delete-subtree' }, ctx()))
    first.sse.destroy()

    const second = live()
    expect(second.docStore.getSurfaceRecoveryRoots(SPACE).map(s => s.id)).toEqual(['sf-1'])
    expect(second.docStore.getSurface('sf-1')!.deleted?.formerHome).toEqual({ kind: 'canvas', spaceId: SPACE })
    const svc2 = new SurfaceService(second.docStore, { newId: counterIds() })
    unwrap(await svc2.restore('sf-1', {}, ctx()))
    second.sse.destroy()

    const third = live()
    expect(third.docStore.getSurfaceRoots(SPACE).map(s => s.id)).toEqual(['sf-1'])
    expect(third.docStore.getSurface('sf-1')).not.toHaveProperty('deleted')
    third.sse.destroy()
  })

  it('a duplicate idempotency key re-applies nothing and emits no second batch', async () => {
    const h = live()
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'q' } }, ctx())
    const key = 'retry-me'
    const once = unwrap(await h.svc.appendThread('sf-1', { text: 'only once' }, ctx({ idempotencyKey: key })))
    const framesAfterFirst = h.batches().length
    const twice = unwrap(await h.svc.appendThread('sf-1', { text: 'only once' }, ctx({ idempotencyKey: key })))

    expect(once.replayed).toBe(false)
    expect(twice.replayed).toBe(true)
    expect(h.docStore.getSurface('sf-1')!.thread.replies).toHaveLength(1)
    expect(h.batches()).toHaveLength(framesAfterFirst)
    // The receipt stores scalars, so the replay reports the revision the original
    // operation produced and re-reads the record at its CURRENT one.
    expect(twice.topologyRev).toBe(once.topologyRev)
    expect(twice.surfaces[0]!.surface.rev).toBe(h.docStore.getSurface('sf-1')!.rev)
    h.sse.destroy()
  })

  it('a duplicate key on a topology mutation does not duplicate the topology change', async () => {
    const h = live()
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'a' } }, ctx())
    const key = 'group-once'
    const first = unwrap(await h.svc.group({ childIds: ['sf-1'], content: { headline: 'box' } }, ctx({ idempotencyKey: key })))
    const second = unwrap(await h.svc.group({ childIds: ['sf-1'], content: { headline: 'box' } }, ctx({ idempotencyKey: key })))
    expect(second.replayed).toBe(true)
    expect(h.docStore.getAllSurfaces()).toHaveLength(2)
    expect(second.surfaces.map(s => s.surface.id)).toEqual(first.surfaces.map(s => s.surface.id))
    h.sse.destroy()
  })

  // --- The plan/apply seam ---------------------------------------------------
  //
  // Planning validates against live memory; the durable commit that follows is a
  // whole-file rewrite behind a queue. Everything below lands work INSIDE that
  // window, which is why each one uses the real sidecar rather than the in-memory
  // harness — with no sidecar there is no window to land in.
  //
  // The pattern these pin: whichever of the two mutations commits second must be
  // REFUSED. Never "both succeeded and one of them silently swallowed the other's
  // work into the recovery store", which is what used to happen, and never a
  // record that is neither in `list()` nor reachable from a recovery root.

  /** Every visible Surface reachable from `rootIds`, every non-visible one from a
   *  `recoveryIds` root. The invariant that actually broke: a swallowed record was
   *  in neither list, so nothing rendered it and nothing offered to restore it —
   *  and then `purge` erased it. */
  function assertListingIsComplete(h: ReturnType<typeof live>) {
    const listing = unwrap(h.svc.list({ spaceId: SPACE, includeDeleted: true }))
    const visible = unwrap(h.svc.list({ spaceId: SPACE }))
    const visibleIds = new Set(visible.surfaces.map(v => v.surface.id))

    const reachable = new Set<string>()
    const walk = (ids: string[]) => {
      for (const id of ids) {
        if (reachable.has(id)) continue
        reachable.add(id)
        walk(h.docStore.getSurfaceChildren(id).map(s => s.id))
      }
    }
    walk(listing.rootIds)
    const fromRoots = new Set(reachable)
    walk(listing.recoveryIds)

    for (const view of listing.surfaces) {
      const id = view.surface.id
      expect(reachable.has(id), `${id} is in no tree at all`).toBe(true)
      expect(
        fromRoots.has(id),
        `${id} is ${visibleIds.has(id) ? 'visible' : 'hidden'} but ${fromRoots.has(id) ? 'under a root' : 'under a recovery root'}`,
      ).toBe(visibleIds.has(id))
    }
  }

  it('refuses a create landing inside a subtree being deleted', async () => {
    const h = live()
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'P' } }, ctx())
    const [del, kid] = await Promise.all([
      // A fully correct compare-and-swap: the human was shown a childless Surface.
      h.svc.delete('sf-1', {
        expectedTopologyRev: h.docStore.getSurfaceTopologyRev(SPACE),
        descendants: [],
        disposition: 'delete-subtree',
      }, ctx()),
      h.svc.create({ spaceId: SPACE, home: { kind: 'surface', surfaceId: 'sf-1' }, content: { headline: 'kid' } }, ctx()),
    ])
    expect([del.ok, kid.ok]).toContain(false)
    expect([del.ok, kid.ok]).toContain(true)
    assertListingIsComplete(h)
    h.sse.destroy()
  })

  it('refuses a reparent into a home being deleted, rather than burying it', async () => {
    const h = live()
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'DEST' } }, ctx())
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'MOVER' } }, ctx())
    const [move, del] = await Promise.all([
      h.svc.reparent({ ids: ['sf-2'], home: { kind: 'surface', surfaceId: 'sf-1' } }, ctx()),
      h.svc.delete('sf-1', {}, ctx()),
    ])
    expect([move.ok, del.ok]).toContain(false)
    // Whichever won, MOVER is never inside the recovery store: if the delete won,
    // the reparent was refused and MOVER is still on the Canvas; if the reparent
    // won, the delete was refused. The state that used to happen — a live record
    // with no deletion marker, homed under a deleted parent, in neither list —
    // is unreachable from either order.
    expect(h.docStore.surfaceRecoveryRootFor('sf-2')).toBeUndefined()
    expect(h.docStore.getSurface('sf-2')!.deleted).toBeUndefined()
    assertListingIsComplete(h)
    h.sse.destroy()
  })

  it('refuses a restore into a home being deleted', async () => {
    const h = live()
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'P' } }, ctx())
    await h.svc.create({ spaceId: SPACE, home: { kind: 'surface', surfaceId: 'sf-1' }, content: { headline: 'C' } }, ctx())
    unwrap(await h.svc.delete('sf-2', {}, ctx()))
    const [back, del] = await Promise.all([
      h.svc.restore('sf-2', {}, ctx()),
      h.svc.delete('sf-1', {}, ctx()),
    ])
    expect([back.ok, del.ok]).toContain(false)
    // The failure mode: C restored INTO the recovery store with its marker
    // stripped — strictly less reachable than while it was deleted, and reported
    // `ok`. C must be either genuinely restored or still a properly marked
    // recovery root; there is no third state.
    const c = h.docStore.getSurface('sf-2')!
    const root = h.docStore.surfaceRecoveryRootFor('sf-2')
    if (root) {
      expect(root.id).toBe('sf-2')
      expect(c.deleted).toBeDefined()
    } else {
      expect(c.deleted).toBeUndefined()
    }
    assertListingIsComplete(h)
    h.sse.destroy()
  })

  it('gives two concurrent topology mutations two different revisions', async () => {
    const h = live()
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'a' } }, ctx())
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'b' } }, ctx())
    const base = h.docStore.getSurfaceTopologyRev(SPACE)
    const [x, y] = await Promise.all([
      h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'X' } }, ctx()),
      h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'Y' } }, ctx()),
    ])
    const produced = [x, y].filter(r => r.ok).map(r => unwrap(r).topologyRev)
    // Both are allowed to succeed — they touch disjoint records — but they may not
    // both claim `base + 1`. The revision is allocated at COMMIT time, so the space
    // advances once per mutation and a batch header identifies its own mutation.
    expect(produced.length).toBeGreaterThan(0)
    expect(new Set(produced).size).toBe(produced.length)
    expect([...produced].sort((a, b) => a - b))
      .toEqual(produced.map((_, i) => base + 1 + i))
    expect(h.docStore.getSurfaceTopologyRev(SPACE)).toBe(base + produced.length)
    // Each response's own base is the revision the one before it produced, so an
    // ordered consumer can chain the batches instead of full-resyncing on the
    // second of every colliding pair.
    for (const r of [x, y]) {
      if (r.ok) expect(r.data.topologyRev).toBe(r.data.baseTopologyRev + 1)
    }
    h.sse.destroy()
  })

  it('a purge cannot erase more than the caller named', async () => {
    const h = live()
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'P' } }, ctx())
    unwrap(await h.svc.delete('sf-1', {}, ctx()))
    // A child arrives under the deleted root after the human read the recovery
    // list. The purge they authorised was for one record.
    h.docStore.loadSurfaces([{
      ...h.docStore.getSurface('sf-1')!,
      id: 'sf-late', home: { kind: 'surface', surfaceId: 'sf-1' }, rev: 1, homeRev: 9,
    }])
    const refused = await h.svc.purge('sf-1', { descendants: [] }, ctx())
    expect(err(refused).reason).toBe('descendant-mismatch')
    expect(h.docStore.getSurface('sf-late')).toBeDefined()
    h.sse.destroy()
  })

  it('a content update that changes nothing leaves live and durable in agreement', async () => {
    const h = live()
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'hello' } }, ctx())

    // The cheapest request in the API: a form saved unchanged. It used to advance
    // the DURABLE revision while the in-memory storm guard refused the install,
    // after which every write to the record failed its compare-and-swap forever
    // and re-reading (the documented recovery) returned the same stale revision.
    const noop = await h.svc.updateContent('sf-1', { expectedRev: 1, headline: 'hello' }, ctx())
    expect(err(noop).reason).toBe('no-change')

    const live1 = h.docStore.getSurface('sf-1')!
    const durable1 = h.sidecar.durableRecords().find(r => r.id === 'sf-1')!
    expect(live1.rev).toBe(durable1.rev)

    // And the record is still writable — the property the divergence destroyed.
    const real = unwrap(await h.svc.updateContent('sf-1', { expectedRev: live1.rev, headline: 'goodbye' }, ctx()))
    expect(real.surfaces[0]!.surface.content.headline).toBe('goodbye')
    const appended = unwrap(await h.svc.appendThread('sf-1', { text: 'still works' }, ctx()))
    expect(appended.surfaces[0]!.surface.thread.replies).toHaveLength(1)
    expect(h.docStore.getSurface('sf-1')!.rev)
      .toBe(h.sidecar.durableRecords().find(r => r.id === 'sf-1')!.rev)
    h.sse.destroy()
  })

  it('a faulted store refuses every mutation and tells the caller why', async () => {
    const h = live()
    await h.svc.create({ spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'a' } }, ctx())
    h.sse.destroy()

    // Corrupt both snapshots, then reopen: the honest faulted boot.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'surfaces.json'), '{oh no')
    writeFileSync(join(dir, 'surfaces.backup.json'), '{oh no')
    const docStore = new DocumentStore()
    const sidecar = SurfaceSidecar.open({ dir, lockPath: join(dir, 'server.lock') })
    expect(sidecar.health).toBe('faulted-read-only')
    // The boot path would NOT attach a faulted sidecar; attaching it here is what
    // makes the service's own refusal observable rather than merely unreachable.
    docStore.enableSurfacePersistence(sidecar)
    docStore.loadSurfaces([{
      id: 'sf-1', spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE },
      content: { headline: 'a' }, contentAuthority: 'canonical-direct', author: 'agent',
      thread: { replies: [], status: 'open' }, freshness: { phase: 'current', overdue: false },
      rev: 1, homeRev: 1, createdAt: 1, amendedAt: 1,
    }])
    const svc = new SurfaceService(docStore)
    const r = await svc.appendThread('sf-1', { text: 'nope' }, ctx())
    expect(err(r).code).toBe('faulted')
    expect(err(r).message).toMatch(/read-only/)
    expect(docStore.getSurface('sf-1')!.thread.replies).toHaveLength(0)
  })
})

/** A type-level assertion, exercised at runtime so it cannot be pruned as unused:
 *  every operation named in the parity table has a method on the service, so
 *  adding one to the union without implementing it fails typecheck here. */
describe('parity coverage', () => {
  it('has a service method for every operation in the union', () => {
    const methods: Record<SurfaceMutation['op'], keyof SurfaceService> = {
      'create': 'create',
      'observe-source': 'observeSource',
      'mark-source-missing': 'markSourceMissing',
      'update-content': 'updateContent',
      'transfer-content-authority': 'transferContentAuthority',
      'append-thread': 'appendThread',
      'set-thread-disposition': 'setThreadDisposition',
      'group': 'group',
      'reparent': 'reparent',
      'ungroup': 'ungroup',
        'mark-possibly-stale': 'markPossiblyStale',
      'enqueue-refresh': 'enqueueRefresh',
      'begin-refresh': 'beginRefresh',
      'complete-refresh': 'completeRefresh',
      'fail-refresh': 'failRefresh',
      'set-refresh-schedule': 'setSchedule',
      'record-witness-result': 'recordWitnessResult',
      'delete': 'delete',
      'restore': 'restore',
      'purge': 'purge',
    }
    const svc = new SurfaceService(new DocumentStore())
    for (const name of Object.values(methods)) {
      expect(typeof svc[name]).toBe('function')
    }
  })
})

describe('the author proposes, the user disposes (status honesty)', () => {
  // THE INVARIANT UNDER TEST. Status derives from who spoke last so the Slate can
  // never auto-resolve — the CMT-1302 failure. A proposal has to make the card
  // honest about "already shipped" vs "awaiting your ruling" WITHOUT reopening that
  // door, so these tests exist to prove the door stays shut.

  it('a proposal is stored as content and moves the status NOT AT ALL', async () => {
    const h = harness()
    const s = await h.create('Decision 6', {
      content: { headline: 'Decision 6', proposal: { state: 'resolved', detail: 'shipped in #163' } },
    })
    expect(s.content.proposal?.state).toBe('resolved')
    expect(s.content.proposal?.detail).toBe('shipped in #163')
    // The whole point: an author claiming "done" did not resolve anything.
    expect(s.thread.status).toBe('open')
    expect(s.thread.resolvedAt).toBeUndefined()
  })

  it('refuses a state outside the vocabulary rather than storing it', async () => {
    const h = harness()
    const s = await h.create('x', { content: { headline: 'x', proposal: { state: 'dismissed' } } })
    // `dismissed` is the USER's verdict and an author may not propose it.
    expect(s.content.proposal).toBeUndefined()
  })

  it('supersede is its own exit — not resolve, not dismiss', async () => {
    const h = harness()
    const s = await h.create('Decision 6')
    const done = unwrap(await h.svc.setThreadDisposition(s.id, { action: 'supersede' }, ctx({ at: 2_000 })))
    const after = done.surfaces[0]!.surface
    expect(after.thread.status).toBe('superseded')
    expect(after.thread.supersededAt).toBe(2_000)
    expect(after.thread.resolvedAt).toBeUndefined()
    expect(after.thread.dismissedAt).toBeUndefined()
  })

  it('reopen clears the supersede stamp and hands the status back to the derivation', async () => {
    const h = harness()
    const s = await h.create('Decision 6')
    await h.svc.setThreadDisposition(s.id, { action: 'supersede' }, ctx({ at: 2_000 }))
    const back = unwrap(await h.svc.setThreadDisposition(s.id, { action: 'reopen' }, ctx({ at: 3_000 })))
    const after = back.surfaces[0]!.surface
    expect(after.thread.supersededAt).toBeUndefined()
    expect(after.thread.status).toBe('open')
  })

  it('rejects an action outside the four', async () => {
    const h = harness()
    const s = await h.create('x')
    expect(err(await h.svc.setThreadDisposition(s.id, { action: 'shelve' }, ctx())).code).toBe('invalid')
  })

  it('accepts refreshPolicy and proposal over HTTP, which agent parity requires', async () => {
    // Both were silently DROPPED by the content parser: an agent could set them by
    // writing a `.tinstar/slate` file and not through the API U3 calls parity.
    const h = harness()
    const s = await h.create('x', {
      content: {
        headline: 'x',
        refreshPolicy: { policy: 'mark-stale', triggers: ['git-revision'], sources: ['src/api/**'] },
        proposal: { state: 'working', detail: 'half a day' },
      },
    })
    expect(s.content.refreshPolicy?.sources).toEqual(['src/api/**'])
    expect(s.content.proposal?.state).toBe('working')
  })

  // The two carry-forward sites, which #168 deferred. A proposal is authored
  // alongside the headline, so both hazards are the ones already documented for
  // `recipe` and `claims`: the content record is written back into the author's own
  // `.tinstar/slate/*.json` by the egress adapter, so a builder that omits the field
  // does not merely forget it — it DELETES the author's claim from their own file.
  it('preserves the proposal through a headline-only content patch', async () => {
    const h = harness()
    await h.create('shipped', {
      content: { headline: 'shipped', proposal: { state: 'working', detail: 'half a day' } },
    })
    const patched = unwrap(await h.svc.updateContent('sf-1', { headline: 'renamed', expectedRev: 1 }, ctx()))
    // This endpoint takes a whitelist, so omitting `proposal` means "unchanged".
    expect(patched.surfaces[0]!.surface.content.proposal?.state).toBe('working')
    expect(patched.surfaces[0]!.surface.content.proposal?.detail).toBe('half a day')
    expect(patched.surfaces[0]!.surface.content.headline).toBe('renamed')
  })

  it('preserves the proposal through a successful rebuild', async () => {
    const h = harness()
    await h.create('shipped', {
      content: { headline: 'shipped', recipe: 'rebuild me', proposal: { state: 'working', detail: 'half a day' } },
    })
    await h.svc.enqueueRefresh('sf-1', { jobId: 'job-1' }, ctx({ at: 2_000 }))
    await h.svc.beginRefresh('sf-1', { jobId: 'job-1', expectedRev: h.docStore.getSurface('sf-1')!.rev }, ctx({ at: 2_100 }))
    // A worker restates the OUTPUT only — `parseStagedResult` cannot express a
    // proposal — so the barrier has to carry the author's claim itself.
    const done = unwrap(await h.svc.completeRefresh('sf-1', {
      jobId: 'job-1',
      expectedRev: h.docStore.getSurface('sf-1')!.rev,
      observedGeneration: 0,
      content: { headline: 'rebuilt' },
    }, ctx({ at: 3_000 })))
    expect(done.surfaces[0]!.surface.content.headline).toBe('rebuilt')
    expect(done.surfaces[0]!.surface.content.proposal?.state).toBe('working')
    expect(done.surfaces[0]!.surface.content.recipe).toEqual({ kind: 'agent', prompt: 'rebuild me' })
  })
})

// ---------------------------------------------------------------------------
// Freshness evidence: what is KNOWN vs when it was last CHECKED (R3/R15-R18, KTD5).
//
// A Surface shows two facts, and one timestamp could never tell them apart: the
// content's own age, and the age of the last time the host looked. The common case
// is the one that proves it — a check that succeeds and changes nothing must move
// exactly one of them.
// ---------------------------------------------------------------------------

describe('last-known and last-checked evidence', () => {
  /** A Surface taken all the way to `refreshing`, ready for a completion. */
  async function refreshing(h: Harness, at = 2_000): Promise<Surface> {
    await h.create('Coverage 88%')
    await h.svc.enqueueRefresh('sf-1', { jobId: 'job-1' }, ctx({ at }))
    const queued = h.docStore.getSurface('sf-1')!
    await h.svc.beginRefresh('sf-1', { jobId: 'job-1', expectedRev: queued.rev }, ctx({ at }))
    return h.docStore.getSurface('sf-1')!
  }

  it('stamps both fields at birth, so no record is ever without evidence', async () => {
    const h = harness()
    const created = await h.create('hello')
    expect(created.freshness.lastKnownAt).toBe(created.createdAt)
    // Explicitly null rather than absent: an omitted key is dropped from an SSE
    // delta, so "never checked" has to be a value a client can actually receive.
    expect(created.freshness.lastCheck).toBeNull()
  })

  it('an UNCHANGED successful check advances lastCheck and leaves lastKnownAt alone', async () => {
    // THE COMMON CASE, and the whole reason the two fields exist. 110 of 121 measured
    // refreshes changed nothing; each one is honestly "we confirmed at 10:47 that the
    // 09:12 answer still holds", and a single timestamp would have said "10:47" and
    // quietly relabelled month-old content as fresh.
    const h = harness()
    const before = await refreshing(h)
    const knownAt = before.freshness.lastKnownAt

    const done = unwrap(await h.svc.completeRefresh('sf-1', {
      jobId: 'job-1', expectedRev: before.rev,
      observedGeneration: before.source?.generation ?? 0,
      check: { startedAt: 2_000, execution: 'host', reason: 'its verification interval elapsed' },
    }, ctx({ at: 3_000 })))

    const f = done.surfaces[0]!.surface.freshness
    expect(f.lastKnownAt).toBe(knownAt)
    expect(f.lastCheck).toMatchObject({
      outcome: 'succeeded', execution: 'host', startedAt: 2_000, finishedAt: 3_000,
      reason: 'its verification interval elapsed',
    })
    expect(done.surfaces[0]!.surface.content.headline).toBe('Coverage 88%')
  })

  it('a REPLACEMENT advances both, atomically', async () => {
    const h = harness()
    const before = await refreshing(h)
    const done = unwrap(await h.svc.completeRefresh('sf-1', {
      jobId: 'job-1', expectedRev: before.rev,
      observedGeneration: before.source?.generation ?? 0,
      content: { headline: 'Coverage 92%' },
    }, ctx({ at: 3_000 })))

    const s = done.surfaces[0]!.surface
    expect(s.content.headline).toBe('Coverage 92%')
    expect(s.freshness.lastKnownAt).toBe(3_000)
    expect(s.freshness.lastCheck?.outcome).toBe('succeeded')
    expect(s.freshness.phase).toBe('current')
  })

  it('a FAILED check preserves the content and records why', async () => {
    const h = harness()
    await refreshing(h)
    unwrap(await h.svc.failRefresh('sf-1', {
      jobId: 'job-1', message: 'the coverage tool is not installed',
    }, ctx({ at: 3_000 })))

    const s = h.docStore.getSurface('sf-1')!
    expect(s.content.headline).toBe('Coverage 88%')   // last known, still readable
    expect(s.freshness.lastKnownAt).toBe(s.createdAt) // and still honestly dated
    expect(s.freshness.lastCheck).toMatchObject({ outcome: 'failed', finishedAt: 3_000 })
    expect(s.freshness.lastCheck?.detail).toMatch(/not installed/)
  })

  it('UNAVAILABLE is a distinct outcome from failed, because it calls for something different', async () => {
    // "Jira is down" and "your agent has exited" both leave the card stale, and a
    // reader does different things about them. Collapsing them would hide that.
    const h = harness()
    await refreshing(h)
    unwrap(await h.svc.failRefresh('sf-1', {
      jobId: 'job-1', outcome: 'unavailable',
      message: 'its foreground agent is not running, so nobody could rebuild it',
      check: { execution: 'owner', reason: 'you navigated to it' },
    }, ctx({ at: 3_000 })))

    const f = h.docStore.getSurface('sf-1')!.freshness
    expect(f.lastCheck?.outcome).toBe('unavailable')
    expect(f.lastCheck?.execution).toBe('owner')
    expect(h.docStore.getSurface('sf-1')!.content.headline).toBe('Coverage 88%')
  })

  it('SUPERSEDED is a completed check with a non-current outcome, not an error', async () => {
    // KTD10. The host looked, got an answer, and the answer described a world that
    // had already moved. The Surface stays dirty and keeps its content.
    const h = harness()
    const before = await refreshing(h)
    const stale = await h.svc.completeRefresh('sf-1', {
      jobId: 'job-1', expectedRev: before.rev,
      observedGeneration: (before.source?.generation ?? 0) - 1,
      content: { headline: 'Coverage 92%' },
    }, ctx({ at: 3_000 }))

    expect(err(stale).reason).toBe('superseded')
    const s = h.docStore.getSurface('sf-1')!
    expect(s.content.headline).toBe('Coverage 88%')
    expect(s.freshness.phase).toBe('possibly-stale')
    expect(s.freshness.lastCheck?.outcome).toBe('superseded')
    expect(s.freshness.lastKnownAt).toBe(s.createdAt)
  })

  it('the four outcomes are distinguishable from the record alone, without logs', async () => {
    // R3's readable requirement, asserted as a set rather than one at a time: a UI
    // that has to tell these apart can, and cannot accidentally render two of them
    // the same way.
    const outcomes = new Set<string>()
    for (const build of [
      async (h: Harness, before: Surface) => {
        await h.svc.completeRefresh('sf-1', {
          jobId: 'j', expectedRev: before.rev, observedGeneration: before.source?.generation ?? 0,
        }, ctx({ at: 3_000 }))
      },
      async (h: Harness) => { await h.svc.failRefresh('sf-1', { jobId: 'j', message: 'boom' }, ctx({ at: 3_000 })) },
      async (h: Harness) => {
        await h.svc.failRefresh('sf-1', { jobId: 'j', outcome: 'unavailable', message: 'gone' }, ctx({ at: 3_000 }))
      },
      async (h: Harness, before: Surface) => {
        await h.svc.completeRefresh('sf-1', {
          jobId: 'j', expectedRev: before.rev, observedGeneration: (before.source?.generation ?? 0) - 1,
        }, ctx({ at: 3_000 }))
      },
    ]) {
      const h = harness()
      const before = await refreshing(h)
      await build(h, before)
      outcomes.add(h.docStore.getSurface('sf-1')!.freshness.lastCheck!.outcome)
    }
    expect([...outcomes].sort()).toEqual(['failed', 'succeeded', 'superseded', 'unavailable'])
  })

  it('queueing answers nothing, so it does not overwrite the last completed check', async () => {
    // A check that has not finished has not answered anything. Overwriting the last
    // one that did would destroy evidence to produce none.
    const h = harness()
    await refreshing(h)
    await h.svc.failRefresh('sf-1', { jobId: 'job-1', message: 'boom' }, ctx({ at: 3_000 }))
    const failed = h.docStore.getSurface('sf-1')!.freshness.lastCheck

    await h.svc.enqueueRefresh('sf-1', { jobId: 'job-2' }, ctx({ at: 4_000 }))
    expect(h.docStore.getSurface('sf-1')!.freshness.phase).toBe('queued')
    expect(h.docStore.getSurface('sf-1')!.freshness.lastCheck).toEqual(failed)
  })

  it('a later success CLEARS a prior failure rather than leaving both readable', async () => {
    const h = harness()
    await refreshing(h)
    await h.svc.failRefresh('sf-1', { jobId: 'job-1', message: 'boom' }, ctx({ at: 3_000 }))
    expect(h.docStore.getSurface('sf-1')!.freshness.lastCheck?.outcome).toBe('failed')

    await h.svc.enqueueRefresh('sf-1', { jobId: 'job-2' }, ctx({ at: 4_000 }))
    const queued = h.docStore.getSurface('sf-1')!
    await h.svc.beginRefresh('sf-1', { jobId: 'job-2', expectedRev: queued.rev }, ctx({ at: 4_000 }))
    const now = h.docStore.getSurface('sf-1')!
    unwrap(await h.svc.completeRefresh('sf-1', {
      jobId: 'job-2', expectedRev: now.rev, observedGeneration: now.source?.generation ?? 0,
      content: { headline: 'Coverage 92%' },
    }, ctx({ at: 5_000 })))

    const f = h.docStore.getSurface('sf-1')!.freshness
    expect(f.lastCheck?.outcome).toBe('succeeded')
    // The failure itself is gone from the record — a successful barrier answers it,
    // and a card showing both would be showing a problem that no longer exists.
    expect(f.failure).toBeUndefined()
  })
})
