// The Run Workspace projection over canonical Surfaces (plan KTD3, U2).
//
// KTD3: "Run Workspace remains a projection over canonical Surfaces … `Run.slate`
// delegates reads and writes through aliases, so Canvas and Run Workspace never
// receive separate writable copies." This module is the READ half of that — pure
// functions from a canonical `Surface` to the two legacy shapes the existing client
// and the existing run-scoped routes already speak.
//
// Until U2 the derivation ran off the legacy `SlateStore`, which was correct while
// the legacy bridge was still the write path. U2 swaps the input, and this is where
// it swaps to.
//
// THREE LEGACY FIELDS DO NOT COME BACK, by author ruling, and it is worth naming
// them here because their absence is the visible difference a user sees:
//   · `anchor` — the card-vs-row distinction it encodes does not exist in the target
//     model, which renders every Surface through one shell. A `kind:'diagram'`
//     surface now projects as an ordinary `open-point`;
//   · `group` — the S4 workbench band. Grouping in the canonical model is a
//     container Surface with children, a SHAPE rather than a field, so a grouped set
//     projects as ordinary rows;
//   · `stalledAt` — the dead-writer marker. Nothing in the canonical record models
//     it; freshness carries the equivalent signal in its own vocabulary.
//
// Server-only and React-free.

import {
  OBJECTIVE_ORDER,
  OBJECTIVE_POINT_ID,
  type A2uiContent,
  type Point,
  type SlateSurface,
  type Surface,
  type SurfaceClaimObservation,
  type SurfaceCompatAlias,
  type SurfaceRefreshRecipe,
} from '../../domain/types'

/** The compatibility alias a Surface carries for `runId`, if any. A Surface may
 *  hold several (KTD3); only this run's is the one the legacy view addresses it by. */
export function runAliasOf(s: Surface, runId: string): SurfaceCompatAlias | undefined {
  return (s.aliases ?? []).find(a => a.bucket.kind === 'run' && a.bucket.runId === runId)
}

/**
 * Is this Surface part of the run's legacy Slate presentation?
 *
 * Two INDEPENDENT exclusions:
 *   · `compatibilityOnly` — the per-run root. It is migration scaffolding that
 *     CONTAINS the run's surfaces; rendering it inside the list it contains would
 *     put a "run root" row into the user's Slate. Today every root also carries a
 *     hidden alias, so either gate alone would exclude it; this one is on the
 *     PROPERTY rather than on a flag a later mutation could flip;
 *   · an invisible alias — closing a legacy presentation hides the alias and never
 *     deletes the canonical Surface (KTD3).
 */
export function inRunSlate(s: Surface, alias: SurfaceCompatAlias | undefined): alias is SurfaceCompatAlias {
  return !!alias && alias.visible && !s.compatibilityOnly
}

/** True when this Surface is the run's USER-owned Objective (S2) — the pinned goal
 *  card. The reserved alias id plus canonical-direct authority plus a user author,
 *  which is exactly the `source === 'user' && id === OBJECTIVE_POINT_ID` test the
 *  legacy derivation used, expressed in canonical fields. */
export function isObjectiveSurface(s: Surface, localId: string): boolean {
  return localId === OBJECTIVE_POINT_ID && s.contentAuthority === 'canonical-direct' && s.author === 'user'
}

/**
 * Does this Surface declare nothing that could prove it wrong (R18, plan U7)?
 *
 * THE TRI-STATE COLLAPSES HERE AND ONLY HERE (KTD4). `claims` absent means the author
 * never said; `claims: []` means the author checked and found nothing witnessable.
 * The two are kept apart all the way through the file round trip because the egress
 * adapter writes the field back into the author's own file — but they are the same
 * fact to a reader, because neither leaves the host anything it could check.
 *
 * DERIVED, NEVER STORED (KTD1). Adding a sixth `SurfaceFreshnessPhase` for this would
 * put a value into a union the service and the coordinator switch on exhaustively, to
 * carry a fact neither of them asks about — R18 is explicit that `unwitnessed` gates
 * no controls and changes no scheduling. The cost is that it is not a stored fact and
 * so cannot be queried server-side; nothing wants to.
 */
export function isUnwitnessed(s: Surface): boolean {
  return !s.content.claims || s.content.claims.length === 0
}

/**
 * How many step entries one `Stepper` is examined for a claim binding.
 *
 * Mirrors the catalog's own `MAX_SCAN` (60 rows × 20) rather than importing it: that
 * constant lives in `a2ui/catalog.tsx`, a React module the server bundle may not
 * pull in. The bound is for the same reason the catalog's is — `steps` expands one
 * A2UI node into an unbounded array, and this walk runs on every projection of every
 * Surface on every run, which is the hottest loop the storm guard sits behind.
 */
