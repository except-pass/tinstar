// The closed witness registry: the host-owned code a claim's `witness` name resolves
// to (plan U2, R2/R6/R7/R21, KTD8).
//
// THIS MODULE IS IMPORT-PURE. It reaches nothing outside the process at import time
// and holds no reference to `node:child_process`, `fetch`, a clock, or a filesystem.
// Everything that leaves the process arrives as an injected dep at CALL time — the
// same posture `RefreshCoordinatorDeps` takes, and the reason `surface-trigger-
// matcher.ts` (a pure module U1 kept pure on purpose) can import `validateClaim`
// from here without dragging subprocess spawns and HTTP into the parser. The real
// deps live in `witness-runtime.ts`, which is the only file here that imports the
// runners.
//
// THE THREE-VALUED OUTCOME IS THE WHOLE POINT (KTD8). A failed fetch, an unreachable
// host, an unauthenticated call, and a ref that does not exist all produce "no
// result". Under a two-valued contract that is indistinguishable from a genuine
// absence — so a witness that has been broken for a week would keep matching its
// stored absence and keep stamping its card verified. `unresolved` is therefore its
// own outcome, and {@link witnessMatches} never lets it count.
//
// Server-only and React-free.

import type { SurfaceClaim, SurfaceClaimLocus } from '../../domain/types'

/** What a witness may report having seen. Narrow on purpose: a claim's value is
 *  COMPARED for equality against a stored one and rendered on a card, so a
 *  structured result would need a comparator and a renderer nobody has written.
 *  `null` is a genuine absence reported by a lookup that COMPLETED (R7) — the only
 *  absence that is allowed to match. */
export type WitnessValue = string | number | boolean | null

/**
 * The outcome of running one witness.
 *
 *   · `value`      — a lookup completed and this is what it saw. Only this may match.
 *   · `unresolved` — nobody could look. Never matches, never advances the stamp, and
 *                    shows on the card as a claim nobody could check.
 *   · `failed`     — the witness itself is broken or was cut off: a refused claim, a
 *                    timeout. Distinguished from `unresolved` because one is a
 *                    transient fact about the world and the other is a defect
 *                    somebody has to fix.
 */
export type WitnessOutcome =
  | { status: 'value'; value: WitnessValue }
  | { status: 'unresolved'; detail: string }
  | { status: 'failed'; detail: string }

/** Mirrors `ExecResult` from `infra/execCommand.ts` without importing it — a
 *  non-zero exit RESOLVES and is branched on; only a spawn failure rejects. */
export interface WitnessExecResult { stdout: string; stderr: string; code: number }

/** Everything a witness needs that leaves this process. */
export interface WitnessDeps {
  /** Run an argv (NO shell) in `cwd`. */
  exec: (
    argv: string[],
    opts: { cwd: string; timeoutMs: number; signal: AbortSignal },
  ) => Promise<WitnessExecResult>
  /** Fetch a URL. Narrowed to the one field the http-status kind reads, so a test
   *  seam is three lines and no `Response` has to be faked. */
  fetch: (
    url: string,
    init: { method: string; redirect: 'manual'; signal: AbortSignal },
  ) => Promise<{ status: number }>
}

export interface WitnessRunInput {
  claim: SurfaceClaim
  /** Absolute path of the worktree a repo-locus witness reads. Absent is not an
   *  error the caller has to pre-empt — the witness reports `unresolved`. */
  worktree?: string
  deps: WitnessDeps
  /** Override the kind's own budget. The coordinator's per-sweep budget is tighter
   *  than any single kind's default, and tests need a budget they can blow. */
  timeoutMs?: number
}

type ClaimParams = NonNullable<SurfaceClaim['params']>

interface WitnessRunContext {
  deps: WitnessDeps
  worktree?: string
  signal: AbortSignal
  timeoutMs: number
}

type SchemaResult<P> = { ok: true; params: P } | { ok: false; why: string }

interface WitnessKindDef<P> {
  /** How long one run of this kind may take before it reports `failed`. */
  timeoutMs: number
  /** The loci this kind can actually observe. A repo witness declared at the infra
   *  locus is a contradiction, not a preference: under R5 no commit would ever
   *  invalidate it, so it would sit permanently on its last value. */
  loci: readonly SurfaceClaimLocus[]
  schema: (params: ClaimParams | undefined) => SchemaResult<P>
  run: (params: P, ctx: WitnessRunContext) => Promise<WitnessOutcome>
}

