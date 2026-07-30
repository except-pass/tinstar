// The closed trigger vocabulary and what it makes stale (plan U6, R14/R15).
//
// This module is PURE. It parses author declarations, normalizes host observations
// onto a typed event, decides which Surfaces an event makes possibly-stale, and
// coalesces repeated events onto one host generation. It commits nothing and
// launches nothing — the coordinator does that, and keeping the decision separable
// is what makes "repeated equivalent events create one queued job" testable without
// a store.
//
// THE ORDERING RULE, because it is the easiest thing here to get wrong (KTD10):
// content hashes, Git SHAs, and process ids are EVIDENCE. They are compared for
// equality and nothing else. The only thing this module orders is the host-owned
// monotonic observation generation, which is why `coalesceGeneration` takes a max
// of numbers and never looks at `evidence` at all.
//
// Server-only and React-free.

import type {
  Surface,
  SurfaceClaim,
  SurfaceClaimLocus,
  SurfaceRefreshDeclaration,
  SurfaceRefreshPolicy,
  SurfaceStaleReason,
  SurfaceTriggerKind,
} from '../../domain/types'

/** Every kind the host implements. The parser accepts nothing outside it. */
export const TRIGGER_KINDS: readonly SurfaceTriggerKind[] = [
  'source-content',
  'git-revision',
  'process-exit',
  'session-lifecycle',
  'human-intent',
  'semantic-signal',
  'periodic',
]

const POLICIES: readonly SurfaceRefreshPolicy[] = ['automatic', 'mark-stale', 'manual']

/** Every locus a claim may observe. Closed, and separate from {@link TRIGGER_KINDS}
 *  for the reason stated on {@link SurfaceClaimLocus}. U5's narrowing predicate
 *  reads this. */
export const CLAIM_LOCI: readonly SurfaceClaimLocus[] = ['repo', 'infra']

/**
 * Which trigger kinds a claim at each locus can be invalidated BY (R5, plan U3/U5).
 *
 * `periodic` is on BOTH deliberately. A locus says where the observation is made,
 * not what announces it, and elapsed time can invalidate any observation whatever —
 * which is exactly the deadline R14 says declaring claims earns. Leaving it off
 * `infra` would give an infra-only Surface no trigger at all and no way for a
 * passing revalidation to answer the deadline that produced it.
 *
 * Nothing announces infra movement except time passing, so `infra` gets only that.
 * `repo` additionally gets `git-revision`, which is what a commit on the bound
 * worktree arrives as.
 *
 * Read by two callers with opposite jobs, which is why it is one table: U5 narrows
 * INBOUND triggers with it (a commit reaches no infra-only Surface), and U3's
 * witness barrier narrows what a pass may CLEAR with it (a `human-intent` or
 * `semantic-signal` reason is not something a claim witness answers).
 */
export const CLAIM_LOCUS_TRIGGER_KINDS: Readonly<Record<SurfaceClaimLocus, readonly SurfaceTriggerKind[]>> = {
  repo: ['git-revision', 'periodic'],
  infra: ['periodic'],
}

/** True when some claim on this Surface observes a locus that `kind` can invalidate.
 *  False for a Surface declaring no claims — it observes nothing, so a witness pass
 *  on it may clear nothing and an inbound trigger is narrowed by nothing. */
export function claimsObserveTriggerKind(
  claims: readonly SurfaceClaim[] | undefined, kind: SurfaceTriggerKind,
): boolean {
  return !!claims?.some(c => CLAIM_LOCUS_TRIGGER_KINDS[c.locus]?.includes(kind))
}

/** Bounds on what an author may declare, so a hostile or runaway file cannot make
 *  the matcher walk a large list on every event. */
const MAX_DECLARED = 32
const MAX_DECLARED_LEN = 256

/** Bounds on a claims declaration, in the same refuse-never-truncate style the
 *  service's own caps are documented in: a truncated declaration is a Surface that
 *  says it is witnessed by fewer things than its author wrote, and silently.
 *
 *  {@link MAX_SURFACE_CLAIMS} is exported because the HTTP door has to REFUSE at the
 *  same number the file door drops at, or the two authoring channels would disagree
 *  about what a Surface may declare. */
export const MAX_SURFACE_CLAIMS = 32
const MAX_CLAIM_PARAMS = 16
/** A parameter value is a URL or a document path, not prose — bounded well below the
 *  32 KiB an A2UI body gets, so no claim list can dominate the sidecar. */
