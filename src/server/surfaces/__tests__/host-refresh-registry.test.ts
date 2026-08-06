// @vitest-environment node
//
// The closed host registry (R6/R7, KTD1/KTD6/KTD7).
//
// TWO CLAIMS, and the second is the one that makes the first worth anything:
//
//   1. A host handler produces a WHOLE Surface or an outcome — never a patch of one
//      (R2). A handler that could edit a region would put the host and the author on
//      the same card with no rule about who wins.
//   2. A host handler CANNOT reach a model, a session, a terminal, or an agent (R7).
//      Asserted structurally rather than by inspection: the deps object it is
//      constructed with is its entire world, so the test is about what that object
//      does not contain.
//
// The witness `exec`/`fetch` seams are stubbed — they are what leaves the process —
// and the broker is real, because "every lookup crosses the broker" is one of the
// things under test.
import { describe, it, expect, vi } from 'vitest'
import { HOST_RECIPE_KINDS, type SurfaceContent } from '../../../domain/types'
import { hostRecipeHandlers, runHostRecipe, type HostRefreshDeps } from '../host-refresh-registry'
import { SurfaceLookupBroker } from '../surface-lookup-broker'
import type { WitnessDeps } from '../witness-registry'

const PRIOR: SurfaceContent = { headline: 'https://tinstar.test/health — HTTP 200' }

function deps(over: Partial<HostRefreshDeps> = {}, witness: Partial<WitnessDeps> = {}): HostRefreshDeps {
  return {
    broker: new SurfaceLookupBroker(),
    now: () => 1_700_000_000_000,
    witness: {
      exec: async () => ({ stdout: '', stderr: 'not wired for this test', code: 1 }),
      fetch: async () => ({ status: 200 }),
      ...witness,
    },
    ...over,
  }
}

describe('the registry is closed and complete', () => {
  it('implements exactly the union authors may name — no more, no fewer', () => {
    // Two lists that must agree: the union is what the PARSER accepts and this table
    // is what actually runs. A name in one and not the other is either a recipe that
    // parses and then never runs, or a handler nobody can reach.
    expect([...hostRecipeHandlers()].sort()).toEqual([...HOST_RECIPE_KINDS].sort())
  })

  it('refuses a handler name that is not registered rather than guessing', async () => {
    const out = await runHostRecipe({
      // Past the parser by construction — this is the defence in depth for a union
      // member added without its handler.
      recipe: { kind: 'host', handler: 'nope' as never },
      prior: PRIOR,
      deps: deps(),
    })
    expect(out).toMatchObject({ status: 'failed' })
    expect(out.status === 'failed' && out.detail).toMatch(/no host handler is registered/)
  })

  it('is constructed with NOTHING that could invoke a model, session, terminal, or agent', () => {
    // R7 as a structural assertion. The deps object IS the handler's world, so this
    // list is the complete set of capabilities any host recipe has. A future dep that
    // widened it would fail here before it could be used.
    expect(Object.keys(deps()).sort()).toEqual(['broker', 'now', 'witness'])
    expect(Object.keys(deps().witness).sort()).toEqual(['exec', 'fetch'])
  })
})

describe('http-status', () => {
  const recipe = { kind: 'host', handler: 'http-status', params: { url: 'https://tinstar.test/health' } } as const

  it('returns a WHOLE Surface when the answer moved, not a patch of one', async () => {
    const out = await runHostRecipe({
      recipe, prior: PRIOR, deps: deps({}, { fetch: async () => ({ status: 503 }) }),
    })
    expect(out.status).toBe('replaced')
    if (out.status !== 'replaced') return
    // Headline AND body, both rebuilt. There is no shape here that could express
    // "change this component and leave the rest alone".
    expect(out.content.headline).toBe('https://tinstar.test/health — HTTP 503')
    expect(out.content.body?.root).toBe('root')
    expect(JSON.stringify(out.content.body)).toContain('503')
  })

  it('reports UNCHANGED — a completed check that changes nothing (KTD5)', async () => {
    // The common answer, and the one the two-timestamp split exists for: this must
    // advance `lastCheck` without touching `lastKnownAt`, which it can only do if the
    // handler distinguishes it from a replacement.
    const out = await runHostRecipe({ recipe, prior: PRIOR, deps: deps() })
    expect(out).toMatchObject({ status: 'unchanged' })
  })

  it('an unreachable host is UNAVAILABLE, never "the endpoint is down"', async () => {
    // "Nobody could look" and "we looked and it is broken" are different facts, and
    // a card that conflated them would report an outage that may not exist.
    const out = await runHostRecipe({
      recipe,
      prior: PRIOR,
      deps: deps({}, { fetch: async () => { throw new Error('ENOTFOUND') } }),
    })
    expect(out).toMatchObject({ status: 'unavailable' })
    expect(out.status === 'unavailable' && out.detail).toMatch(/ENOTFOUND/)
  })

  it('refuses a recipe with no url instead of checking nothing', async () => {
    const out = await runHostRecipe({
      recipe: { kind: 'host', handler: 'http-status' }, prior: PRIOR, deps: deps(),
    })
    expect(out).toMatchObject({ status: 'failed' })
    expect(out.status === 'failed' && out.detail).toMatch(/params\.url is required/)
  })
})