interface RegisteredWitness {
  timeoutMs: number
  loci: readonly SurfaceClaimLocus[]
  schema: (params: ClaimParams | undefined) => SchemaResult<unknown>
  run: (params: unknown, ctx: WitnessRunContext) => Promise<WitnessOutcome>
}

/** Erases the parameter type at the registry boundary. The one cast in this file
 *  lives here, paired with the schema that produced the value. */
function define<P>(def: WitnessKindDef<P>): RegisteredWitness {
  return {
    timeoutMs: def.timeoutMs,
    loci: def.loci,
    schema: def.schema,
    run: (params, ctx) => def.run(params as P, ctx),
  }
}

// --- unit-landed -------------------------------------------------------------

/**
 * THE LINK THAT DID NOT EXIST, and why this kind is the risky one.
 *
 * A merged squash carries its unit tag and its PR number in the SUBJECT
 * (`… (U6) (#163)`) and never names the plan document. Twenty-two plans live under
 * `docs/plans/` and sixteen of them number their units `U1..Un`, so a bare unit id
 * is not repo-unique. Both naive forms are wrong on this repository TODAY, measured
 * against `origin/main` rather than guessed:
 *
 *   · Subject-line `(U<n>)` matching finds ZERO commits for `(U1)` — yet U1 of the
 *     recursive-collaborative-surfaces plan did land, as `(U1, part 1)` in #158 and
 *     `(U1e)` in #159. A false "pending", forever.
 *   · Whole-message matching for `(U4)` finds FIVE commits, from five unrelated
 *     plans, each listing its own U4 in a squash body. A false "landed" for any plan
 *     that has a U4 — which is most of them.
 *
 * So the link is DECLARED rather than inferred: a `Plan: docs/plans/<file>#U<n>`
 * commit trailer, documented in `docs/contributing.md`. The witness reads the
 * trailer, falls back to {@link UNIT_LANDED_BACKFILL} for the units that merged
 * before the convention existed, and reports `unresolved` — never "not landed" —
 * when it can resolve neither.
 *
 * THE LADDER, and why each rung is where it is:
 *
 *   1. A trailer on the ref naming this plan AND this unit          → `landed`.
 *   2. A trailer on the ref naming this plan and some OTHER unit    → `pending`.
 *      The convention is demonstrably in force for this plan, so the unit's absence
 *      is an absence a completed lookup observed (R7) rather than an unknown.
 *   3. Backfill coverage, corroborated by the ref                   → `landed` when
 *      every PR the backfill names is on the ref, `pending` otherwise.
 *   4. Backfill coverage the ref corroborates NOWHERE               → `unresolved`.
 *      This is the shallow-clone and wrong-ref case. A backfill that asserts
 *      landings the history does not show is a backfill pointed at the wrong repo,
 *      and trusting its coverage into a `pending` would be inventing a fact.
 *   5. Anything else                                                → `unresolved`.
 */
interface UnitLandedParams {
  plan: string
  unit: string
  remote: string
  branch: string
  ref: string
}

/** `docs/plans/<file>.md` and nothing else. Author-supplied and headed for a git
 *  argv, so no traversal, no leading dash, no whitespace. */
const PLAN_PATH = /^docs\/plans\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/
/** `U1`, `U12`, `U1e` — the shapes this repository's history actually uses. */
const UNIT_ID = /^U\d{1,3}[a-z]?$/
/** `<remote>/<branch>`. A remote is REQUIRED: this witness has to advance the ref
 *  before reading it, and a bare branch name names nothing it could fetch. */
const REMOTE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]*$/

const DEFAULT_REF = 'origin/main'

/** How far back the witness reads. Bounded so a witness on a repository with a long
 *  history is not the slow step in a sweep; well past every plan document that
 *  exists. */
const MAX_LOG_COMMITS = 2000

/** One record per commit, `%H` `%s` `%B`, terminated by `\x1e` — the same field and
 *  record separators `commits.ts` uses for the same reason. */
const LOG_FORMAT = '--format=%H%x1f%s%x1f%B%x1e'

/** `Plan: docs/plans/<file>#U<n>`, anywhere in the message, any number of times.
 *  Deliberately NOT `git log --format=%(trailers:key=Plan)`: git only recognises a
 *  trailer block in the last paragraph, and a squashed body full of bullet lists is
 *  exactly the shape that defeats that detection. A line scan has no such rule. */
const PLAN_TRAILER = /^[ \t]*Plan:[ \t]*(\S+?)#(U\d{1,3}[a-z]?)[ \t]*$/gm