const MAX_CLAIM_PARAM_LEN = 1024

/** Shortest interval an author may ask for. A one-second `intervalMs` on a dozen
 *  surfaces is a refresh storm, and the cap would absorb it as a permanently full
 *  queue rather than as an error anyone could see. */
export const MIN_INTERVAL_MS = 60_000

/**
 * One host observation, normalized (plan U6: "Normalize observations onto the
 * typed local EventBus with stable source identifiers, evidence values, and
 * deduplication keys").
 */
export interface SurfaceTriggerEvent {
  kind: SurfaceTriggerKind
  /** Stable identifier for WHAT was observed: a source locator, a worktree path,
   *  a session name, a process identity. Adapter-scoped and compared for equality. */
  sourceId: string
  /** Opaque evidence for this observation. Equality only — never ordered. */
  evidence?: string
  /** The named signal, for `semantic-signal`. Ignored for every other kind. */
  signal?: string
  /** Scope hints, so matching does not have to consider every Surface in the
   *  store. Absent means "unscoped" and only declaration matching applies. */
  runId?: string
  worktree?: string
  at: number
}

/**
 * One Surface an event makes possibly-stale, with the reason to record.
 *
 * `generation` is deliberately NOT part of what the matcher produces: the host
 * generation a reason is recorded at is the one the durable commit ALLOCATES, and
 * a number computed here would be the value before the advance — off by one, and
 * wrong in exactly the direction that would let a superseded result claim current.
 */
export interface SurfaceTriggerMatch {
  surface: Surface
  reason: Omit<SurfaceStaleReason, 'generation'>
  policy: SurfaceRefreshPolicy
}

// --- Author declarations ---------------------------------------------------

function strings(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const s = v.trim()
    if (!s || s.length > MAX_DECLARED_LEN || out.includes(s)) continue
    out.push(s)
    if (out.length >= MAX_DECLARED) break
  }
  return out.length > 0 ? out : undefined
}

/**
 * Parse an author's `refresh` declaration out of an untrusted file.
 *
 * DROPS rather than refuses: an unknown trigger name, an out-of-vocabulary policy,
 * or an `{ exec: "..." }` watcher declaration leaves a Surface with the host
 * defaults instead of failing its whole entry. That is the plan's test scenario
 * "trigger matching ignores arbitrary NATS payload strings and unsupported
 * executable watcher declarations" — the file still projects, it just gets no
 * trigger it did not earn.
 *
 * Returns `undefined` when nothing survived, so the record carries no declaration
 * at all rather than an empty object the store would have to serialize.
 */
export function parseRefreshDeclaration(raw: unknown): SurfaceRefreshDeclaration | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>

  const policy = typeof obj.policy === 'string' && (POLICIES as readonly string[]).includes(obj.policy)
    ? obj.policy as SurfaceRefreshPolicy
    : undefined

  const triggers: SurfaceTriggerKind[] = []
  if (Array.isArray(obj.triggers)) {
    for (const t of obj.triggers) {
      // The whole guard, in one line: an entry has to BE a name in the closed
      // vocabulary. A `{ exec: 'make check' }` watcher declaration is an object,
      // not a name, so it never reaches anything that could run it.
      if (typeof t !== 'string') continue
      const kind = t.trim() as SurfaceTriggerKind
      if (!TRIGGER_KINDS.includes(kind) || triggers.includes(kind)) continue
      triggers.push(kind)
    }
  }

  const rawInterval = obj.intervalMs
  const intervalMs = typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval > 0
    ? Math.max(MIN_INTERVAL_MS, Math.floor(rawInterval))
    : undefined

  const sources = strings(obj.sources)
  const signals = strings(obj.signals)

  if (!policy && triggers.length === 0 && intervalMs === undefined && !sources && !signals) return undefined
  return {
    policy: policy ?? 'automatic',
    triggers,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(sources ? { sources } : {}),
    ...(signals ? { signals } : {}),
  }
}

// --- Author claims ---------------------------------------------------------

