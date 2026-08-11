// The closed set of machine checks a `host` recipe may name (R6/R7, KTD1/KTD6/KTD7).
//
// WHY THIS FILE IS THE AUTHORITY. Proactive refresh is work the host runs without a
// human asking, so what grants it has to be something an author cannot write. An
// author writes a NAME; membership in {@link HOST_RECIPE_KINDS} is the permission;
// and the handlers live here, in code, behind a registry that is constructed with a
// deps object containing NOTHING that could invoke a model, create a managed session,
// allocate a terminal, or delegate to an agent (R7). That is a structural guarantee
// rather than a rule: a handler cannot reach those capabilities because nothing hands
// them one.
//
// WHOLE SURFACES, NOT PATCHES (R2, KTD7). A handler returns a complete candidate
// replacement — headline and body — or it fails. It may consume claim observations,
// but only by rebuilding the entire Surface deterministically from them; there is no
// way for a handler to edit a region and leave the rest of somebody's card alone,
// because a Surface has one writer and one outcome.
//
// EVERY LOOKUP CROSSES THE BROKER. The handlers do not call `fetch` or spawn `git`
// themselves — they hand the broker a provider, a stable key, and a thunk. That is
// what makes twenty cards watching one ref cost one fetch instead of twenty (R8).
//
// FAILURES ARE DATA. A handler returns an outcome, never a rejection, so one
// provider being down cannot reject a sweep that is also looking at ninety-nine other
// Surfaces.
//
// Server-only and React-free.

import type {
  A2uiContent, SurfaceClaim, SurfaceContent, SurfaceHostRecipeKind, SurfaceRefreshRecipe,
} from '../../domain/types'
import type { SurfaceLookupBroker } from './surface-lookup-broker'
import { runWitness, witnessTimeoutMs, type WitnessDeps, type WitnessOutcome } from './witness-registry'

/**
 * Everything a host handler is given.
 *
 * READ THE ABSENCES. There is no session creator, no port allocator, no prompt
 * delivery, no model client, and no way to reach one — this object IS the handler's
 * whole world (R7). The witness deps it does carry are a bounded `exec` and a
 * narrowed `fetch`, both already audited for the claim-checking path.
 */
export interface HostRefreshDeps {
  broker: SurfaceLookupBroker
  witness: WitnessDeps
  /** Absolute worktree a repo-scoped check reads. Absent is not an error to
   *  pre-empt — the handler reports that it could not look. */
  worktree?: string
  /** Injected so a result's own timestamp is testable without waiting on a clock. */
  now: () => number
}

export type HostRefreshOutcome =
  /** A complete candidate replacement for the WHOLE Surface (R2). */
  | { status: 'replaced'; content: SurfaceContent; detail?: string }
  /** The check ran, and nothing about the Surface needed to change. Still a
   *  COMPLETED check: it advances `lastCheck` and leaves `lastKnownAt` alone. */
  | { status: 'unchanged'; detail?: string }
  /** The check ran and could not produce a result. */
  | { status: 'failed'; detail: string }
  /** There was no authorized way to run it — no worktree, no reachable source. */
  | { status: 'unavailable'; detail: string }
  /** The broker had no slot. NOTHING is recorded for this: see the broker's header. */
  | { status: 'deferred'; detail: string }

interface HostHandler {
  /** The shared resource this check asks, for the broker's per-provider budget. */
  provider: string
  /** Validate the author's parameters, or say what is wrong. Returns the SAME shape
   *  the recipe parser already refused unknown handlers with, so a bad parameter and
   *  a bad name read the same way to an author. */
  validate: (params: Record<string, string> | undefined) => { ok: true; claim: SurfaceClaim } | { ok: false; why: string }
  /** What two requests must share to be answerable by one lookup (R8). */
  lookupKey: (claim: SurfaceClaim, deps: HostRefreshDeps) => string
  /** Turn one completed lookup into a whole Surface. */
  build: (input: { claim: SurfaceClaim; outcome: WitnessOutcome; prior: SurfaceContent; at: number }) => HostRefreshOutcome
}

// --- http-status --------------------------------------------------------------

/**
 * Is this URL answering, and with what?
 *
 * MACHINE-ONLY BY CONSTRUCTION: one GET, redirects unfollowed, no body read, and no
 * interpretation of what the number MEANS — a card that wants to say "healthy" says
 * so in its own prose and re-derives that through an agent recipe. This handler
 * reports the observation and the time it was made, which is all a machine can
 * honestly claim.
 */
const httpStatus: HostHandler = {
  provider: 'http',
  validate: params => {
    const url = params?.url?.trim() ?? ''
    if (!url) return { ok: false, why: 'params.url is required' }
    return { ok: true, claim: { id: 'host', witness: 'http-status', locus: 'infra', params: { url } } }
  },
  // The URL and nothing else: two Surfaces watching one endpoint are asking one
  // question, whichever cards they are.
  lookupKey: claim => String(claim.params?.url ?? ''),
  build: ({ claim, outcome, prior, at }) => {
    const url = String(claim.params?.url ?? '')
    if (outcome.status === 'unresolved') return { status: 'unavailable', detail: outcome.detail }
    if (outcome.status === 'failed') return { status: 'failed', detail: outcome.detail }
    const code = outcome.value
    const headline = `${url} — HTTP ${String(code)}`
    // UNCHANGED IS NOT A NO-OP, it is the common answer: the endpoint is still
    // whatever it was. Reported explicitly so `lastCheck` advances and `lastKnownAt`
    // does not (KTD5) — which is exactly the distinction a single timestamp lost.
    if (prior.headline === headline) return { status: 'unchanged', detail: `still HTTP ${String(code)}` }
    return {
      status: 'replaced',
      content: { ...prior, headline, body: statusBody(url, code, at) },
      detail: `now HTTP ${String(code)}`,
    }
  },
}