/** `… (#163)` at the end of a squash subject — GitHub's own format. */
const PR_IN_SUBJECT = /\(#(\d+)\)\s*$/

/**
 * Units that merged before the `Plan:` trailer convention existed, mapped to the
 * PRs that landed them.
 *
 * DELIBERATELY SMALL. It covers the one plan whose units merged as their own PRs,
 * where the subject records the unit and the PR number and the mapping is therefore
 * a fact rather than an archaeology exercise. Every older plan landed as ONE
 * whole-plan squash (`#126` is all ten units of the first Slate plan), so per-unit
 * landing is not something that history records at all — and a guess entered here
 * would be worse than the `unresolved` those plans correctly get, because a wrong
 * witness fails without doubt.
 *
 * A plan's presence here is also its COVERAGE marker: for a covered plan, a unit
 * with no entry is `pending` rather than unknown — but only once the ref has
 * corroborated at least one of the plan's backfilled PRs (rung 4 above).
 *
 * This map does not grow. New units carry the trailer.
 */
export const UNIT_LANDED_BACKFILL: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>> = {
  'docs/plans/2026-07-24-001-feat-recursive-collaborative-surfaces-plan.md': {
    // Landed in two parts under two different tags — the shape that falsifies
    // subject-line matching. Both must be on the ref for U1 to read as landed.
    U1: [158, 159],
    U2: [162],
    U3: [161],
    U6: [163],
    // U4, U5, U7, U8: not merged. Absent, therefore `pending` under coverage.
  },
}

interface LoggedCommit { sha: string; subject: string; message: string }

function parseLog(stdout: string): LoggedCommit[] {
  const out: LoggedCommit[] = []
  for (const record of stdout.split('\x1e')) {
    const trimmed = record.replace(/^[\r\n]+/, '')
    if (!trimmed) continue
    const [sha, subject, message] = trimmed.split('\x1f')
    if (!sha) continue
    out.push({ sha, subject: subject ?? '', message: message ?? '' })
  }
  return out
}

const unitLanded = define<UnitLandedParams>({
  // A `git fetch` against a real remote is the slow step, and it is a network round
  // trip on a link the host does not control.
  timeoutMs: 30_000,
  loci: ['repo'],
  schema: params => {
    const plan = typeof params?.plan === 'string' ? params.plan.trim() : ''
    if (!PLAN_PATH.test(plan)) {
      return { ok: false, why: 'params.plan must be a `docs/plans/<file>.md` path' }
    }
    const unit = typeof params?.unit === 'string' ? params.unit.trim() : ''
    if (!UNIT_ID.test(unit)) {
      return { ok: false, why: 'params.unit must be a unit id like `U3` or `U1e`' }
    }
    const ref = params?.ref === undefined ? DEFAULT_REF : String(params.ref).trim()
    if (!REMOTE_REF.test(ref) || ref.includes('..') || ref.includes('@{')) {
      return { ok: false, why: 'params.ref must be a `<remote>/<branch>` remote-tracking ref' }
    }
    const slash = ref.indexOf('/')
    return { ok: true, params: { plan, unit, ref, remote: ref.slice(0, slash), branch: ref.slice(slash + 1) } }
  },
  run: async (p, ctx) => {
    const { worktree } = ctx
    if (!worktree) {
      return { status: 'unresolved', detail: 'no worktree is bound to this surface, so no repository to read' }
    }
    const git = async (...args: string[]): Promise<WitnessExecResult> => ctx.deps.exec(
      ['git', '-C', worktree, ...args],
      { cwd: worktree, timeoutMs: ctx.timeoutMs, signal: ctx.signal },
    )

    // The plan document is a LOCAL fact and the landing is a REMOTE one, so this is
    // checked against HEAD and checked FIRST — a typo in the path must not cost a
    // network round trip, and the plan for the work in progress lives on the feature
    // branch long before it reaches the ref.
    const planExists = await git('cat-file', '-e', `HEAD:${p.plan}`)
    if (planExists.code !== 0) {
      return { status: 'unresolved', detail: `no plan document at ${p.plan} in this worktree` }
    }

    // ADVANCE THE REF BEFORE READING IT. Feature PRs squash-merge remotely and
    // nothing in the host fetches, so a stale `origin/main` would report every
    // landing of the last week as pending. The explicit refspec is not decoration:
    // it is what guarantees the remote-tracking ref itself moves rather than only
    // FETCH_HEAD.
    const fetched = await git(
      'fetch', '--quiet', p.remote, `+refs/heads/${p.branch}:refs/remotes/${p.remote}/${p.branch}`,
    )
    if (fetched.code !== 0) {
      // Unreachable host, no such remote, expired credentials — all of them "nobody
      // could look", none of them "the unit has not landed" (KTD8).
      return { status: 'unresolved', detail: `could not fetch ${p.ref}: ${firstLine(fetched.stderr) || `git exited ${fetched.code}`}` }
    }

    const logged = await git('log', p.ref, LOG_FORMAT, `--max-count=${MAX_LOG_COMMITS}`)
    if (logged.code !== 0) {
      return { status: 'unresolved', detail: `could not read ${p.ref}: ${firstLine(logged.stderr) || `git exited ${logged.code}`}` }
    }

    const commits = parseLog(logged.stdout)
    let planHasAnyTrailer = false
    const prs = new Set<number>()
    for (const c of commits) {
      const pr = PR_IN_SUBJECT.exec(c.subject)
      if (pr) prs.add(Number(pr[1]))
      PLAN_TRAILER.lastIndex = 0
      let m = PLAN_TRAILER.exec(c.message)
      while (m) {
        if (m[1] === p.plan) {
          if (m[2] === p.unit) return { status: 'value', value: 'landed' }   // rung 1
          planHasAnyTrailer = true
        }
        m = PLAN_TRAILER.exec(c.message)
      }
    }
    // Rung 2: the convention is live for this plan and this unit is not in it.
    if (planHasAnyTrailer) return { status: 'value', value: 'pending' }

    const backfill = UNIT_LANDED_BACKFILL[p.plan]
    if (backfill) {
      const named = new Set<number>()
      for (const list of Object.values(backfill)) for (const pr of list) named.add(pr)
      // Rung 4 before rung 3: coverage is only trustworthy once the ref has
      // corroborated it. A depth-1 checkout sees none of these and must not be told
      // that eight units are pending.
      const corroborated = [...named].some(pr => prs.has(pr))
      if (!corroborated) {
        return {
          status: 'unresolved',
          detail: `${p.ref} contains none of the merges recorded for ${p.plan} — wrong ref, or a shallow clone`,
        }
      }
      const mine = backfill[p.unit]
      if (!mine || mine.length === 0) return { status: 'value', value: 'pending' }
      return { status: 'value', value: mine.every(pr => prs.has(pr)) ? 'landed' : 'pending' }   // rung 3
    }

    // Rung 5. Nothing links this unit to anything, and saying "pending" here is the
    // exact lie this kind exists to avoid.
    return {
      status: 'unresolved',
      detail: `nothing on ${p.ref} links ${p.plan}#${p.unit} to a commit — add a \`Plan: ${p.plan}#${p.unit}\` trailer when it lands`,
    }
  },
})

// --- http-status -------------------------------------------------------------

interface HttpStatusParams { url: string }

const httpStatus = define<HttpStatusParams>({
  timeoutMs: 10_000,
  loci: ['infra'],
  schema: params => {
    const raw = typeof params?.url === 'string' ? params.url.trim() : ''
    if (!raw) return { ok: false, why: 'params.url is required' }
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return { ok: false, why: 'params.url must be an absolute URL' }
    }
    // `file:` would turn a claim into a local file read and `data:` into an
    // author-controlled response body. This kind reports on deployed infrastructure.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, why: `params.url must be http or https, not ${parsed.protocol.replace(':', '')}` }
    }
    return { ok: true, params: { url: parsed.toString() } }
  },
  run: async (p, ctx) => {
    try {
      // `redirect: 'manual'` because a 301 IS the status code being claimed. Letting
      // fetch follow it would report the destination's 200 and hide the move.
      const res = await ctx.deps.fetch(p.url, { method: 'GET', redirect: 'manual', signal: ctx.signal })
      return { status: 'value', value: res.status }
    } catch (err) {
      // A host that answered ANYTHING — 500, 404, 418 — is a completed lookup and
      // took the branch above. Reaching here means nobody answered.
      if (ctx.signal.aborted) return { status: 'failed', detail: 'the request was cut off' }
      return { status: 'unresolved', detail: `could not reach ${p.url}: ${message(err)}` }
    }
  },
})

