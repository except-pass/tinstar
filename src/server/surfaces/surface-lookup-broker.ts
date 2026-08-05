// The one place proactive host work is allowed to leave the process (R8, KTD6).
//
// WHAT THIS FIXES. Before it, every bound was per-Surface: each claim got its own
// budget, each witness pass got its own fan-out cap, and a provider had no
// representation anywhere. So the load a provider saw was linear in SURFACE COUNT —
// twenty cards watching `origin/main` meant twenty `git fetch` calls of the same ref
// on the same commit, and the way to make it worse was to author more cards. That is
// exactly the shape R8 forbids: "Surface count cannot bypass a provider limit."
//
// THREE MECHANISMS, and each one closes a different door:
//
//   · A GLOBAL semaphore, so the host as a whole is bounded however many providers
//     are involved.
//   · A PER-PROVIDER semaphore, so one slow or rate-limited provider cannot be
//     hammered even when the global budget is free.
//   · An IN-FLIGHT MAP keyed by provider plus a stable lookup key, so two Surfaces
//     asking the same question share one answer. This is the one that makes Surface
//     count stop mattering: the second asker consumes no slot at all.
//
// DEFERRAL IS NOT FAILURE, and keeping them apart is load-bearing (R8/R18). A request
// that finds no slot returns `deferred` and the caller records NOTHING — no completed
// check, no failure, no timestamp. A deferral is the host declining to look, and
// writing it down as a check would both lie about what happened and, because a
// recorded check moves the deadline, hide the backlog it is supposed to make visible.
//
// NON-BLOCKING ON PURPOSE. A broker that queued would turn a budget into a latency
// and leave the caller holding a promise for as long as the backlog is deep; the
// sweep that called it runs every few seconds and will simply ask again. The one
// thing a caller DOES wait for is an identical lookup already in flight, because
// waiting there costs nothing and saves a provider call.
//
// Server-only and React-free. It reaches nothing itself — every lookup arrives as a
// thunk the caller supplies — which is what lets the registry stay incapable of
// anything but the work it was handed.

/** Default concurrent host lookups across the whole process (KTD6). Four: enough
 *  that one slow provider does not idle the others, small enough that an idle
 *  dashboard never looks busy from outside. */
export const DEFAULT_MAX_LOOKUPS = 4

/** Default concurrent lookups against ONE provider (KTD6). One, deliberately: a
 *  provider is a shared, often rate-limited resource that Tinstar does not own, and
 *  the coalescing map means the common burst — many Surfaces, one question — needs
 *  no more than one slot anyway. */
export const DEFAULT_MAX_PER_PROVIDER = 1

export interface LookupBudget {
  maxConcurrent: number
  maxConcurrentPerProvider: number
}

/**
 * Validate an operator's budget override (KTD6).
 *
 * REFUSED RATHER THAN CLAMPED. A `0` would silently disable proactive refresh
 * entirely and a `-1` would do something undefined; either way the operator would
 * see a dashboard that had quietly stopped checking anything and no reason for it.
 * Falls back to the shipped defaults and says so.
 */
export function resolveLookupBudget(over: Partial<LookupBudget> | undefined): {
  budget: LookupBudget
  problems: string[]
} {
  const problems: string[] = []
  const bounded = (value: number | undefined, name: string, fallback: number): number => {
    if (value === undefined) return fallback
    if (!Number.isInteger(value) || value < 1 || value > 64) {
      problems.push(`${name} must be a whole number between 1 and 64; using the default of ${fallback}`)
      return fallback
    }
    return value
  }
  const maxConcurrent = bounded(over?.maxConcurrent, 'refresh.maxConcurrentLookups', DEFAULT_MAX_LOOKUPS)
  const perProvider = bounded(
    over?.maxConcurrentPerProvider, 'refresh.maxConcurrentLookupsPerProvider', DEFAULT_MAX_PER_PROVIDER,
  )
  return { budget: { maxConcurrent, maxConcurrentPerProvider: perProvider }, problems }
}

/** One request for something outside the process. */
export interface LookupRequest<T> {
  /** Who is being asked — `git`, `http`, a named API. Budgets and coalescing are
   *  both scoped to this, so it must name the SHARED RESOURCE and not the caller. */
  provider: string
  /**
   * What is being asked, stably.
   *
   * Two requests with the same provider and key MUST be answerable by one result,
   * because that is exactly what the in-flight map will do with them. It is the
   * caller's job to make the key carry everything that changes the answer — a URL, a
   * worktree plus a ref — and nothing that does not, or Surfaces that could have
   * shared a lookup will each pay for their own.
   */
  key: string
  /** The work. Called at most once per (provider, key) in flight. */
  run: () => Promise<T>
}

