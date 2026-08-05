// What the refresh engine is spending, in numbers an operator can graph (plan U7).
//
// WHAT THESE ARE FOR, and it is not "is refresh working". The retired design failed
// quietly and expensively: 110 of 121 completed refreshes changed nothing and one
// session accumulated 43 tmux panes, and nothing anywhere was counting. Each counter
// below exists because there is a specific way this can go wrong that would otherwise
// only be visible as "my machine is busy".
//
// THE ONE GAUGE IS NOT A METRIC. `refresh_created_sessions` has an expected value of
// zero and every other value is corruption — a refresh cannot create a managed
// session, so a nonzero reading means a record survived reconciliation or the
// capability was reintroduced. It is here rather than only in the diagnostics dump
// because a dump has to be run and an alert does not.
//
// A SEPARATE REGISTRY, matching `turn-length.ts`: these are scraped alongside the
// existing series, and mixing them into one registry would make either module's
// lifecycle the other's problem.
//
// Server-only and React-free.

import { Counter, Gauge, Registry } from 'prom-client'

export const register = new Registry()

/** Machine checks that actually left the process. The denominator for everything
 *  else: a coalescing ratio is meaningless without it. */
export const hostChecks = new Counter({
  name: 'tinstar_refresh_host_checks_total',
  help: 'Host (machine-only) refresh checks that ran, by outcome',
  labelNames: ['outcome'],
  registers: [register],
})

/**
 * Requests answered by a lookup somebody else had already started.
 *
 * THE NUMBER THAT SHOULD GROW WITH FLEET SIZE while `host_checks` does not. That
 * divergence IS the property R8 asks for — Surface count cannot buy provider load —
 * and a deployment where these track each other has lost it.
 */
export const coalescedLookups = new Counter({
  name: 'tinstar_refresh_coalesced_lookups_total',
  help: 'Lookups answered by an identical request already in flight',
  labelNames: ['provider'],
  registers: [register],
})

/** Lookups the broker declined for want of a slot. Growing steadily means the budget
 *  is too small for the fleet — which is a decision, not a fault, but one an operator
 *  should get to make knowingly. */
export const deferredLookups = new Counter({
  name: 'tinstar_refresh_deferred_lookups_total',
  help: 'Lookups the shared broker declined because a budget was full',
  labelNames: ['provider'],
  registers: [register],
})

/**
 * Discrete human actions that authorized an agent refresh, split by whether they
 * started an attempt or joined one already running.
 *
 * `joined` climbing far above `started` is a UI sending intent too eagerly — the
 * server absorbs it correctly, but it is a signal worth seeing.
 */
export const humanIntents = new Counter({
  name: 'tinstar_refresh_human_intents_total',
  help: 'Human intents that reached the refresh engine, by outcome',
  labelNames: ['outcome'],
  registers: [register],
})

/** Refreshes that could not run because no foreground agent was live. High and
 *  rising means people are opening Surfaces whose owners have exited — a product
 *  signal, not an error rate. */
export const unavailableOwners = new Counter({
  name: 'tinstar_refresh_unavailable_owners_total',
  help: 'Agent refreshes that found no live foreground agent',
  registers: [register],
})

/**
 * Managed sessions any live refresh record claims to have created.
 *
 * EXPECTED ZERO. Not a load metric — the architecture makes this impossible, so any
 * reading above zero is a corrupt record or a reintroduced capability, and it should
 * page rather than trend.
 */
export const refreshCreatedSessions = new Gauge({
  name: 'tinstar_refresh_created_sessions',
  help: 'Managed sessions attributed to refresh. ALWAYS 0; any other value is corruption',
  registers: [register],
})

/** Jobs reconciled out of the removed background-worker architecture at boot. A
 *  one-time number per upgrade; it never grows afterwards. */
export const legacyJobsReconciled = new Counter({
  name: 'tinstar_refresh_legacy_jobs_reconciled_total',
  help: 'Refresh jobs terminalized because they belonged to the removed worker architecture',
  registers: [register],
})

/** Point the gauge at a diagnostics pass, so the invariant and the series cannot
 *  disagree about what "zero" means. */
export function publishRefreshDiagnostics(d: { refreshCreatedSessions: number }): void {
  refreshCreatedSessions.set(d.refreshCreatedSessions)
}