/**
 * Parse one claim out of an untrusted file entry or request body.
 *
 * Returns the claim, or a MESSAGE saying why it was refused. Two callers want
 * opposite things from a bad claim and both are right: the file door drops it and
 * keeps projecting the Surface (KTD5 — a mistyped witness kind must not take a card
 * off the canvas), while the HTTP door refuses the request and names the field, the
 * posture every other content field on that endpoint already has. One parser, two
 * dispositions, so the two doors cannot drift on what a VALID claim is.
 *
 * `witness` is checked for shape only. The registry that decides whether a kind
 * exists, and whether these parameters fit it, is U2's — and it is deliberately not
 * imported here, so this module stays pure and a claim naming a not-yet-shipped kind
 * still survives a file round trip instead of being rewritten out of the author's
 * file by the host.
 */
export function parseSurfaceClaim(raw: unknown): SurfaceClaim | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'a claim must be an object'
  const r = raw as Record<string, unknown>

  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!id) return 'a claim needs a non-empty id — components reference claims by it'
  if (id.length > MAX_DECLARED_LEN) return `claim id exceeds ${MAX_DECLARED_LEN} characters`

  const witness = typeof r.witness === 'string' ? r.witness.trim() : ''
  if (!witness) return `claim ${JSON.stringify(id)} needs a witness kind`
  if (witness.length > MAX_DECLARED_LEN) {
    return `claim ${JSON.stringify(id)} names a witness kind over ${MAX_DECLARED_LEN} characters`
  }

  const locus = typeof r.locus === 'string' ? r.locus.trim() as SurfaceClaimLocus : undefined
  if (!locus || !CLAIM_LOCI.includes(locus)) {
    return `claim ${JSON.stringify(id)} must declare a locus of ${CLAIM_LOCI.join(' or ')}`
  }

  const params = parseClaimParams(r.params)
  if (typeof params === 'string') return `claim ${JSON.stringify(id)}: ${params}`

  return { id, witness, ...(params ? { params } : {}), locus }
}

/** A claim's parameters, or a refusal message. `undefined` means the claim declared
 *  none — which is not the same as declaring an empty object, but nothing downstream
 *  can tell those apart and a witness kind with no parameters has nothing to say
 *  about the difference, so they collapse here rather than being carried. */
function parseClaimParams(raw: unknown): Record<string, string | number | boolean> | undefined | string {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'params must be an object'
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) return undefined
  if (entries.length > MAX_CLAIM_PARAMS) return `params exceeds ${MAX_CLAIM_PARAMS} keys`
  // SORTED, so that reordering the keys in the file is not an author edit. The entry
  // watermark hashes this structure, and `JSON.stringify` preserves insertion order —
  // without the sort, a formatter that reordered a params object would advance the
  // watermark, burn a revision, and queue a rebuild on a Surface nobody touched.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of entries) {
    if (!key || key.length > MAX_DECLARED_LEN) return `a params key exceeds ${MAX_DECLARED_LEN} characters`
    if (typeof value === 'string') {
      if (value.length > MAX_CLAIM_PARAM_LEN) return `params.${key} exceeds ${MAX_CLAIM_PARAM_LEN} characters`
      out[key] = value
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return `params.${key} must be a finite number`
      out[key] = value
    } else if (typeof value === 'boolean') {
      out[key] = value
    } else {
      // Nested objects and arrays included. See `SurfaceClaim.params`.
      return `params.${key} must be a string, number, or boolean`
    }
  }
  return out
}

/**
 * Parse an author's `claims` declaration out of an untrusted file (R1, plan U1).
 *
 * THREE-STATE, and the empty array survives. Absent means the author never said;
 * `[]` means the author checked and found nothing witnessable. They schedule and
 * render identically, but the egress adapter writes this field back into the
 * author's own file — so collapsing `[]` to absent would have the host quietly
 * delete a declaration somebody wrote.
 *
 * DROPS rather than refuses, per claim, the same posture `parseRefreshDeclaration`
 * takes with an unknown trigger name: a mistyped witness kind costs that claim, not
 * the Surface. U6 gives the dropped claim a visible refusal on the card; until then
 * it is silent, which is exactly why U6 exists.
 *
 * A list OVER THE CAP is refused WHOLE. Truncating to the cap would leave a Surface
 * declaring fewer claims than its author wrote, and a Surface reporting `witnessed`
 * against a prefix of its own declaration is a worse lie than one reporting
 * `unwitnessed` — which is what an absent list gets it.
 */