const MAX_BOUND_STEPS = 1200

/**
 * Fill a `Stepper`'s step statuses in from what the host last WITNESSED (R22, plan U8).
 *
 * THE POINT IS THAT NO AGENT IS INVOLVED. A roadmap card authored once says which
 * claim decides each step; every later status on it is the host's own observation,
 * so the card tells the truth about the repository between rebuilds instead of
 * asserting whatever its author believed on the day it was written.
 *
 * THE BINDING, and why it takes two keys rather than one:
 *
 *   { "label": "U2 — …", "claim": "u2", "done": "landed" }
 *
 * `claim` names a {@link SurfaceClaim.id} on this same Surface — R1's "referenced
 * from components by id". `done` names the observed VALUE that means finished. The
 * host owns no vocabulary here: `unit-landed` answers `landed`/`pending` and
 * `http-status` answers a number, and a projection that knew which strings meant
 * success would have to be edited every time a witness kind shipped.
 *
 * EVERY OTHER CASE IS `pending`, deliberately, including a step whose `done` is
 * missing or whose `claim` names nothing. There are only four step statuses and none
 * of them means "unknown", so the alternative would be leaving the AUTHORED status in
 * place — which is exactly the agent-asserted status R22 exists to remove, and it
 * would fail silently: a typo in `claim` would render a permanent green tick. A card
 * whose claim nobody could resolve says so separately, in the "claim not checked"
 * line the freshness badge draws from `problem`.
 *
 * A STALE VALUE STILL COUNTS. When the last attempt failed but an earlier completed
 * lookup left a value, the step reads from that value: a fetch that could not run
 * says nothing about whether the world moved, and blanking the rail on a transient
 * outage would report a change that did not happen.
 *
 * PROJECTION-TIME ONLY. The record keeps the author's own statuses, so the egress
 * adapter writes the author's file back unchanged; this is a read on the way out.
 * Returns the SAME body object when nothing bound, so an unbound Surface costs the
 * document store's `JSON.stringify` comparison nothing extra.
 *
 * NOT WHEN AN AGENT OWNS THE REBUILD (KTD7, R1/R2/R5). A Surface has ONE writer and
 * one outcome, and binding here is the host writing part of a card. The question is
 * therefore not "is this card interesting" but "would the host be editing underneath
 * somebody else":
 *
 *   · `host` recipe — the host owns the rebuild outright and returns the whole
 *     Surface. Binding is the same writer doing the same job, cheaply, between
 *     rebuilds. Allowed.
 *   · NO recipe — nothing rebuilds this card at all. The author wrote it once and
 *     declared the rail derived; there is no competing writer for the host to race,
 *     and refusing to bind would leave a rail the author deliberately left blank
 *     blank forever. Allowed.
 *   · `agent` recipe — the agent owns the prose and will rewrite it. Binding here is
 *     the host editing a region of somebody else's card, which is exactly what left
 *     one card saying two things: a rail describing today and prose describing
 *     whenever the author last looked, with nothing marking which half was older.
 *     REFUSED — the observation still marks the Surface dirty, so drift is still
 *     detected; it just does not get written.
 *   · `unreadable` — the host could not tell what rebuilds this. Refused for the same
 *     reason unknown recipes fail toward the human everywhere else.
 */
export function bindClaimSteps(
  body: A2uiContent | undefined,
  observations: Record<string, SurfaceClaimObservation> | undefined,
  recipe?: SurfaceRefreshRecipe,
): A2uiContent | undefined {
  if (!body) return body
  if (recipe !== undefined && recipe.kind !== 'host') return body
  let bodyChanged = false
  const components = body.components.map(component => {
    if (component.component !== 'Stepper' || !Array.isArray(component.steps)) return component
    const raw: unknown[] = component.steps
    let stepsChanged = false
    const steps = raw.slice()
    const limit = Math.min(raw.length, MAX_BOUND_STEPS)
    for (let i = 0; i < limit; i++) {
      const entry: unknown = raw[i]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const step = entry as Record<string, unknown>
      if (typeof step.claim !== 'string' || !step.claim) continue
      const status = claimStepStatus(step, observations)
      if (step.status === status) continue
      steps[i] = { ...step, status }
      stepsChanged = true
    }
    if (!stepsChanged) return component
    bodyChanged = true
    return { ...component, steps }
  })
  return bodyChanged ? { ...body, components } : body
}

/** `done` when a completed lookup's stored value is exactly the step's `done`
 *  value, and `pending` for everything else — see {@link bindClaimSteps}. */