function statusBody(url: string, code: unknown, at: number): A2uiContent {
  return {
    root: 'root',
    components: [
      { id: 'root', component: 'Column', children: ['what', 'when'] },
      { id: 'what', component: 'Text', text: `${url} answered ${String(code)}.` },
      { id: 'when', component: 'Text', variant: 'caption', text: `Checked ${new Date(at).toISOString()}.` },
    ],
  }
}

// --- unit-landed --------------------------------------------------------------

/**
 * Has this plan unit landed on the tracked ref?
 *
 * THE LOOKUP KEY IS THE REF, NOT THE UNIT, and that is the whole reason this handler
 * is worth having. The expensive step is one `git fetch` of the remote-tracking ref;
 * every unit of every plan watching that ref is answered by the same fetch. Keying on
 * the unit would make the cost linear in units again, which is the shape R8 forbids.
 * The per-unit reading is cheap and happens after, inside one lookup.
 */
const unitLanded: HostHandler = {
  provider: 'git',
  validate: params => {
    const plan = params?.plan?.trim() ?? ''
    const unit = params?.unit?.trim() ?? ''
    if (!plan) return { ok: false, why: 'params.plan is required' }
    if (!unit) return { ok: false, why: 'params.unit is required' }
    const claimParams: Record<string, string> = { plan, unit }
    if (params?.ref?.trim()) claimParams.ref = params.ref.trim()
    return { ok: true, claim: { id: 'host', witness: 'unit-landed', locus: 'repo', params: claimParams } }
  },
  lookupKey: (claim, deps) =>
    `${deps.worktree ?? ''} ${String(claim.params?.ref ?? 'origin/main')} ${String(claim.params?.unit ?? '')}`,
  build: ({ claim, outcome, prior, at }) => {
    const unit = String(claim.params?.unit ?? '')
    if (outcome.status === 'unresolved') return { status: 'unavailable', detail: outcome.detail }
    if (outcome.status === 'failed') return { status: 'failed', detail: outcome.detail }
    const headline = `${unit} — ${String(outcome.value)}`
    if (prior.headline === headline) return { status: 'unchanged', detail: `still ${String(outcome.value)}` }
    return {
      status: 'replaced',
      content: { ...prior, headline, body: landedBody(unit, outcome.value, at) },
      detail: `now ${String(outcome.value)}`,
    }
  },
}

function landedBody(unit: string, value: unknown, at: number): A2uiContent {
  return {
    root: 'root',
    components: [
      { id: 'root', component: 'Column', children: ['what', 'when'] },
      { id: 'what', component: 'Text', text: `${unit} is ${String(value)} on the tracked ref.` },
      { id: 'when', component: 'Text', variant: 'caption', text: `Checked ${new Date(at).toISOString()}.` },
    ],
  }
}

// --- the registry -------------------------------------------------------------

const REGISTRY: Readonly<Record<SurfaceHostRecipeKind, HostHandler>> = {
  'http-status': httpStatus,
  'unit-landed': unitLanded,
}

/** Every handler this host implements, for a diagnostic that wants to prove the
 *  union and the registry agree rather than assert it. */
export function hostRecipeHandlers(): readonly SurfaceHostRecipeKind[] {
  return Object.keys(REGISTRY) as SurfaceHostRecipeKind[]
}

/**
 * Run one host recipe and return a whole-Surface outcome.
 *
 * NEVER REJECTS, for the same reason the broker does not: this is called from a pass
 * that is also looking at other Surfaces, and one of them failing may not take the
 * rest down.
 *
 * DEFERRAL IS PASSED STRAIGHT THROUGH, unmapped. It is not a failure and not an
 * outcome — the caller records nothing for it and asks again on a later pass (R8).
 */
export async function runHostRecipe(input: {
  recipe: Extract<SurfaceRefreshRecipe, { kind: 'host' }>
  prior: SurfaceContent
  deps: HostRefreshDeps
}): Promise<HostRefreshOutcome> {
  const { recipe, prior, deps } = input
  const handler = REGISTRY[recipe.handler]
  if (!handler) {
    // Unreachable through the parser, which refuses an unregistered name. Kept
    // because the union and this table are two lists, and a member added to one and
    // not the other must fail loudly rather than silently never run.
    return { status: 'failed', detail: `no host handler is registered for "${recipe.handler}"` }
  }
  const checked = handler.validate(recipe.params)
  if (!checked.ok) return { status: 'failed', detail: `its "${recipe.handler}" check ${checked.why}` }

  const result = await deps.broker.lookup<WitnessOutcome>({
    provider: handler.provider,
    key: handler.lookupKey(checked.claim, deps),
    // `runWitness` is the audited lookup — the same code path the claim checker uses,
    // including its own timeout and its never-rejects guarantee. Reusing it means a
    // host recipe and a claim of the same kind cannot disagree about what the world
    // says, which they would if this file re-implemented the read.
    run: () => runWitness({
      claim: checked.claim,
      ...(deps.worktree ? { worktree: deps.worktree } : {}),
      deps: deps.witness,
      ...(witnessTimeoutMs(checked.claim.witness) !== undefined
        ? { timeoutMs: witnessTimeoutMs(checked.claim.witness)! }
        : {}),
    }),
  })

  if (result.status === 'deferred') return { status: 'deferred', detail: result.detail }
  if (result.status === 'threw') {
    return { status: 'failed', detail: `the "${recipe.handler}" check threw: ${String(result.error)}` }
  }
  return handler.build({ claim: checked.claim, outcome: result.value, prior, at: deps.now() })
}