describe('unit-landed', () => {
  const recipe = {
    kind: 'host', handler: 'unit-landed',
    params: { plan: 'docs/plans/2026-07-24-001-feat-recursive-collaborative-surfaces-plan.md', unit: 'U6' },
  } as const

  it('is UNAVAILABLE with no worktree — there is no repository to read', async () => {
    const out = await runHostRecipe({ recipe, prior: { headline: 'U6 — pending' }, deps: deps() })
    expect(out).toMatchObject({ status: 'unavailable' })
  })

  it('refuses missing parameters rather than checking a default nobody asked for', async () => {
    const out = await runHostRecipe({
      recipe: { kind: 'host', handler: 'unit-landed', params: { plan: 'docs/plans/x.md' } },
      prior: { headline: 'x' },
      deps: deps(),
    })
    expect(out).toMatchObject({ status: 'failed' })
    expect(out.status === 'failed' && out.detail).toMatch(/params\.unit is required/)
  })
})

describe('every lookup crosses the broker', () => {
  it('many Surfaces asking one provider question cost ONE provider call', async () => {
    // THE POINT OF U3, end to end through the registry rather than at the broker's
    // own seam: authoring more cards must not buy more provider load (R8).
    const broker = new SurfaceLookupBroker()
    const fetch = vi.fn(async () => ({ status: 200 }))
    const d = deps({ broker }, { fetch })
    const recipe = { kind: 'host', handler: 'http-status', params: { url: 'https://tinstar.test/health' } } as const

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      runHostRecipe({ recipe, prior: { headline: `card ${i}` }, deps: d })))

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(results.every(r => r.status === 'replaced')).toBe(true)
    expect(broker.stats()).toMatchObject({ ran: 1, coalesced: 9 })
  })

  it('DEFERRAL is passed through unmapped, so the caller records nothing', async () => {
    // Not a failure and not an outcome. Mapping it to either would put a check on the
    // record that never happened — and, because a recorded check moves the deadline,
    // would hide the backlog it exists to make visible (R8).
    const broker = new SurfaceLookupBroker({ maxConcurrent: 1, maxConcurrentPerProvider: 1 })
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const d = deps({ broker }, { fetch: async () => { await held; return { status: 200 } } })

    const first = runHostRecipe({
      recipe: { kind: 'host', handler: 'http-status', params: { url: 'https://a/health' } },
      prior: PRIOR, deps: d,
    })
    await new Promise<void>(r => setImmediate(r))
    const second = await runHostRecipe({
      recipe: { kind: 'host', handler: 'http-status', params: { url: 'https://b/health' } },
      prior: PRIOR, deps: d,
    })
    expect(second).toMatchObject({ status: 'deferred' })
    release()
    await first
  })

  it('one provider failing is DATA, not a rejection that takes the pass down', async () => {
    const out = await runHostRecipe({
      recipe: { kind: 'host', handler: 'http-status', params: { url: 'https://x/health' } },
      prior: PRIOR,
      // A thunk that rejects rather than returning an outcome: the defensive path.
      deps: deps({
        broker: {
          lookup: async () => ({ status: 'threw', error: new Error('bug in the runner') }),
        } as unknown as SurfaceLookupBroker,
      }),
    })
    expect(out).toMatchObject({ status: 'failed' })
    expect(out.status === 'failed' && out.detail).toMatch(/bug in the runner/)
  })
})