export function parseSurfaceClaims(raw: unknown): SurfaceClaim[] | undefined {
  if (!Array.isArray(raw)) return undefined
  if (raw.length > MAX_SURFACE_CLAIMS) return undefined
  const out: SurfaceClaim[] = []
  for (const entry of raw) {
    const claim = parseSurfaceClaim(entry)
    if (typeof claim === 'string') continue
    // First occurrence wins, matching the epoch's duplicate-entry-id rule. Two
    // claims under one id would make a component's reference ambiguous.
    if (out.some(c => c.id === claim.id)) continue
    out.push(claim)
  }
  return out
}

/**
 * The declaration actually in force for a Surface: what the author asked for,
 * filled in with host defaults.
 *
 * THE TWO DEFAULTS WORTH NAMING:
 *   · policy falls back to `automatic` when the Surface carries a recipe (R15's
 *     "bounded automatic refresh is the default") and to `mark-stale` when it does
 *     not. A recipe-less Surface has nothing a worker could re-run, so calling its
 *     policy automatic would promise a refresh that can only ever be a nudge.
 *   · triggers fall back to `git-revision` + `periodic` for a recipe-bearing
 *     Surface bound to a worktree. NOT `source-content` on its own binding: an
 *     observation of a Surface's OWN source is the content ARRIVING, and
 *     `observeSource` already marks that current. Treating it as a stale signal
 *     would make every save queue a refresh that immediately superseded itself.
 */
export function effectiveDeclaration(surface: Surface): SurfaceRefreshDeclaration {
  const declared = surface.content.refreshPolicy
  const hasRecipe = !!surface.content.recipe
  const policy = declared?.policy ?? (hasRecipe ? 'automatic' : 'mark-stale')
  const triggers = declared?.triggers?.length
    ? declared.triggers
    : hasRecipe && surface.source?.worktree
      ? (['git-revision', 'periodic'] as SurfaceTriggerKind[])
      : []
  return {
    policy,
    triggers,
    ...(declared?.intervalMs !== undefined ? { intervalMs: declared.intervalMs } : {}),
    ...(declared?.sources ? { sources: declared.sources } : {}),
    ...(declared?.signals ? { signals: declared.signals } : {}),
  }
}

// --- Normalizing an observation --------------------------------------------

/**
 * Turn an untrusted announcement into a typed event, or nothing.
 *
 * The NATS half of the plan's scenario: an agent can publish any string it likes,
 * so an announcement has to name a kind in the closed vocabulary AND carry a
 * source identifier before it counts as an observation. Anything else returns null
 * and is dropped at the edge.
 */
export function normalizeTrigger(raw: unknown, at: number): SurfaceTriggerEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const kind = typeof obj.kind === 'string' ? obj.kind.trim() as SurfaceTriggerKind : null
  if (!kind || !TRIGGER_KINDS.includes(kind)) return null
  const sourceId = typeof obj.sourceId === 'string' ? obj.sourceId.trim() : ''
  if (!sourceId || sourceId.length > MAX_DECLARED_LEN) return null
  const text = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined
    const s = v.trim()
    return s && s.length <= MAX_DECLARED_LEN ? s : undefined
  }
  return {
    kind,
    sourceId,
    ...(text(obj.evidence) ? { evidence: text(obj.evidence)! } : {}),
    ...(text(obj.signal) ? { signal: text(obj.signal)! } : {}),
    ...(text(obj.runId) ? { runId: text(obj.runId)! } : {}),
    ...(text(obj.worktree) ? { worktree: text(obj.worktree)! } : {}),
    at,
  }
}

/**
 * The key two observations must SHARE to count as the same one.
 *
 * Evidence is part of the key, which is what makes "repeated equivalent events
 * create one queued job" true: the poll floor re-reports the same Git SHA every
 * few seconds, and every one of those repeats collapses onto one key. A genuinely
 * new SHA produces a different key — not a later one, a different one. Nothing
 * here compares evidence for order.
 */
export function triggerDedupeKey(event: SurfaceTriggerEvent): string {
  return [event.kind, event.sourceId, event.signal ?? '', event.evidence ?? ''].join(' ')
}

// --- Matching ---------------------------------------------------------------

function scopeMatches(event: SurfaceTriggerEvent, surface: Surface): boolean {
  // A scoped event only reaches Surfaces in that scope. An unscoped one (no runId,
  // no worktree) reaches any Surface whose declaration names its kind — that is how
  // an explicit semantic signal crosses runs on purpose.
  if (event.runId && surface.provenance?.runId && event.runId !== surface.provenance.runId) return false
  if (event.worktree) {
    const bound = surface.source?.worktree ?? surface.provenance?.worktreeId
    if (bound && bound !== event.worktree) return false
  }
  return true
}