function claimStepStatus(
  step: Record<string, unknown>,
  observations: Record<string, SurfaceClaimObservation> | undefined,
): 'done' | 'pending' {
  const observed = observations?.[step.claim as string]
  if (!observed || !('value' in observed)) return 'pending'
  const done: unknown = step.done
  // Scalars only, matching `SurfaceClaimValue`. An object `done` could never equal a
  // witness value, so refusing it here is documentation rather than a behaviour change.
  if (done !== null && typeof done !== 'string' && typeof done !== 'number' && typeof done !== 'boolean') {
    return 'pending'
  }
  return Object.is(observed.value, done) ? 'done' : 'pending'
}

/** One canonical Surface as the client-facing `Run.slate` entry it aliases. */
export function slateSurfaceFromCanonical(s: Surface, localId: string): SlateSurface {
  const objective = isObjectiveSurface(s, localId)
  const body = bindClaimSteps(s.content.body, s.freshness.claimObservations, s.content.recipe)
  return {
    id: localId,
    author: s.author,
    kind: objective ? 'objective' : 'open-point',
    // The objective is FORCED to its pin sentinel rather than storing one, so
    // whatever order it happens to carry cannot strand it mid-list.
    order: objective ? OBJECTIVE_ORDER : s.order ?? s.createdAt,
    ...(body ? { body } : {}),
    // THE TYPED RECIPE, not a rendered string. The panel has to tell an agent
    // recipe (which only a human's deliberate interaction may run) from a host one
    // (which the host keeps warm by itself) to decide what its controls mean.
    ...(s.content.recipe ? { refresh: s.content.recipe } : {}),
    // The author's CLAIM about the work, beside the status rather than in it. The
    // panel needs both: `discussing` says the agent spoke last, and only the proposal
    // can say whether that was an answer awaiting a ruling or work already shipped.
    ...(s.content.proposal ? { proposal: s.content.proposal } : {}),
    headline: s.content.headline,
    status: s.thread.status,
    ...(s.thread.replies.length > 0 ? { thread: s.thread.replies } : {}),
    // U6's freshness, carried whole rather than flattened to a badge string. The
    // panel needs the phase, the reason, the deadline, AND `overdue` — which is
    // orthogonal to the phase — and a pre-rendered label would have to pick one.
    // The Objective is excluded: it is the user's own prose with no source to be
    // stale against, and an amber "unverified" on a goal the user just typed would
    // be nonsense.
    //
    // `unwitnessed` rides in the SAME exclusion, and for the same reason (U7). It is
    // true of the Objective — the user's goal declares no claims — but "nothing to
    // check" printed under a sentence the user typed thirty seconds ago is the same
    // nonsense one field over. Emitted only when true, so a witnessed surface adds no
    // key: `Run.slate` is compared by `JSON.stringify` in the document store's storm
    // guard, and every constant key costs bytes on every comparison of every run.
    ...(objective ? {} : { freshness: s.freshness, ...(isUnwitnessed(s) ? { unwitnessed: true } : {}) }),
    createdAt: s.createdAt,
    amendedAt: s.amendedAt,
  }
}

/**
 * One canonical Surface as the legacy `Point` the run-scoped routes read.
 *
 * `source` is derived from content authority rather than stored: a Surface the file
 * reconciler owns is `'file'`, and one the record itself owns is `'user'`. That is
 * the same pairing the migration wrote in the other direction, so a point that made
 * the round trip comes back as what it went in as.
 *
 * The claim binding is applied HERE TOO, and that is the whole reason it is a shared
 * function rather than three lines inside the slate projection. These are two
 * projections of ONE record: a card whose rail says `done` in `Run.slate` and
 * `pending` through the point routes is a card that disagrees with itself depending
 * on which door you read it through. This is a READ shape — every write path takes
 * its content from a request body — so a derived status here never reaches the record.
 */
export function pointFromCanonical(s: Surface, runId: string, localId: string): Point {
  const body = bindClaimSteps(s.content.body, s.freshness.claimObservations, s.content.recipe)
  return {
    id: localId,
    runId,
    author: s.author,
    source: s.contentAuthority === 'source-binding' ? 'file' : 'user',
    headline: s.content.headline,
    ...(body ? { content: body } : {}),
    ...(s.content.recipe ? { refresh: s.content.recipe } : {}),
    ...(s.content.proposal ? { proposal: s.content.proposal } : {}),
    ...(s.order != null ? { order: s.order } : {}),
    status: s.thread.status,
    replies: s.thread.replies,
    createdAt: s.createdAt,
    amendedAt: s.amendedAt,
    ...(s.thread.resolvedAt != null ? { resolvedAt: s.thread.resolvedAt } : {}),
    ...(s.thread.dismissedAt != null ? { dismissedAt: s.thread.dismissedAt } : {}),
    ...(s.thread.supersededAt != null ? { supersededAt: s.thread.supersededAt } : {}),
  }
}
