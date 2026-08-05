// @vitest-environment node
//
// The provider bound (R8, KTD6).
//
// THE CLAIM UNDER TEST is not "there is a limit" — it is that SURFACE COUNT CANNOT
// BUY PROVIDER LOAD. Every per-Surface budget in this codebase satisfied the first
// and failed the second: twenty cards watching one ref meant twenty `git fetch`
// calls of the same commit, and authoring a twenty-first made it worse. So the tests
// that matter here are the ones where the number of askers goes up and the number of
// provider calls does not.
//
// No network, no subprocess, no timers: the broker takes the work as a thunk, so
// every one of these is a counter and a deferred promise.
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAX_LOOKUPS,
  DEFAULT_MAX_PER_PROVIDER,
  resolveLookupBudget,
  SurfaceLookupBroker,
} from '../surface-lookup-broker'

/** A thunk whose completion the test controls, plus a count of how many times the
 *  provider was actually asked. */
function gate() {
  const state = { calls: 0 }
  let release!: (value: string) => void
  const done = new Promise<string>(r => { release = r })
  return {
    state,
    release,
    run: () => { state.calls++; return done },
  }
}

/** Let queued microtasks run so a pending `lookup` reaches its first await. */
const settle = () => new Promise<void>(r => setImmediate(r))

describe('SurfaceLookupBroker — coalescing', () => {
  it('many Surfaces asking ONE question cost ONE provider call', async () => {
    // THE HEADLINE. Twenty askers, one lookup, and — the part that makes Surface
    // count stop mattering — nineteen of them consumed no slot at all.
    const broker = new SurfaceLookupBroker()
    const g = gate()
    const asks = Array.from({ length: 20 }, () =>
      broker.lookup({ provider: 'git', key: 'origin/main', run: g.run }))
    await settle()
    g.release('landed')
    const results = await Promise.all(asks)

    expect(g.state.calls).toBe(1)
    expect(results.every(r => r.status === 'done' && r.value === 'landed')).toBe(true)
    expect(results.filter(r => r.status === 'done' && r.coalesced)).toHaveLength(19)
    expect(broker.stats()).toMatchObject({ ran: 1, coalesced: 19, deferred: 0 })
  })

  it('joining is free — a coalesced ask is not refused even when every slot is taken', async () => {
    // Checked BEFORE the semaphores on purpose. Gating the join on a free slot would
    // make a burst of identical questions defer most of itself for no benefit, which
    // is the shape that made per-Surface budgets useless.
    const broker = new SurfaceLookupBroker({ maxConcurrent: 1, maxConcurrentPerProvider: 1 })
    const g = gate()
    const first = broker.lookup({ provider: 'git', key: 'k', run: g.run })
    await settle()
    // Started while the only slot is held. A DIFFERENT key here would be deferred
    // (the test below proves that); this one joins, so it resolves with the answer.
    const second = broker.lookup({ provider: 'git', key: 'k', run: g.run })
    g.release('v')
    expect(await second).toMatchObject({ status: 'done', coalesced: true, value: 'v' })
    await first
    expect(g.state.calls).toBe(1)
  })

  it('DIFFERENT keys are different questions and do not share an answer', async () => {
    const broker = new SurfaceLookupBroker({ maxConcurrent: 4, maxConcurrentPerProvider: 4 })
    const a = gate()
    const b = gate()
    const asks = [
      broker.lookup({ provider: 'git', key: 'origin/main', run: a.run }),
      broker.lookup({ provider: 'git', key: 'origin/next', run: b.run }),
    ]
    await settle()
    a.release('A'); b.release('B')
    const [ra, rb] = await Promise.all(asks)
    expect(ra).toMatchObject({ status: 'done', value: 'A' })
    expect(rb).toMatchObject({ status: 'done', value: 'B' })
    expect(a.state.calls + b.state.calls).toBe(2)
  })

  it('the same key at a DIFFERENT provider is also a different question', async () => {
    const broker = new SurfaceLookupBroker({ maxConcurrent: 4, maxConcurrentPerProvider: 4 })
    const a = gate()
    const b = gate()
    const asks = [
      broker.lookup({ provider: 'git', key: 'health', run: a.run }),
      broker.lookup({ provider: 'http', key: 'health', run: b.run }),
    ]
    await settle()
    a.release('A'); b.release('B')
    expect((await Promise.all(asks)).map(r => r.status === 'done' && r.value)).toEqual(['A', 'B'])
  })

  it('a slot is released when its lookup finishes, so the budget is a rate and not a quota', async () => {
    const broker = new SurfaceLookupBroker({ maxConcurrent: 1, maxConcurrentPerProvider: 1 })
    const first = gate()
    const pending = broker.lookup({ provider: 'git', key: 'a', run: first.run })
    await settle()
    expect((await broker.lookup({ provider: 'git', key: 'b', run: gate().run })).status).toBe('deferred')
    first.release('v')
    await pending
    const second = gate()
    second.release('w')
    expect(await broker.lookup({ provider: 'git', key: 'b', run: second.run })).toMatchObject({ status: 'done' })
  })
})