function kindMatches(event: SurfaceTriggerEvent, decl: SurfaceRefreshDeclaration, surface: Surface): boolean {
  if (!decl.triggers.includes(event.kind)) return false
  switch (event.kind) {
    case 'source-content':
      // Only a source the Surface DECLARED it derives from. Its own binding is
      // excluded on purpose (see `effectiveDeclaration`), and a declaration-free
      // Surface therefore matches no source-content event at all.
      if (surface.source && event.sourceId === surface.source.locator) return false
      return (decl.sources ?? []).includes(event.sourceId)
    case 'semantic-signal':
      return !!event.signal && (decl.signals ?? []).includes(event.signal)
    default:
      return true
  }
}

/** One sentence naming what happened, for the badge and the audit entry. */
function detailFor(event: SurfaceTriggerEvent): string {
  switch (event.kind) {
    case 'source-content': return `a source it derives from changed (${event.sourceId})`
    case 'git-revision': return 'the worktree moved to a new revision'
    case 'process-exit': return `a tracked process finished (${event.sourceId})`
    case 'session-lifecycle': return `session ${event.sourceId} changed state`
    case 'human-intent': return 'you asked for it'
    case 'semantic-signal': return `an agent signalled "${event.signal ?? event.sourceId}"`
    case 'periodic': return 'its verification interval elapsed'
  }
}

/**
 * Which Surfaces this event makes possibly-stale, and why.
 *
 * `manual` Surfaces are excluded here rather than downstream: a manual policy means
 * nothing but an explicit request moves it, so recording an automatic reason on one
 * would put a stale badge on a Surface the user told the host not to track.
 */
export function matchTrigger(event: SurfaceTriggerEvent, surfaces: readonly Surface[]): SurfaceTriggerMatch[] {
  const out: SurfaceTriggerMatch[] = []
  for (const surface of surfaces) {
    if (surface.deleted || surface.home.kind === 'recovery' || surface.compatibilityOnly) continue
    const decl = effectiveDeclaration(surface)
    if (decl.policy === 'manual') continue
    if (!kindMatches(event, decl, surface)) continue
    if (!scopeMatches(event, surface)) continue
    out.push({
      surface,
      policy: decl.policy,
      reason: {
        kind: event.kind,
        key: triggerDedupeKey(event),
        detail: detailFor(event),
        ...(event.evidence ? { evidence: event.evidence } : {}),
        at: event.at,
      },
    })
  }
  return out
}

/**
 * Combine two views of "how far behind is this". Takes the MAX of host
 * generations, which is the only ordering KTD10 permits.
 *
 * Named and exported rather than inlined as `Math.max` because the thing it must
 * never become is a comparison of `evidence` — a later commit's SHA does not sort
 * after an earlier one, and a content hash does not sort at all.
 */
export function coalesceGeneration(a: number | undefined, b: number | undefined): number {
  return Math.max(a ?? 0, b ?? 0)
}

/**
 * When this Surface's next verification is due, or undefined if it asked for none.
 *
 * DERIVED FROM THE LAST SUCCESSFUL VERIFICATION, not from the last attempt, so a
 * failing retry loop cannot push its own deadline out by trying.
 *
 * POLICY DOES NOT GATE THIS, and that is deliberate rather than an oversight: the
 * plan requires "passing `dueAt` exposes overdue for automatic, mark-stale, AND
 * manual scheduling policies". A manual Surface is one nothing may refresh without
 * being asked — it is not one nobody is allowed to notice has gone unverified.
 * Policy decides who acts; the deadline decides what is true.
 */
export function deriveDueAt(
  surface: Surface, decl: SurfaceRefreshDeclaration, defaultIntervalMs: number,
): number | undefined {
  // An explicit interval is a request for a deadline on its own. Otherwise only a
  // declared `periodic` trigger asks for one — a Surface that listens solely to Git
  // has no opinion about elapsed time and should not grow an amber badge for it.
  const wants = decl.intervalMs !== undefined || decl.triggers.includes('periodic')
  if (!wants) return undefined
  const interval = Math.max(MIN_INTERVAL_MS, decl.intervalMs ?? defaultIntervalMs)
  const base = surface.freshness.verifiedAt ?? surface.createdAt
  return base + interval
}
