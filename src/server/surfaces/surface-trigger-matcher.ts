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
  SurfaceProposal,
  SurfaceRefreshPolicy,
  SurfaceStaleReason,
  SurfaceTriggerKind,
} from '../../domain/types'
// The registry is a PURE lookup — it spawns nothing, fetches nothing, and reads no
// clock — which is what lets this module import it without stopping being pure
// itself. U2 shipped `validateClaim` deliberately unwired for one release: a claim
// dropped here with no refusal channel would delete a mistyped witness kind out of
// the author's own file on the next write-back, silently. U6 opens that channel, so
// the check belongs in the parser now — and it has to be IN THE PARSER rather than
// at either door, because the egress adapter recomputes the entry watermark through
// this same function. A door that validated on its own would hash a different claims
// list than the file door does, and every API edit of a source-bound Surface would
// be refused as stale forever.
import { validateClaim } from './witness-registry'

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

/**
 * The kinds that ANNOUNCE a locus — the domain the narrowing predicate speaks about.
 *
 * Derived from the table rather than written out, so a kind added to a locus is
 * narrowed by that locus automatically instead of silently falling through.
 *
 * Today this is `git-revision` and `periodic`, and only the first ever narrows
 * anything: `periodic` is on every locus (see {@link CLAIM_LOCUS_TRIGGER_KINDS}), so
 * an infra-only card is still revalidated by time.
 */
const LOCUS_ANNOUNCED_KINDS: readonly SurfaceTriggerKind[] =
  [...new Set(Object.values(CLAIM_LOCUS_TRIGGER_KINDS).flat())]

/**
 * Whether this Surface's claims admit a trigger of this kind (R5, plan U5).
 *
 * THE NARROWING U5 EXISTS FOR. A card whose claims all sit at `infra` asserts nothing
 * a commit could contradict, so a commit on the bound worktree must not reach it —
 * not as a stale mark, and not as a job. On `main` a commit reaches every Surface
 * bound to its worktree, and that fan-out is the storm this plan opened against.
 *
 * THREE WAYS TO PASS, and the second and third are the ones worth reading twice:
 *
 *  1. Some claim's locus is invalidated by this kind. The ordinary yes.
 *
 *  2. THE SURFACE DECLARES NO CLAIMS — absent or `[]`. Both fall through to today's
 *     matching untouched. This is U1's tri-state and it is load-bearing here: absent
 *     means the author never declared, `[]` means they checked and found nothing
 *     witnessable, and NEITHER is a statement about which triggers should reach the
 *     card. Narrowing on `[]` would let an author silence their own card by writing
 *     down that they found nothing to witness.
 *
 *  3. THE KIND ANNOUNCES NO LOCUS AT ALL. A locus predicate narrows locus
 *     announcements; it has nothing to say about a `source-content` event naming an
 *     upstream file the author declared, or a `semantic-signal` the author named.
 *     Those kinds reach a Surface only because its author asked for them by name —
 *     `kindMatches` has already required the declaration and, for those two kinds, a
 *     matching source id or signal — so they cannot storm, and silencing them would
 *     mean adding a claim to a card quietly deafened it to the upstream file it was
 *     built to follow. That is the same asymmetry `effectiveDeclaration` refuses when
 *     it UNIONS claim-earned kinds onto an author's list rather than replacing them:
 *     declaring a claim adds what the host should check, and takes nothing away.
 *
 * `human-intent` is in that third group and never reaches here anyway — the refresh
 * button goes through the coordinator's `requestFor`, not through matching.
 */
export function claimLocusAdmits(surface: Surface, kind: SurfaceTriggerKind): boolean {
  const claims = surface.content.claims
  if (!claims?.length) return true
  if (!LOCUS_ANNOUNCED_KINDS.includes(kind)) return true
  return claimsObserveTriggerKind(claims, kind)
}

