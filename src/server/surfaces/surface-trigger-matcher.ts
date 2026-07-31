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

/** Bounds on what an author may declare, so a hostile or runaway file cannot make
 *  the matcher walk a large list on every event. */
const MAX_DECLARED = 32
const MAX_DECLARED_LEN = 256

/** Shortest interval an author may ask for. A one-second `intervalMs` on a dozen
 *  surfaces is a refresh storm, and the cap would absorb it as a permanently full
 *  queue rather than as an error anyone could see. */
export const MIN_INTERVAL_MS = 60_000

/** Most changed paths one observation may carry before the host stops trying to
 *  attribute it. Past this the event goes out with no path list at all, which every
 *  matcher below reads as "unknown" and therefore matches — a merge of a thousand
 *  files is not evidence that nothing is affected. */
export const MAX_EVENT_PATHS = 5_000

// --- Declared sources: repo path globs vs external identifiers ---------------

/**
 * Does this declared source name something OUTSIDE the repository?
 *
 * The whole classification is the `scheme:` prefix, and it is deliberately the only
 * rule: `mysql://prod/detector` and `jira:KC-1302` are opaque identifiers the host
 * cannot walk, while `src/server/**` and `docs/plans/2026-*.md` are paths a commit
 * can touch. A Surface whose sources are ALL external is one no commit can ever make
 * stale, which is the case that motivated this — a decision surface reading
 * production MySQL and Jira was refreshing on every commit to a repo it never read.
 *
 * `file:x.json#id` — the `slate-file` locator shape — lands on the external side, and
 * that is correct: it is matched by equality through `source-content`, not walked.
 */
export function isExternalSourceId(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(source)
}

/** The declared sources that are repo path globs. */
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
 * silently matches nothing, which looks exactly like a Surface that never needed
 * refreshing.
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

/** Does any changed path match any declared glob? */
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
  /** Repo-relative paths this observation touched, when the host could work them
   *  out. ABSENT MEANS UNKNOWN, never "none" — a diff that failed, a first
   *  observation with nothing to compare against, and a change set past
   *  {@link MAX_EVENT_PATHS} all arrive with no list, and every one of those must
   *  still be able to make a Surface stale. */
  paths?: string[]
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
 * AN EMPTY ARRAY SURVIVES, and that is the whole three-state contract `sources`
 * rests on (see {@link declaredSources}). Collapsing `[]` to `undefined` — which
 * this used to do — would erase the difference between "the author checked and
 * nothing in the repo derives this" and "the author never said", and those two must
 * behave in opposite ways.
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

/**
 * What an author DECLARED about where this Surface's answer comes from — three
 * states, and the third is why this is a function rather than a field read.
 *
 *   · `undefined` — the author never said. Every Surface authored before declared
 *     sources existed is in this state, so it MUST mean "fall back to what the host
 *     did before": a commit to the bound worktree may make it stale. Silently
 *     turning those into never-refreshing Surfaces would break freshness for
 *     everything already on the canvas.
 *   · `[]` — the author checked and NOTHING in the repository derives this. No
 *     commit can ever make it stale. This is a real declaration and it is the one
 *     that has to be writable, or "nothing in the repo" is indistinguishable from
 *     "did not bother".
 *   · non-empty — exactly these globs and external ids.
 *
 * THE RULE AUTHORS ACTUALLY NEED, from the run that drove six of these end to end:
 * a path glob captures the CODE that derives the answer, never the DATA the answer
 * is derived from. A decision surface whose number comes from production MySQL but
 * whose logic is `scripts/integrity/detect-leftovers.sh` declares that script — and
 * gets both behaviours right at once, going quiet on unrelated commits while still
 * rebuilding when the detector itself is edited. That MIXED shape is the common one.
 */
export function declaredSources(surface: Surface): string[] | undefined {
  return surface.content.refreshPolicy?.sources
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
 * `git-revision` STAYS IN THE DEFAULT SET even though it is the trigger that
 * produced 45 of 57 refreshes in a measured session, because the narrowing that
 * fixes that lives in `kindMatches` and keys off the DECLARATION, not off the
 * trigger list. Dropping the default here instead would have made every
 * already-authored Surface stop refreshing.
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
  // `paths` is only ever set when the announcement genuinely carried a list. A
  // non-array — including an announcement that omits it — leaves it undefined, which
  // every matcher reads as "unknown" and therefore matches.
  const paths = Array.isArray(obj.paths)
    ? obj.paths.filter((p): p is string => typeof p === 'string' && !!p.trim() && p.length <= MAX_DECLARED_LEN)
      .slice(0, MAX_EVENT_PATHS)
    : undefined
  return {
    kind,
    sourceId,
    ...(text(obj.evidence) ? { evidence: text(obj.evidence)! } : {}),
    ...(text(obj.signal) ? { signal: text(obj.signal)! } : {}),
    ...(text(obj.runId) ? { runId: text(obj.runId)! } : {}),
    ...(text(obj.worktree) ? { worktree: text(obj.worktree)! } : {}),
    ...(paths ? { paths } : {}),
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
 * `git-revision` is the interesting one and the reason this comment exists. A commit
 * used to reach EVERY Surface bound to the worktree — measured at 45 refreshes in
 * one session, essentially all of them "no change", including a Surface whose only
 * repo dependency was a detector script the commits never touched. The narrowing:
 *
 *   · sources undeclared        → match (back-compat; the host does not know)
 *   · sources declared, no path globs in them (`[]`, or purely `external:` ids)
 *                               → NEVER match. No commit derives this.
 *   · event carries no path list → match. Unknown is not evidence of irrelevance;
 *     a diff the host could not compute must not silence a real change.
 *   · otherwise                 → match only if a changed path hits a declared glob.
 */
function kindMatches(event: SurfaceTriggerEvent, decl: SurfaceRefreshDeclaration, surface: Surface): boolean {
  if (!decl.triggers.includes(event.kind)) return false
  switch (event.kind) {
    case 'git-revision': {
      const sources = decl.sources
      if (sources === undefined) return true
      const globs = declaredPathGlobs(decl)
      if (globs.length === 0) return false
      if (!event.paths) return true
      return anyPathMatches(globs, event.paths)
    }
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