// --- the registry ------------------------------------------------------------

const REGISTRY: Readonly<Record<string, RegisteredWitness>> = {
  'unit-landed': unitLanded,
  'http-status': httpStatus,
}

/** Every kind this host implements. Closed: R2 refuses a claim naming anything else. */
export function witnessKinds(): readonly string[] {
  return Object.keys(REGISTRY)
}

/**
 * Check a claim against its kind's schema. Returns `null` when it conforms, or a
 * refusal message NAMING THE KIND — a claim that says only "params are wrong" leaves
 * the author with nothing to look up.
 *
 * PURE, and that is what lets `surface-trigger-matcher.ts` import it. Nothing here
 * spawns, fetches, reads a clock, or touches a filesystem.
 *
 * CALLED FROM `parseSurfaceClaim` as of U6, which is the unit that opened the
 * refusal channel this check needs. U2 shipped it deliberately unwired: validating
 * without somewhere to report the verdict would have made a mistyped witness kind
 * delete itself out of the author's file on the next write-back, in silence. Both
 * doors now get it from the parser — the HTTP door refuses the request, the file
 * door drops the claim and puts the message on the card (KTD5).
 *
 * {@link runWitness} below calls it too, and still should: a record persisted before
 * the parser gained this check can hold a claim no schema would accept today.
 */