/**
 * Every trigger kind this Surface's claims EARN it (R14, plan U4).
 *
 * The inverse read of the same table {@link claimsObserveTriggerKind} uses, and the
 * reason `effectiveDeclaration` unions rather than defaults: a claim declares that
 * something in the world could falsify this Surface, and a Surface that says so and
 * then listens for nothing is a Surface nothing can ever doubt. That is exactly the
 * hole this plan opened with — a recipe-less Surface got an empty trigger list, so no
 * deadline, so `overdue` could never rise and its phase stayed `current` forever.
 */
export function claimTriggerKinds(claims: readonly SurfaceClaim[] | undefined): SurfaceTriggerKind[] {
  const out: SurfaceTriggerKind[] = []
  for (const claim of claims ?? []) {
    for (const kind of CLAIM_LOCUS_TRIGGER_KINDS[claim.locus] ?? []) {
      if (!out.includes(kind)) out.push(kind)
    }
  }
  return out
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

// --- Declared sources: repo path globs vs external identifiers ---------------

/**
 * Does this declared source name something OUTSIDE the repository?
 *
 * The whole classification is the `scheme:` prefix, and it is deliberately the only
 * rule: `mysql://prod/detector` and `jira:KC-1302` are opaque identifiers the host
 * cannot walk, while `src/server/**` and `docs/plans/2026-*.md` are repo-relative
 * path shapes. The split is what lets ONE declared list carry both kinds and still
 * be matched sensibly: an external id is compared for equality, a path shape is
 * compared as a glob.
 *
 * `file:x.json#id` — the `slate-file` locator shape — lands on the external side, and
 * that is correct: it is matched by equality through `source-content`, not walked.
 */
export function isExternalSourceId(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(source)
}

/** The declared sources that are repo path shapes rather than external ids — the
 *  half of the list `source-content` matches as globs. */
export function declaredPathGlobs(decl: SurfaceRefreshDeclaration): string[] {
  return (decl.sources ?? []).filter(s => !isExternalSourceId(s))
}

/** Escape a literal run for embedding in a `RegExp`. */
function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile one author glob to a regex.
 *
 * The supported vocabulary is deliberately tiny — `**`, `*`, `?` — because an author
 * writes these in a JSON file and the failure mode of a richer syntax is a glob that
 * silently matches nothing, which looks exactly like a Surface whose source never
 * changed.
 *
 *   `**`  any run of characters, separators included
 *   `*`   any run of characters except `/`
 *   `?`   exactly one character except `/`
 *
 * A glob with NO wildcard is a PREFIX: `src/server` matches `src/server/index.ts` as
 * well as a file of that exact name. Authors write directories far more often than
 * they write one file, and requiring `src/server/**` for the ordinary case would make
 * the quiet-by-default failure the common one.
 *
 * Every quantifier here is over a single character class and none of them nest, so
 * there is no input an author can write that makes this backtrack exponentially.
 */
function globToRegExp(glob: string): RegExp | null {
  const trimmed = glob.replace(/^\.\//, '').replace(/\/+$/, '')
  if (!trimmed) return null
  const wildcarded = /[*?]/.test(trimmed)
  let out = ''
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charAt(i)
    if (c === '*') {
      if (trimmed[i + 1] === '*') { out += '.*'; i++ } else { out += '[^/]*' }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += escapeLiteral(c)
    }
  }
  // The prefix rule, applied only to a literal path: a wildcarded glob already says
  // exactly how far it reaches, and widening it would make `docs/*.md` match
  // `docs/a.md/b` — a path that cannot exist, but also not what was asked for.
  try {
    return new RegExp(`^${out}${wildcarded ? '' : '(/.*)?'}$`)
  } catch {
    return null
  }
}

const globCache = new Map<string, RegExp | null>()

/** Does one repo-relative path match one author glob? */
export function pathMatchesGlob(glob: string, path: string): boolean {
  let re = globCache.get(glob)
  if (re === undefined) {
    re = globToRegExp(glob)
    // Bounded by the number of distinct globs any author has ever declared in this
    // process, which `MAX_DECLARED` bounds per Surface. Cleared wholesale rather
    // than evicted per entry: there is no access pattern worth modelling here.
    if (globCache.size > 4_000) globCache.clear()
    globCache.set(glob, re)
  }
  return !!re && re.test(path.replace(/^\.\//, ''))
}

/** Does any of these source paths match any declared glob? */
export function anyPathMatches(globs: readonly string[], paths: readonly string[]): boolean {
  for (const glob of globs) {
    for (const path of paths) if (pathMatchesGlob(glob, path)) return true
  }
  return false
}

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

/**
 * Parse a declared string list.
 *
 * AN EMPTY ARRAY SURVIVES rather than collapsing to `undefined`, so the parsed
 * declaration records what the author actually wrote: `"sources": []` is the
 * statement "I checked, and nothing derives this", which is not the same statement
 * as leaving the field off. Nothing in trigger matching branches on the difference
 * today — both read as "no declared sources" — but the parser is the authored file's
 * round trip, and silently rewriting an author's `[]` into an omission is the kind
 * of lossy read that makes a later reader mistrust the record.
 */
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
  return out
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

/** Longest author claim line the host will render. One line on a card; past this it
 *  stops being a claim and starts being a body. */
const MAX_PROPOSAL_DETAIL = 200

const PROPOSAL_STATES: readonly SurfaceProposal['state'][] = ['working', 'blocked', 'resolved', 'superseded']

/**
 * Parse an author's proposal out of an untrusted file entry, or nothing.
 *
 * DROPS rather than refuses, like every other optional field: a proposal the host
 * cannot read leaves the Surface with none, which renders exactly as it does today,
 * instead of dropping the whole entry over a hint.
 *
 * `at` is stamped by the HOST and never read from the file. An author-supplied
 * timestamp is what a card would render an elapsed time from ("working, 4h"), and a
 * value the author controls is one they can — accidentally or otherwise — use to
 * make a stale claim look fresh. The claim's age is the host's observation, not the
 * author's assertion.
 */
export function parseProposal(raw: unknown, at: number): SurfaceProposal | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const state = typeof obj.state === 'string' ? obj.state.trim() as SurfaceProposal['state'] : undefined
  if (!state || !PROPOSAL_STATES.includes(state)) return undefined
  const detail = typeof obj.detail === 'string' ? obj.detail.replace(/\s+/g, ' ').trim() : ''
  return {
    state,
    ...(detail ? { detail: detail.slice(0, MAX_PROPOSAL_DETAIL) } : {}),
    at,
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
 * SHAPE FIRST, THEN THE REGISTRY. The shape checks below run before
 * {@link validateClaim} so a claim missing an id is told it has no id rather than
 * being reported against a witness kind it never got to name. The registry check is
 * last and is the only one that knows which kinds exist (U2/U6, R2/R3).
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

  const claim: SurfaceClaim = { id, witness, ...(params ? { params } : {}), locus }
  // The closed-vocabulary gate. `validateClaim` reports the kind by name and lists
  // the kinds this host does implement, which is the whole difference between a
  // refusal an author can act on and a card that quietly never gets witnessed.
  // It NEVER rewrites the claim — a kind whose schema normalizes its parameters
  // (`unit-landed` fills in a default ref) does that at run time, on a copy, so what
  // the author wrote is what round-trips back into their file.
  const refused = validateClaim(claim)
  if (refused) return refused

  return claim
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

/** What the file door made of an author's `claims` declaration: what it accepted,
 *  and what it would not accept and why. */
export interface ParsedSurfaceClaims {
  /** The surviving declaration, or `undefined` when the author declared none (or
   *  declared a list the host refused whole). THREE-STATE — see below. */
  claims?: SurfaceClaim[]
  /** One sentence per refusal, in declaration order. Empty when nothing was
   *  refused; never `undefined`, so a caller cannot forget to look. */
  refusals: string[]
}

/**
 * Parse an author's `claims` declaration out of an untrusted file (R1, plan U1/U6).
 *
 * THREE-STATE, and the empty array survives. Absent means the author never said;
 * `[]` means the author checked and found nothing witnessable. They schedule and
 * render identically, but the egress adapter writes this field back into the
 * author's own file — so collapsing `[]` to absent would have the host quietly
 * delete a declaration somebody wrote.
 *
 * DROPS rather than refuses, per claim, the same posture `parseRefreshDeclaration`
 * takes with an unknown trigger name: a mistyped witness kind costs that claim, not
 * the Surface (KTD5). WHAT MAKES THAT HONEST IS THE SECOND RETURN VALUE. A file has
 * no error channel of its own, so every drop here is otherwise a card that renders
 * its new content and simply never gets witnessed — indistinguishable from a healthy
 * one. U6 carries `refusals` onto the record's host-owned freshness and onto the
 * card. Returned together, rather than as a second function over the same input, so
 * a caller cannot take the claims and leave the refusals behind.
 *
 * A list OVER THE CAP is refused WHOLE. Truncating to the cap would leave a Surface
 * declaring fewer claims than its author wrote, and a Surface reporting `witnessed`
 * against a prefix of its own declaration is a worse lie than one reporting
 * `unwitnessed` — which is what an absent list gets it.
 */
export function parseSurfaceClaims(raw: unknown): ParsedSurfaceClaims {
  // Absent is the author never having said, and silence about silence is right.
  if (raw === undefined || raw === null) return { refusals: [] }
  if (!Array.isArray(raw)) {
    return { refusals: ['claims must be an array of claim objects — the whole declaration was ignored'] }
  }
  if (raw.length > MAX_SURFACE_CLAIMS) {
    return { refusals: [`claims declares more than ${MAX_SURFACE_CLAIMS} claims — the whole list was refused rather than truncated`] }
  }
  const out: SurfaceClaim[] = []
  const refusals: string[] = []
  for (const entry of raw) {
    const claim = parseSurfaceClaim(entry)
    if (typeof claim === 'string') { refusals.push(claim); continue }
    // First occurrence wins, matching the epoch's duplicate-entry-id rule. Two
    // claims under one id would make a component's reference ambiguous.
    if (out.some(c => c.id === claim.id)) {
      refusals.push(`claim ${JSON.stringify(claim.id)} is declared more than once — the first one wins`)
      continue
    }
    out.push(claim)
  }
  return { claims: out, refusals }
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
 *
 * `git-revision` STAYS IN THE DEFAULT SET even though it is the noisiest trigger the
 * host has — it produced 45 of 57 refreshes in one measured session. Dropping it
 * here would make every already-authored Surface stop refreshing on a commit, which
 * is a freshness regression rather than a quietening. Narrowing which commits reach
 * which Surfaces is a separate decision and does not live in this function — it lives
 * in `claimLocusAdmits`, which is the one narrowing mechanism.
 *
 * AND THE ONE ADDITION (R14, plan U4): whatever the author asked for, the kinds this
 * Surface's CLAIMS imply are unioned on top. Unioned rather than used as another
 * default, because an author who writes `triggers: ["git-revision"]` next to an
 * infra-locus claim has not said "and never check that claim" — they have said which
 * announcement they care about. Without the union such a Surface earns no deadline
 * and its claim is never revalidated at all.
 *
 * The union is what makes the cheap check REACHABLE. It does not make it expensive:
 * the coordinator answers a trigger on a claim-bearing Surface with a witness pass
 * instead of a job (KTD3), so the extra kinds buy detection, not dispatch.
 */
export function effectiveDeclaration(surface: Surface): SurfaceRefreshDeclaration {
  const declared = surface.content.refreshPolicy
  const hasRecipe = !!surface.content.recipe
  const policy = declared?.policy ?? (hasRecipe ? 'automatic' : 'mark-stale')
  const base = declared?.triggers?.length
    ? declared.triggers
    : hasRecipe && surface.source?.worktree
      ? (['git-revision', 'periodic'] as SurfaceTriggerKind[])
      : []
  const earned = claimTriggerKinds(surface.content.claims).filter(k => !base.includes(k))
  const triggers = earned.length ? [...base, ...earned] : base
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

/**
 * Does this Surface's declaration accept an event of this kind?
 *
 * DECLARING A TRIGGER KIND IS THE WHOLE GATE for every kind except the two below.
 * `git-revision` in particular is deliberately NOT narrowed here by declared source
 * paths: a branch once had this arm compare a commit's changed files against the
 * author's `sources` globs, and it came out because narrowing which triggers reach a
 * Surface is claim-locus work — one mechanism, declared per claim — and two competing
 * narrowings give an implementer no rule for which wins. A Surface that declares
 * `sources` is therefore reached by a commit exactly like one that declares none.
 */
function kindMatches(event: SurfaceTriggerEvent, decl: SurfaceRefreshDeclaration, surface: Surface): boolean {
  if (!decl.triggers.includes(event.kind)) return false
  switch (event.kind) {
    case 'source-content':
      // Only a source the Surface DECLARED it derives from. Its own binding is
      // excluded on purpose (see `effectiveDeclaration`), and a declaration-free
      // Surface therefore matches no source-content event at all.
      if (surface.source && event.sourceId === surface.source.locator) return false
      // Equality for external ids, glob for repo paths — one list, two shapes, and
      // an adapter emitting a path-shaped `sourceId` gets glob matching for free.
      return (decl.sources ?? []).includes(event.sourceId)
        || anyPathMatches(declaredPathGlobs(decl), [event.sourceId])
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
    // THE CLAIM-LOCUS FILTER (R5, plan U5), and it is deliberately LAST: the three
    // above answer "did the author ask for this / is it even in scope", and this one
    // answers "could this event possibly contradict what the card asserts". A Surface
    // that fails here is not marked and not scheduled — narrowing the JOB away, where
    // U4 only guaranteed no witness was spent on it.
    if (!claimLocusAdmits(surface, event.kind)) continue
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
 *
 * WHICH TIMESTAMP THE DEADLINE COUNTS FROM IS THE WHOLE OF KTD7 (plan U4). For a
 * claim-bearing Surface it is `witnessedAt` — the last time every claim was checked
 * and held — and NOT `verifiedAt`, which `observeSource` rewrites on creation and on
 * every file save whose watermark moved. Counting from `verifiedAt` would let an
 * author saving the file push the host's claim-check deadline out, indefinitely and
 * invisibly, which is precisely the failure KTD7 exists to prevent: the more actively
 * a card is edited, the less often anything would check whether it is still true.
 */
export function deriveDueAt(
  surface: Surface, decl: SurfaceRefreshDeclaration, defaultIntervalMs: number,
): number | undefined {
  // DECLARING A CLAIM EARNS A DEADLINE (R14), whatever the loci imply. Redundant
  // today with the `periodic` kind `effectiveDeclaration` unions on for the same
  // reason, and kept anyway: this function takes the declaration as a PARAMETER, so a
  // caller holding a raw author declaration (or a future default that stops unioning)
  // would otherwise silently return `undefined` for a Surface that says out loud what
  // would prove it wrong.
  const witnessed = !!surface.content.claims?.length
  // An explicit interval is a request for a deadline on its own. Otherwise only a
  // declared `periodic` trigger asks for one — a Surface that listens solely to Git
  // has no opinion about elapsed time and should not grow an amber badge for it.
  const wants = witnessed || decl.intervalMs !== undefined || decl.triggers.includes('periodic')
  if (!wants) return undefined
  const interval = Math.max(MIN_INTERVAL_MS, decl.intervalMs ?? defaultIntervalMs)
  const base = witnessed
    ? surface.freshness.witnessedAt ?? surface.createdAt
    : surface.freshness.verifiedAt ?? surface.createdAt
  return base + interval
}