export type LookupResult<T> =
  /** The lookup ran, or joined one already running. `coalesced` says which. */
  | { status: 'done'; value: T; coalesced: boolean }
  /** No slot was free. Nothing ran, nothing is recorded, ask again later. */
  | { status: 'deferred'; detail: string }
  /**
   * The thunk threw.
   *
   * A VARIANT RATHER THAN A REJECTION, so one provider's failure cannot reject the
   * sweep that is also looking at ninety-nine other Surfaces (R8). Callers are
   * expected to return their own failures as data — `runWitness` and the host
   * registry both do — so reaching this means a defect, and it is reported as one
   * instead of taking the pass down.
   */
  | { status: 'threw'; error: unknown }

/** What one broker has done, for diagnostics and for the tests that prove the
 *  bounds are real rather than described. */
export interface LookupBrokerStats {
  /** Lookups that actually left the process. */
  ran: number
  /** Requests answered by an in-flight lookup somebody else started — the number
   *  that has to stay flat as Surface count grows. */
  coalesced: number
  /** Requests refused a slot. A number that only ever grows is a budget set too low
   *  for the fleet, which is a thing an operator should be able to see. */
  deferred: number
  /** In flight right now, globally. */
  active: number
}

/**
 * The process-wide broker.
 *
 * ONE INSTANCE PER HOST. Two brokers would each enforce the budget faithfully and
 * the provider would see twice it, which is the failure this class exists to
 * prevent — so the wiring constructs exactly one and hands it to everything that
 * looks outward.
 */
export class SurfaceLookupBroker {
  private activeGlobal = 0
  private readonly activePerProvider = new Map<string, number>()
  /** `provider\0key` → the promise the first asker started. */
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private ran = 0
  private coalescedCount = 0
  private deferredCount = 0

  constructor(private budget: LookupBudget = {
    maxConcurrent: DEFAULT_MAX_LOOKUPS,
    maxConcurrentPerProvider: DEFAULT_MAX_PER_PROVIDER,
  }) {}

  /** Replace the budget at runtime. Existing in-flight work is unaffected; the new
   *  bound applies to the next request that asks for a slot. */
  setBudget(budget: LookupBudget): void {
    this.budget = budget
  }

  stats(): LookupBrokerStats {
    return {
      ran: this.ran,
      coalesced: this.coalescedCount,
      deferred: this.deferredCount,
      active: this.activeGlobal,
    }
  }

  /**
   * Ask for something outside the process, under the budget.
   *
   * NEVER REJECTS. A caller sweeping a hundred Surfaces must not be left holding an
   * unhandled rejection, and — more to the point — one provider's failure must not
   * reject the whole sweep. A thunk that throws produces a rejected `value` for the
   * askers who joined it and nothing else: the failure is data (R8's "return failures
   * as data"), and the caller decides what it means for its own Surface.
   */
  async lookup<T>(req: LookupRequest<T>): Promise<LookupResult<T>> {
    const id = `${req.provider} ${req.key}`

    // JOINING COSTS NO SLOT, and that is the whole point of the map: the second
    // Surface asking the same question is free, so Surface count stops multiplying
    // provider load. Checked before the semaphores for exactly that reason — gating
    // it on a free slot would make a burst of identical questions defer most of
    // itself for no benefit.
    const joined = this.inFlight.get(id) as Promise<T> | undefined
    if (joined) {
      this.coalescedCount++
      try {
        return { status: 'done', value: await joined, coalesced: true }
      } catch (error) {
        // The lookup we joined threw. That is the STARTER's defect, and every joiner
        // learns about it the same way rather than one of them rejecting.
        return { status: 'threw', error }
      }
    }

    const perProvider = this.activePerProvider.get(req.provider) ?? 0
    if (this.activeGlobal >= this.budget.maxConcurrent) {
      this.deferredCount++
      return {
        status: 'deferred',
        detail: `the host is already running ${this.activeGlobal} lookups (its limit)`,
      }
    }
    if (perProvider >= this.budget.maxConcurrentPerProvider) {
      this.deferredCount++
      return {
        status: 'deferred',
        detail: `${req.provider} is already being asked ${perProvider} question(s) (its limit)`,
      }
    }

    this.activeGlobal++
    this.activePerProvider.set(req.provider, perProvider + 1)
    this.ran++
    // The promise goes in the map BEFORE the first await, so a second caller
    // arriving in the same tick joins it rather than starting a second lookup.
    const running = (async () => req.run())()
    this.inFlight.set(id, running)
    // Attached immediately so a rejection that nobody joins is still observed here
    // rather than surfacing as an unhandled rejection on the process.
    running.catch(() => { /* reported through the result below */ })
    try {
      return { status: 'done', value: await running, coalesced: false }
    } catch (error) {
      return { status: 'threw', error }
    } finally {
      this.inFlight.delete(id)
      this.activeGlobal--
      const now = (this.activePerProvider.get(req.provider) ?? 1) - 1
      if (now <= 0) this.activePerProvider.delete(req.provider)
      else this.activePerProvider.set(req.provider, now)
    }
  }
}