export function validateClaim(claim: SurfaceClaim): string | null {
  const where = `claim ${JSON.stringify(claim.id)} (witness ${claim.witness})`
  const entry = REGISTRY[claim.witness]
  if (!entry) return `${where}: no such witness kind — this host implements ${witnessKinds().join(', ')}`
  if (!entry.loci.includes(claim.locus)) {
    return `${where}: this kind observes ${entry.loci.join(' or ')}, not ${claim.locus}`
  }
  const checked = entry.schema(claim.params)
  return checked.ok ? null : `${where}: ${checked.why}`
}

/** The budget a claim of this kind gets, for a caller sizing a sweep. */
export function witnessTimeoutMs(witness: string): number | undefined {
  return REGISTRY[witness]?.timeoutMs
}

/**
 * Run one claim's witness. NEVER REJECTS and never runs longer than its budget: a
 * caller sweeping a hundred surfaces cannot be left holding an unhandled rejection
 * or a promise that never settles.
 *
 * A refused claim reports `failed` rather than `unresolved`. Both are safe — neither
 * matches — but the distinction is the useful one: `unresolved` says the world would
 * not answer, `failed` says this claim is broken and somebody has to edit it.
 */
export async function runWitness(input: WitnessRunInput): Promise<WitnessOutcome> {
  const { claim, deps, worktree } = input
  const entry = REGISTRY[claim.witness]
  const refusal = validateClaim(claim)
  if (!entry || refusal) {
    return { status: 'failed', detail: refusal ?? `unknown witness kind ${JSON.stringify(claim.witness)}` }
  }
  const checked = entry.schema(claim.params)
  if (!checked.ok) return { status: 'failed', detail: `claim ${JSON.stringify(claim.id)}: ${checked.why}` }

  const timeoutMs = input.timeoutMs ?? entry.timeoutMs
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  // The runner is wrapped BEFORE the race, so a rejection arriving after the timeout
  // already settled the race lands in this catch instead of on the process as an
  // unhandled rejection.
  const running = entry.run(checked.params, {
    deps, worktree, signal: controller.signal, timeoutMs,
  }).catch((err): WitnessOutcome => ({
    status: 'unresolved',
    detail: `witness ${claim.witness} could not complete: ${message(err)}`,
  }))

  const expiring = new Promise<WitnessOutcome>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ status: 'failed', detail: `witness ${claim.witness} exceeded its ${timeoutMs}ms budget` })
    }, timeoutMs)
    // Never hold the process open for a witness. The `finally` clears it on the
    // normal path; this covers the one where the caller is being torn down.
    timer.unref?.()
  })

  try {
    return await Promise.race([running, expiring])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Does this outcome match what was stored? The single place the three-valued
 * contract turns into the yes/no a verification stamp depends on.
 *
 * `unresolved` and `failed` are FALSE against every stored value including
 * `undefined`, which is the property KTD8 exists for: a witness broken for a week
 * must not keep agreeing with itself.
 *
 * A stored `null` matched by an observed `null` IS a match — R7's "only a lookup
 * that completed may report an absence as a value" is enforced by the outcome type,
 * so any `null` reaching here is already a completed lookup's answer.
 */
export function witnessMatches(stored: WitnessValue | undefined, outcome: WitnessOutcome): boolean {
  if (outcome.status !== 'value') return false
  if (stored === undefined) return false
  return Object.is(stored, outcome.value)
}

// --- small helpers -----------------------------------------------------------

function message(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function firstLine(text: string): string {
  return (text.split('\n').find(l => l.trim()) ?? '').trim()
}