describe('SurfaceLookupBroker — budgets', () => {
  it('respects the per-provider limit even when the global budget is free', async () => {
    // The bound that matters to somebody ELSE's rate limiter. A provider does not
    // care that Tinstar had three spare global slots.
    const broker = new SurfaceLookupBroker({ maxConcurrent: 4, maxConcurrentPerProvider: 1 })
    const g = gate()
    const running = broker.lookup({ provider: 'git', key: 'a', run: g.run })
    await settle()

    const refused = await broker.lookup({ provider: 'git', key: 'b', run: gate().run })
    expect(refused).toMatchObject({ status: 'deferred' })
    expect(refused.status === 'deferred' && refused.detail).toMatch(/git is already being asked/)

    // …and another provider is unaffected: one busy provider must not stall the host.
    const other = gate()
    other.release('ok')
    expect((await broker.lookup({ provider: 'http', key: 'x', run: other.run })).status).toBe('done')
    g.release('v')
    await running
  })

  it('respects the global limit across providers', async () => {
    const broker = new SurfaceLookupBroker({ maxConcurrent: 2, maxConcurrentPerProvider: 2 })
    const held = [gate(), gate()]
    const running = held.map((g, i) => broker.lookup({ provider: `p${i}`, key: 'k', run: g.run }))
    await settle()
    const refused = await broker.lookup({ provider: 'p3', key: 'k', run: gate().run })
    expect(refused).toMatchObject({ status: 'deferred' })
    expect(refused.status === 'deferred' && refused.detail).toMatch(/already running 2 lookups/)
    held.forEach(g => g.release('v'))
    await Promise.all(running)
  })

  it('a DEFERRED request never ran the thunk — nothing to record, nothing to retry', async () => {
    // The property the coordinator depends on: a deferral is the host declining to
    // look, so there is no outcome to write down and no failure to back off from.
    const broker = new SurfaceLookupBroker({ maxConcurrent: 1, maxConcurrentPerProvider: 1 })
    const held = gate()
    const running = broker.lookup({ provider: 'git', key: 'a', run: held.run })
    await settle()
    const skipped = gate()
    expect((await broker.lookup({ provider: 'git', key: 'b', run: skipped.run })).status).toBe('deferred')
    expect(skipped.state.calls).toBe(0)
    held.release('v')
    await running
  })

  it('the shipped defaults are the ones the plan names', () => {
    expect(DEFAULT_MAX_LOOKUPS).toBe(4)
    expect(DEFAULT_MAX_PER_PROVIDER).toBe(1)
    expect(resolveLookupBudget(undefined).budget)
      .toEqual({ maxConcurrent: 4, maxConcurrentPerProvider: 1 })
  })
})

describe('SurfaceLookupBroker — failures are data', () => {
  it('a thunk that throws does not reject the caller, and does not take the sweep down', async () => {
    // One provider failing may not reject a pass that is also looking at ninety-nine
    // other Surfaces.
    const broker = new SurfaceLookupBroker()
    const result = await broker.lookup({
      provider: 'http', key: 'x', run: async () => { throw new Error('DNS is down') },
    })
    expect(result.status).toBe('threw')
    expect(result.status === 'threw' && String(result.error)).toMatch(/DNS is down/)
  })

  it('every joiner of a failed lookup learns about it the same way', async () => {
    const broker = new SurfaceLookupBroker()
    let reject!: (e: Error) => void
    const pending = new Promise<string>((_, r) => { reject = r })
    const first = broker.lookup({ provider: 'http', key: 'x', run: () => pending })
    await settle()
    const second = broker.lookup({ provider: 'http', key: 'x', run: () => pending })
    reject(new Error('boom'))
    expect((await first).status).toBe('threw')
    expect((await second).status).toBe('threw')
  })

  it('a failed lookup releases its slot rather than leaking one', async () => {
    const broker = new SurfaceLookupBroker({ maxConcurrent: 1, maxConcurrentPerProvider: 1 })
    await broker.lookup({ provider: 'http', key: 'x', run: async () => { throw new Error('boom') } })
    expect(broker.stats().active).toBe(0)
    expect((await broker.lookup({ provider: 'http', key: 'y', run: async () => 'ok' })).status).toBe('done')
  })
})

describe('resolveLookupBudget', () => {
  it('accepts a sane override', () => {
    expect(resolveLookupBudget({ maxConcurrent: 8, maxConcurrentPerProvider: 2 }).budget)
      .toEqual({ maxConcurrent: 8, maxConcurrentPerProvider: 2 })
  })

  it.each([0, -1, 1.5, 65, Number.NaN])('refuses %s and says so rather than clamping', value => {
    // Clamping a `0` would silently disable proactive refresh and give the operator
    // a dashboard that had stopped checking anything, with no reason for it anywhere.
    const { budget, problems } = resolveLookupBudget({ maxConcurrent: value, maxConcurrentPerProvider: 1 })
    expect(budget.maxConcurrent).toBe(DEFAULT_MAX_LOOKUPS)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/refresh\.maxConcurrentLookups/)
  })
})
