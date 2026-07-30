// The Surface mutation service (plan U3) — ONE revision-safe boundary that the
// UI, agents, the CLI, and the compatibility routes all go through.
//
// Two properties are load-bearing enough to state up front, because everything
// else here is in service of them.
//
// 1. THERE IS NO GATE. Agents create, group, reparent and delete directly; there
//    is no proposal, no approval, no acceptance step, and nothing in this file
//    consults `owner` to decide whether a mutation is allowed. That is the
//    ratified product decision ("Recoverable action over gated action" — approval
//    prompts made the Slate feel like paperwork and fluidity is the point).
//    Safety comes from the fact that a delete is UNDOABLE: it moves the subtree
//    into the per-space recovery store inside the same atomic transaction, and
//    `purge` is the only irreversible operation in the service.
//
// 2. DURABLE BEFORE OBSERVABLE. Every mutation builds a candidate, makes it
//    durable, THEN installs it in memory and emits exactly one `surface.batch`,
//    and only then acknowledges (KTD7). The ordering is enforced by the sidecar's
//    `onDurable` callback rather than by this file remembering to do things in
//    sequence, so a failed write returns with live state and every connected
//    client untouched.
//
// The service also owns VALIDATION. Every operation takes a raw parsed body
// (`unknown`) and whitelists it here rather than at the route, which is what lets
// the HTTP and CLI layers be genuinely thin adapters — and, more importantly, is
// what makes "CLI commands and HTTP primitives report the same conflict and
// recovery states" true by construction instead of by two parallel
// implementations agreeing for now.

import { parseA2uiContent } from '../../a2ui/schema'
import type { Reply } from '../../domain/pinSet'
import type {
  A2uiContent,
  PointAuthor,
  Surface,
  SurfaceCapabilities,
  SurfaceClaim,
  SurfaceClaimObservation,
  SurfaceCompatAlias,
  SurfaceContent,
  SurfaceContentAuthority,
  SurfaceContext,
  SurfaceContributor,
  SurfaceDeleteDisposition,
  SurfaceFreshness,
  SurfaceHome,
  SurfacePrincipalRef,
  SurfaceProvenance,
  SurfaceSourceBinding,
  SurfaceStaleReason,
} from '../../domain/types'
import { createHash } from 'node:crypto'
import { claimsObserveTriggerKind, MAX_SURFACE_CLAIMS, parseSurfaceClaim } from './surface-trigger-matcher'
import { witnessMatches, type WitnessOutcome } from './witness-registry'
import type { DocumentStore } from '../stores/document-store'
import type {
  JsonValue,
  SurfaceCommitRejection,
  SurfaceCommitResult,
  SurfaceIdempotencyReceipt,
} from '../stores/surface-persistence'
import { derivePointStatus } from '../stores/slate'
import type {
  SurfaceDeleteOpts,
  SurfacePlanResult,
  SurfaceRejection,
  SurfaceTopologyOpts,
  SurfaceTopologyPlan,
} from '../stores/surfaces'
import { newSurfaceId } from '../stores/surfaces'
// The migration's placeholder adapter and reserved root alias id. Imported rather
// than restated: `observeSource` decides whether a source adapter may take a binding
// over by comparing against the exact string migration stamps, and two copies of it
// would let a rename silently turn every takeover into a refusal.
import {
  LEGACY_RUN_ROOT_LOCAL_ID,
  LEGACY_SLATE_ADAPTER as LEGACY_PLACEHOLDER_ADAPTER,
} from '../stores/surface-migration'
import {
  buildSurfaceContext,
  NO_HOST_PROBE,
  resolveContributors,
  surfaceCapabilities,
  type SurfaceAccessScope,
  type SurfaceHostProbe,
} from './surface-context'

/** Every primitive in the Agent-Native Action Parity table. Named as a closed
 *  union so a receipt, a log line, and a CLI subcommand cannot drift apart. */
export type SurfaceOperation =
  | 'create'
  /** U2's source INGRESS: one reconciled observation of an authoritative source. */
  | 'observe-source'
  /** U2's source ingress, negative case: an epoch that could see the source did
   *  not find this binding in it. */
  | 'mark-source-missing'
  | 'update-content'
  | 'transfer-content-authority'
  | 'append-thread'
  /** The EXPLICIT half of thread status: resolve, reopen, dismiss (U2). */
  | 'set-thread-disposition'
  | 'group'
  | 'reparent'
  | 'ungroup'
  | 'refresh-request'
  /** U6's durable freshness lifecycle: a typed trigger advanced the host
   *  observation generation; a job took the Surface; the barrier accepted or
   *  refused its result; the sweep re-derived `dueAt`/`overdue`. */
  | 'mark-possibly-stale'
  | 'enqueue-refresh'
  | 'begin-refresh'
  | 'complete-refresh'
  | 'fail-refresh'
  | 'set-refresh-schedule'
  /** U3's claim check: a witness ran outside the coordinator's lock and this is
   *  what it saw. The cheap half of the split — it stamps a Surface witnessed
   *  without waking an agent, and it is NOT a refresh. */
  | 'record-witness-result'
  | 'delete'
  | 'restore'
  | 'purge'

/**
 * Every machine-readable reason this service can report, as a CLOSED union.
 *
 * Closed rather than `string` because both halves it composes are already closed
 * — `SurfaceRejection` from the store, `SurfaceCommitRejection` from the sidecar —
 * and typing the seam between them as an open string threw away the one thing a
 * caller switching on `reason` needs: the guarantee that the compiler will tell it
 * when a new case appears. The four entries below the two unions are the
 * service's own, produced by checks that belong to neither store.
 */
export type SurfaceErrorReason =
  | SurfaceRejection
  | SurfaceCommitRejection
  /** Content authority is the source binding and no adapter can carry the edit
   *  back to it (KTD4). */
  | 'content-authority'
  /** A registered source adapter refused the write. */
  | 'source-write-failed'
  /** A second source adapter tried to take over a binding another one owns (U2). */
  | 'source-conflict'
  /** A refresh was requested for a Surface already queued for one. */
  | 'already-queued'
  /** A refresh was requested for a Surface already being refreshed. */
  | 'already-refreshing'
  /** `ungroup` was asked to dissolve a Surface that holds nothing. */
  | 'not-a-group'
  /** A refresh result was computed against an observation generation the host has
   *  already moved past (KTD10). Not an error in the worker — the world changed
   *  under it — and the Surface is left pending for one successor. */
  | 'superseded'

/** How a request failed, in the shape a caller can act on.
 *
 *  `conflict` always carries `current` — the authoritative records for the ids the
 *  caller named — so "re-read and retry" costs no second round trip and a UI can
 *  restore the true state without asking for a snapshot. That holds for the
 *  TOPOLOGY conflicts too: a plan that never applied still names the ids it was
 *  computed over, and `commitPlan` re-reads them. */
export interface SurfaceServiceError {
  code: 'not-found' | 'invalid' | 'conflict' | 'faulted' | 'write-failed'
  message: string
  /** The store or sidecar's own machine-readable reason, when the failure came
   *  from one of them rather than from body validation. */
  reason?: SurfaceErrorReason
  /** Current authoritative records for the affected ids. */
  current?: Surface[]
  /** The space's current topology revision, for a caller retrying a CAS. */
  topologyRev?: number
}

export type SurfaceResult<T> = { ok: true; data: T } | { ok: false; error: SurfaceServiceError }

/** A Surface plus what may be done to it, which is the pair every read and every
 *  mutation returns. Bundling them is the parity contract: an agent that receives
 *  a record without capabilities has to re-derive the rules the host already
 *  knows, and it will get them subtly wrong. */
export interface SurfaceRecordView {
  surface: Surface
  capabilities: SurfaceCapabilities
}

export interface SurfaceListing {
  spaceId: string
  topologyRev: number
  surfaces: SurfaceRecordView[]
  /** Ids homed on the Canvas, in sibling order — the top level (R29). */
  rootIds: string[]
  /** Roots of deleted subtrees, in sibling order. Present whether or not the
   *  listing includes their records, so a caller always knows the recovery store
   *  is non-empty. */
  recoveryIds: string[]
}

/** The result of any mutation. */
export interface SurfaceMutation {
  op: SurfaceOperation
  spaceId: string
  /** The space topology revision the mutation was computed against. */
  baseTopologyRev: number
  /** The revision THIS operation produced — ALLOCATED at commit time, so it is the
   *  number the space actually reached and not the one planning proposed. Safe to
   *  hold as the next `expectedTopologyRev` on a fresh commit, where it equals
   *  `spaceTopologyRev`; on a replay it is the original transaction's and the world
   *  has moved, so use `spaceTopologyRev`. */
  topologyRev: number
  /** The revision the space is at NOW. Equal to `topologyRev` for a fresh commit;
   *  on a replay it may be higher, because the caller lost a response rather than
   *  the race and the world moved on meanwhile. */
  spaceTopologyRev: number
  /** The affected records. On a fresh commit these are exactly what was written;
   *  on a REPLAY they are the CURRENT records for the same ids — see the receipt
   *  note on {@link SurfaceService} for why the originals are not kept. */
  surfaces: SurfaceRecordView[]
  /** Ids erased. Only `purge` produces these. */
  purged?: string[]
  /** True when the transaction was already durable and nothing was re-applied. */
  replayed: boolean
}

/** Who is acting and under what retry identity. */
export interface SurfaceCallContext {
  actor: SurfacePrincipalRef
  idempotencyKey?: string
  /** Epoch ms for the mutation. Injectable so tests are not time-dependent. */
  at?: number
  /** What this caller may read authored content from. Unrestricted by default —
   *  the trusted-local first release (KTD6). */
  scope?: SurfaceAccessScope
}

/**
 * The seam U2 plugs its file reconciler into (KTD4).
 *
 * When a Surface's content authority is its source binding, a direct API edit may
 * not simply overwrite the record — it has to reach the source, or the next
 * reconciliation pass would silently revert the user's edit and nobody would know
 * why. So a source-bound update is routed here with the watermark the caller
 * believes the source is at, and only the watermark this returns is persisted.
 *
 * U3 registers NO adapters. That is not a stub: with none registered, a
 * source-bound content update is REFUSED with an explanation naming the two legal
 * paths (edit the source, or transfer authority), which is the honest behaviour
 * for a build that genuinely cannot write that file.
 */
export interface SurfaceSourceAdapter {
  write(input: {
    surface: Surface
    content: SurfaceContent
    expectedWatermark?: string
  }): Promise<
    | { ok: true; watermark: string }
    /** `stale` distinguishes "somebody else moved this entry" from "the write could
     *  not happen at all" — a distinction the refresh barrier needs and cannot
     *  recover from a message. A stale refusal is a SUPERSESSION and earns a
     *  successor; an unwritable file is a FAILURE and must not, or a permanently
     *  broken write would spawn a worker per sweep forever. */
    | { ok: false; stale?: true; message: string }
  >
}

/**
 * One reconciled observation of an authoritative source, as {@link
 * SurfaceService.observeSource} takes it.
 *
 * Everything identity-shaped here is DERIVED by the caller from stable inputs (the
 * run incarnation and the entry's local id) rather than read out of the source. A
 * source file that could name its own Surface id would be able to graft its content
 * onto any other Surface's thread.
 */
export interface SurfaceSourceObservation {
  /** The canonical id this binding resolves to. Host-derived, never source-supplied. */
  id: string
  spaceId: string
  /** Home for a NEWLY created record. An existing one keeps whatever home it has,
   *  including one it was promoted to. */
  home: SurfaceHome
  adapter: string
  locator: string
  /** The worktree the locator resolves against, persisted on the binding. */
  worktree?: string
  /** The compatibility alias a newly created record carries (KTD3). */
  alias: SurfaceCompatAlias
  provenance?: SurfaceProvenance
  author: PointAuthor
  content: SurfaceContent
  /** Evidence for THIS observation. Compared for equality against the binding's
   *  stored watermark to decide whether anything actually moved. */
  watermark: string
  order?: number
  createdAt?: number
}

export interface SurfaceServiceOptions {
  probe?: SurfaceHostProbe
  sourceAdapters?: Record<string, SurfaceSourceAdapter>
  /** Overrides id minting. Tests use it for deterministic ids; nothing else does,
   *  and in particular no request body may supply one. */
  newId?: () => string
}

// --- Receipt ---------------------------------------------------------------
//
// THE RECEIPT DECISION, stated where it is implemented.
//
// U1 shipped an opaque caller-supplied `result` capped at 256 entries and left
// the shape to whoever owned "what a response is". That is U3. The choice here is
// a SCALAR ENVELOPE: the operation name, the two revisions, and one `id -> rev`
// map. It stores no records, no content, no thread, and no A2UI body.
//
// The reason is measured, not aesthetic. The sidecar is rewritten WHOLE on every
// commit and its cost is linear in total bytes (U1's measurement: p95 259ms at
// ~10 MiB, knee at ~4.5 MiB, and over half of that is CPU spent serializing and
// re-validating before any IO). A receipt that embedded the records it returned
// would write every affected record TWICE into the file that is already the
// slowest part of the system, and it would do so 256 times over — the retention
// cap is on ENTRIES, not bytes, so whole-record receipts turn a bounded count
// into an effectively unbounded size.
//
// MEASURED, on a representative `group` (one new parent plus three reparented
// children, each with an A2UI body, a source binding, provenance, and a
// three-message thread):
//   · the records themselves                    10,714 B
//   · scalar receipt          (this)               353 B   +3.3%
//   · whole-record receipt    (rejected)        13,834 B   +129%
// And at the 256-entry retention cap, which is what actually lands in the file:
//   · scalar receipt table                        88 KiB   —  1.9% of the 4.5 MiB knee
//   · whole-record receipt table                3.38 MiB   — 75.1% of the knee
// On the COMMON single-record transaction (a thread append) the whole-record
// receipt is 14.5x the scalar one, 3,621 B against 249 B. A receipt table that
// eats three quarters of the measured performance budget on its own is not a
// trade-off; it is the budget.
//
// What the choice costs, stated plainly: a replayed response is NOT byte-identical
// to the original. The receipt names the ids and the revisions the operation
// produced, and the service re-reads those ids at their CURRENT revision to build
// the reply. The invariant that matters — no double-apply, no duplicated thread
// message, no repeated topology change — is preserved exactly, and the caller is
// told `replayed: true` plus both revisions so it can see for itself that the
// world moved. Handing back a stale snapshot of records would arguably be worse:
// the caller's next write would then be built on data the store has already
// superseded.

interface SurfaceReceipt {
  op: SurfaceOperation
  spaceId: string
  baseTopologyRev: number
  topologyRev: number
  /** id -> the revision this operation produced for it. */
  revs: Record<string, number>
  purged?: string[]
}

/** The receipt as the sidecar stores it. A cast rather than a structural
 *  conversion: an optional property is `T | undefined`, which no `JsonValue`
 *  index signature accepts, and reshaping the receipt to satisfy that would put
 *  an always-present empty `purged` array in every one of the 256 retained
 *  entries to please the type checker. Every field above is JSON-native, which is
 *  the property the cast is standing in for. */
function receiptJson(receipt: SurfaceReceipt): JsonValue {
  return receipt as unknown as JsonValue
}

function isReceipt(v: unknown): v is SurfaceReceipt {
  if (!v || typeof v !== 'object') return false
  const r = v as Partial<SurfaceReceipt>
  return typeof r.op === 'string' && typeof r.spaceId === 'string'
    && typeof r.topologyRev === 'number' && !!r.revs && typeof r.revs === 'object'
}

// --- Idempotency fingerprints ---------------------------------------------
//
// AN IDEMPOTENCY KEY IS NOT AN IDENTITY. It is a client's assertion that THIS
// request is a retry of one it already sent. Keying the replay on the key alone
// takes that assertion on trust, and the failure it produces is the worst kind:
// a second, DIFFERENT request under a recycled key returns `ok: true,
// replayed: true` carrying the FIRST call's records, having done nothing. On a
// `purge` that is a success response for an irreversible operation that never ran,
// and the caller's next act is to stop asking about it.
//
// So a receipt records WHAT the key was used for — operation, target, and a digest
// of the request body — and a key hit whose fingerprint differs is a conflict that
// names the operation the key already belongs to. It is never a replayed success.
//
// The digest, not the body: the receipt is a scalar envelope on purpose (see the
// receipt note above), and storing request bodies in the file that is rewritten
// whole on every commit is exactly the cost that decision exists to avoid.

/** Canonical JSON — object keys sorted at every depth — so two structurally equal
 *  bodies fingerprint identically regardless of the order a client serialized
 *  them in. A retry that reorders its own JSON is still a retry. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** `<op>:<target>:<digest>` — self-describing, so the refusal can name what the
 *  key already belongs to without a second lookup, and short enough that 2,048 of
 *  them are noise against the snapshot budget. */
export function requestFingerprint(op: SurfaceOperation, target: string | undefined, body: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(body)).digest('hex').slice(0, 16)
  return `${op}:${target ?? '-'}:${digest}`
}

/**
 * A digest of a Surface's AUTHORED CONTENT — the axis a refresh result competes on.
 *
 * The refresh barrier needs to know "did the content I am about to replace change
 * while I was computing my replacement", and neither of the two things already on
 * the record can answer it.
 *
 * NOT THE REVISION. `beginRefresh`, `setSchedule`, and `markPossiblyStale` are the
 * coordinator's OWN commits and they all bump `rev` during the refresh window, so a
 * job comparing the revision it started at would refuse every result it ever
 * produced. (The `expectedRev` the coordinator passes is re-read on the line above
 * the call, with no await between, so on a single-threaded event loop it can never
 * disagree — the guard exists but is unreachable from its only caller.)
 *
 * NOT THE GENERATION. `updateContent` — the path an agent's Slate write and a
 * user's edit both take — bumps `rev` but does NOT advance `source.generation`: it
 * writes the adapter's new watermark straight onto the binding, so the next
 * `observeSource` sees no evidence move and the barrier sees nothing to supersede.
 *
 * Content, and only content. A thread reply, a schedule change, or an ownership
 * transfer must not supersede a result that is still perfectly valid for the
 * content it replaces.
 */
export function surfaceContentDigest(content: SurfaceContent): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex').slice(0, 16)
}

/** The human half of a fingerprint, for an error message. */
function fingerprintDescription(fingerprint: string): string {
  const [op, target] = fingerprint.split(':')
  if (!op) return 'an earlier request'
  return target && target !== '-' ? `${op} on ${target}` : op
}

// --- Body validation -------------------------------------------------------

/** Fields no request may ever set, on any operation. Identity and both revisions
 *  are host-assigned ("never accepted from mutable request fields"); `home` and
 *  `order` are topology and move only through the dedicated primitives; freshness
 *  state, jobs, and `deleted` belong to the host and the refresh coordinator. */
const FORBIDDEN_FIELDS = [
  'id', 'rev', 'homeRev', 'createdAt', 'amendedAt', 'deleted', 'freshness', 'thread', 'aliases', 'order',
  // `author` is DERIVED from the acting principal on every operation that records
  // one. Accepting it let any caller file its work under `author: 'user'` and have
  // it render as something the human wrote — the one attribution nothing else in
  // the system can check. `group` always derived it; now everything does.
  'author',
] as const

// --- Size caps -------------------------------------------------------------
//
// PORTED from the sibling entry points, not invented here: the Roundup notices
// route and the Slate points route both cap a headline at 200 characters and a
// serialized A2UI body at 32 KiB, twelve lines above the place `routes.ts`
// delegates to this service — and then the delegation crossed into a write path
// with no caps at all.
//
// The gap is measured, not theoretical: five creates carrying ~900 KB headlines,
// each comfortably under the 1 MB HTTP body limit, park the sidecar on its 4.5 MiB
// latency knee (p95 259ms at ~10 MiB, and the sidecar is rewritten WHOLE on every
// commit, so every later mutation in the install pays for them).
//
// REJECTED, never truncated. A truncated headline is a record that does not say
// what its author wrote, and silently: the caller reads back something it did not
// send and has no way to tell that from its own bug.
const HEADLINE_MAX = 200
const CONTENT_MAX = 32 * 1024
/** Recipes and thread messages are prose, not identifiers — bounded at the same
 *  place a component tree is, so no single field can dominate the snapshot. */
const TEXT_MAX = 32 * 1024
/** An idempotency key is an opaque token a client chooses; it is persisted in
 *  every receipt, so it is bounded like everything else that reaches the file. */
const IDEMPOTENCY_KEY_MAX = 200

/**
 * Characters a principal or provenance id may contain.
 *
 * These ids are not decorative. `SurfaceHostProbe.isLiveSession` joins one into a
 * path under the sessions directory and reads it, so `../../../etc/passwd` in a
 * `owner.id` — a field any request body may set — is a filesystem read outside the
 * intended root, and the id is PERSISTED, so it re-triggers on every later context
 * read of that record. The charset is the one tmux session names already live in.
 */
const PRINCIPAL_ID = /^[A-Za-z0-9._@:+-]{1,128}$/

/** True when an id is safe to hand to the host probe as a path segment. Rejects
 *  separators, `..`, and anything outside the session-name charset. */
export function isSafePrincipalId(id: string): boolean {
  if (!PRINCIPAL_ID.test(id)) return false
  return id !== '.' && id !== '..'
}

/** Everything a content PATCH may name. Enforced exhaustively — see
 *  {@link SurfaceService.updateContent}. */
const CONTENT_PATCH_FIELDS: readonly string[] =
  ['headline', 'body', 'recipe', 'claims', 'expectedRev', 'expectedWatermark']

/**
 * Who a mutation is attributed to, derived from WHO IS CALLING and never from the
 * request body.
 *
 * `author` is the field a human reads to decide whether something is theirs. A
 * body that could set it let any local process file its work as `user`, and
 * nothing downstream can check that claim — `group()` already derived it, and this
 * is that rule applied everywhere.
 */
function authorFor(actor: SurfacePrincipalRef): PointAuthor {
  if (actor.kind === 'human') return 'user'
  if (actor.kind === 'process') return 'process'
  return 'agent'
}

/** The ids a home names, for a conflict's `current`. The Canvas names none. */
function homeIds(home: SurfaceHome): string[] {
  return home.kind === 'surface' ? [home.surfaceId] : []
}

/** Freshness with the owning job dropped — `delete` rather than `undefined`,
 *  because an `undefined` property survives in memory and disappears across JSON,
 *  so a record and its reload would not be the same object. */
function omitJob(freshness: SurfaceFreshness): SurfaceFreshness {
  const next = { ...freshness }
  delete next.jobId
  return next
}

// --- Claim observation (plan U3) -------------------------------------------

/** One claim's outcome, exactly as the caller's witness runner produced it. The
 *  three-valued outcome is carried WHOLE rather than pre-reduced to a boolean: the
 *  reduction is `witnessMatches`', and doing it at the call site is how a caller
 *  would eventually let an `unresolved` count as a match (KTD8). */
export interface WitnessObservationInput {
  claimId: string
  outcome: WitnessOutcome
}

/** What to store for one claim after a run, or the stored observation UNCHANGED
 *  when the run saw exactly what was already there.
 *
 *  Returning the prior object on a no-op is not a micro-optimisation — it is what
 *  keeps `at` a moved-at rather than a looked-at timestamp, and therefore what keeps
 *  the whole-record no-change guard able to see a steady state as steady. */
function observationFrom(
  stored: SurfaceClaimObservation | undefined, outcome: WitnessOutcome, now: number,
): SurfaceClaimObservation {
  const candidate: SurfaceClaimObservation = outcome.status === 'value'
    ? { value: outcome.value, at: now }
    : {
      // The last known value SURVIVES an outcome that produced none. A fetch that
      // failed says nothing about whether the world moved, and dropping the value
      // would turn an outage into a fabricated change on the next successful run.
      ...(stored && 'value' in stored ? { value: stored.value } : {}),
      problem: { status: outcome.status, detail: outcome.detail },
      at: now,
    }
  return stored && sameObservation(stored, candidate) ? stored : candidate
}

/** Semantic equality for an observation — everything except when it was recorded. */
function sameObservation(a: SurfaceClaimObservation, b: SurfaceClaimObservation): boolean {
  // `'value' in` rather than `!== undefined`, because `null` is a genuine absence a
  // completed lookup reported (R7) and is the one value allowed to match itself.
  return ('value' in a) === ('value' in b)
    && Object.is(a.value, b.value)
    && a.problem?.status === b.problem?.status
    && a.problem?.detail === b.problem?.detail
}

/** Declared claims the host has never LOOKED at. What the reconcile path seeds, and
 *  bounded to once per claim per lifetime — a claim that was looked at and came back
 *  unresolved is not re-seeded here, because the seeding path runs on the poll floor
 *  and re-running a failing network witness every few seconds is the storm this
 *  whole split exists to avoid. The deadline path retries it. */
export function claimsNeverObserved(surface: Surface): SurfaceClaim[] {
  const stored = surface.freshness.claimObservations
  return (surface.content.claims ?? []).filter(c => !stored?.[c.id])
}

/** Declared claims with no stored value — never looked at, or looked at and never
 *  answered. R8's "a claim's first observed value is recorded before any deadline
 *  elapses" is what this is for: a claim in this list is due NOW rather than a full
 *  interval from now, so a fresh card is never left asserting anything on the
 *  strength of a check that has not happened. */
export function claimsWithoutStoredValue(surface: Surface): SurfaceClaim[] {
  const stored = surface.freshness.claimObservations
  return (surface.content.claims ?? []).filter(c => {
    const was = stored?.[c.id]
    return !was || !('value' in was)
  })
}

function asObject(body: unknown): Record<string, unknown> | null {
  // `JSON.parse('null')`, `'42'`, and `'[]'` all parse. Property reads on those
  // would throw deep inside a handler, so they are refused here.
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  return body as Record<string, unknown>
}

function invalid(message: string): { ok: false; error: SurfaceServiceError } {
  return { ok: false, error: { code: 'invalid', message } }
}

function notFound(id: string): { ok: false; error: SurfaceServiceError } {
  return { ok: false, error: { code: 'not-found', message: `no canonical Surface ${id}` } }
}

/** Reject host-owned fields before anything else looks at the body. Returns the
 *  offending field name, or null. */
function forbiddenField(body: Record<string, unknown>, allow: readonly string[] = []): string | null {
  for (const field of FORBIDDEN_FIELDS) {
    if (allow.includes(field)) continue
    if (body[field] !== undefined) return field
  }
  return null
}

function parseHome(value: unknown): SurfaceHome | string {
  const home = asObject(value)
  if (!home) return 'home must be an object'
  if (home.kind === 'canvas') {
    if (typeof home.spaceId !== 'string' || !home.spaceId) return 'home.spaceId must be a non-empty string'
    return { kind: 'canvas', spaceId: home.spaceId }
  }
  if (home.kind === 'surface') {
    if (typeof home.surfaceId !== 'string' || !home.surfaceId) return 'home.surfaceId must be a non-empty string'
    return { kind: 'surface', surfaceId: home.surfaceId }
  }
  // `recovery` is deliberately unparseable from a request. Naming it as a home
  // would be a delete performed through the reparent primitive, skipping the
  // descendant disposition and the deletion marker that make a delete undoable.
  return "home.kind must be 'canvas' or 'surface'"
}

/** The size checks, shared by `create`/`group` and the content PATCH so the two
 *  doors cannot admit different sizes. Returns the refusal message, or null. */
function oversize(field: string, value: string | undefined, max: number): string | null {
  if (value === undefined) return null
  return value.length > max ? `${field} exceeds ${max} characters` : null
}

function parseContent(value: unknown, required: boolean): SurfaceContent | string | undefined {
  const raw = asObject(value)
  if (!raw) return required ? 'content must be an object' : undefined
  if (typeof raw.headline !== 'string' || !raw.headline.trim()) {
    return 'content.headline must be a non-empty string'
  }
  const tooLong = oversize('content.headline', raw.headline, HEADLINE_MAX)
  if (tooLong) return tooLong
  let body: A2uiContent | undefined
  if (raw.body !== undefined && raw.body !== null) {
    // Measured on the SERIALIZED form, which is what reaches the file — a
    // component tree's cost is its bytes, not its node count.
    if (JSON.stringify(raw.body).length > CONTENT_MAX) {
      return `content.body exceeds ${CONTENT_MAX} bytes`
    }
    const parsed = parseA2uiContent(raw.body)
    if (!parsed) return 'content.body is not valid A2UI for the bounded component catalog'
    body = parsed
  }
  if (raw.recipe !== undefined && raw.recipe !== null && typeof raw.recipe !== 'string') {
    return 'content.recipe must be a string'
  }
  const recipeTooLong = oversize('content.recipe', typeof raw.recipe === 'string' ? raw.recipe : undefined, TEXT_MAX)
  if (recipeTooLong) return recipeTooLong
  // Claims are settable here so an agent can author through this door what it can
  // author through a file (plan U1/R1). `[]` is kept as `[]`: the author checked and
  // found nothing witnessable, which is a different answer from never having said.
  let claims: SurfaceClaim[] | undefined
  if (raw.claims !== undefined && raw.claims !== null) {
    const parsed = parseClaimsField(raw.claims, 'content.claims')
    if (typeof parsed === 'string') return parsed
    claims = parsed
  }
  return {
    headline: raw.headline.trim(),
    ...(body ? { body } : {}),
    ...(typeof raw.recipe === 'string' && raw.recipe ? { recipe: raw.recipe } : {}),
    ...(claims !== undefined ? { claims } : {}),
  }
}

/**
 * A claims declaration from a REQUEST, or the refusal message.
 *
 * REFUSES where the file door drops (plan U1/KTD5), and the difference is the error
 * channel rather than a difference of opinion about what a valid claim is — both
 * doors call the same `parseSurfaceClaim`. A file has nowhere to report a mistyped
 * witness kind, so it drops the claim and keeps the surface; this endpoint already
 * names every field it will not accept back to the caller, and a claim silently
 * missing from a 200 response is the failure that whitelist enforcement exists to
 * prevent.
 *
 * An empty array is a VALUE, not an absence — see `SurfaceContent.claims`.
 */
function parseClaimsField(value: unknown, field: string): SurfaceClaim[] | string {
  if (!Array.isArray(value)) return `${field} must be an array of claims`
  if (value.length > MAX_SURFACE_CLAIMS) {
    // Refused whole, never truncated, for the reason the size caps above give.
    return `${field} declares more than ${MAX_SURFACE_CLAIMS} claims`
  }
  const out: SurfaceClaim[] = []
  for (const entry of value) {
    const claim = parseSurfaceClaim(entry)
    if (typeof claim === 'string') return `${field}: ${claim}`
    if (out.some(c => c.id === claim.id)) return `${field} declares ${JSON.stringify(claim.id)} twice`
    out.push(claim)
  }
  return out
}

function parseIdList(value: unknown, field: string): string[] | string {
  if (!Array.isArray(value)) return `${field} must be an array of Surface ids`
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry) return `${field} must contain only non-empty Surface ids`
    out.push(entry)
  }
  return out
}

function parseProvenance(value: unknown): SurfaceProvenance | string | undefined {
  const raw = asObject(value)
  if (!raw) return undefined
  const out: SurfaceProvenance = {}
  for (const key of ['project', 'repo', 'worktreeId', 'runId', 'sessionId'] as const) {
    const v = raw[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return `provenance.${key} must be a string`
    // `runId` and `sessionId` become principal ids in `resolveContributors`, which
    // hands them to the host probe as path segments. Checked at the boundary, and
    // again at the probe — a record persisted before this check must not be able
    // to re-trigger the traversal on every later context read.
    if ((key === 'runId' || key === 'sessionId') && !isSafePrincipalId(v)) {
      return `provenance.${key} is not a valid session identifier`
    }
    if (v.length > 512) return `provenance.${key} exceeds 512 characters`
    out[key] = v
  }
  return out
}

function parsePrincipal(value: unknown, field: string): SurfacePrincipalRef | string | undefined {
  const raw = asObject(value)
  if (!raw) return undefined
  const kinds = ['human', 'session', 'job', 'process']
  if (typeof raw.kind !== 'string' || !kinds.includes(raw.kind)) {
    return `${field}.kind must be one of ${kinds.join(', ')}`
  }
  if (typeof raw.id !== 'string' || !raw.id) return `${field}.id must be a non-empty string`
  if (!isSafePrincipalId(raw.id)) {
    return `${field}.id must match [A-Za-z0-9._@:+-] and may not contain path separators`
  }
  if (raw.label !== undefined && typeof raw.label === 'string' && raw.label.length > HEADLINE_MAX) {
    return `${field}.label exceeds ${HEADLINE_MAX} characters`
  }
  return {
    kind: raw.kind as SurfacePrincipalRef['kind'],
    id: raw.id,
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
  }
}

function parseSource(value: unknown): SurfaceSourceBinding | string | undefined {
  const raw = asObject(value)
  if (!raw) return undefined
  if (typeof raw.adapter !== 'string' || !raw.adapter) return 'source.adapter must be a non-empty string'
  if (typeof raw.locator !== 'string' || !raw.locator) return 'source.locator must be a non-empty string'
  const tooLong = oversize('source.adapter', raw.adapter, HEADLINE_MAX)
    ?? oversize('source.locator', raw.locator, 1024)
    ?? oversize('source.watermark', typeof raw.watermark === 'string' ? raw.watermark : undefined, HEADLINE_MAX)
  if (tooLong) return tooLong
  if (raw.generation !== undefined) {
    // The observation generation is HOST-owned and monotonic (KTD10). Accepting a
    // caller's number would let a stale author claim to have observed a newer
    // source than it did, which is exactly the lie the generation exists to catch.
    return 'source.generation is host-owned and may not be supplied'
  }
  // The reconciliation STATE (`state`, `missingSince`, `divergedWatermark`) is
  // host-owned for the same reason and is simply not read here: a caller declaring
  // its own source already missing, or already diverged, would be describing an
  // observation no reconciler made.
  if (raw.worktree !== undefined && (typeof raw.worktree !== 'string' || !raw.worktree)) {
    return 'source.worktree must be a non-empty string'
  }
  const worktreeTooLong = oversize('source.worktree', typeof raw.worktree === 'string' ? raw.worktree : undefined, 1024)
  if (worktreeTooLong) return worktreeTooLong
  return {
    adapter: raw.adapter,
    locator: raw.locator,
    ...(typeof raw.worktree === 'string' ? { worktree: raw.worktree } : {}),
    generation: 0,
    ...(typeof raw.watermark === 'string' ? { watermark: raw.watermark } : {}),
  }
}

// --- Service ---------------------------------------------------------------

export class SurfaceService {
  private readonly probe: SurfaceHostProbe
  private readonly adapters: Record<string, SurfaceSourceAdapter>
  private readonly mintId: () => string

  constructor(private readonly docStore: DocumentStore, opts: SurfaceServiceOptions = {}) {
    this.probe = opts.probe ?? NO_HOST_PROBE
    this.adapters = opts.sourceAdapters ?? {}
    this.mintId = opts.newId ?? newSurfaceId
  }

  // --- Reads ---

  /**
   * Every Surface in a space, plus the two orderings a caller cannot derive from
   * a flat list without re-implementing sibling comparison.
   *
   * Deleted records are EXCLUDED by default. Including them silently would put
   * the recovery store on the Canvas; excluding them without saying so would hide
   * that anything is recoverable — hence `recoveryIds` is always populated.
   */
  list(query: { spaceId: string; includeDeleted?: boolean }): SurfaceResult<SurfaceListing> {
    const { spaceId } = query
    if (!spaceId) return invalid('spaceId is required')
    const recovery = this.docStore.getSurfaceRecoveryRoots(spaceId)
    const recoveryIds = new Set(recovery.map(s => s.id))
    const all = this.docStore.getSurfacesForSpace(spaceId)
    const visible = query.includeDeleted
      ? all
      : all.filter(s => !this.docStore.surfaceRecoveryRootFor(s.id))
    return {
      ok: true,
      data: {
        spaceId,
        topologyRev: this.docStore.getSurfaceTopologyRev(spaceId),
        surfaces: visible.map(s => this.view(s)),
        rootIds: this.docStore.getSurfaceRoots(spaceId).map(s => s.id),
        recoveryIds: [...recoveryIds],
      },
    }
  }

  get(id: string): SurfaceResult<SurfaceRecordView> {
    const surface = this.docStore.getSurface(id)
    if (!surface) return notFound(id)
    return { ok: true, data: this.view(surface) }
  }

  context(id: string, ctx: SurfaceCallContext): SurfaceResult<SurfaceContext> {
    const built = buildSurfaceContext(this.docStore, id, {
      ...(ctx.scope ? { scope: ctx.scope } : {}),
      probe: this.probe,
      sourceAdapters: new Set(Object.keys(this.adapters)),
    })
    if (!built) return notFound(id)
    return { ok: true, data: built }
  }

  /**
   * Every live Surface aliased to `runId` whose source binding belongs to
   * `adapter`, paired with the run-local id its alias carries.
   *
   * The PRIOR half of an epoch comparison (plan U2). Scoped by adapter because a
   * reconciler may only reason about its own bindings: the file reconciler must not
   * see a `legacy-slate-point` binding and conclude its file is gone, when that
   * binding never named a file at all.
   *
   * A Surface may carry several run aliases (KTD3). Only the one for `runId` is
   * returned, because that is the id this run's epoch addresses it by.
   */
  sourceBindingsForRun(runId: string, adapter: string): { surface: Surface; localId: string }[] {
    const out: { surface: Surface; localId: string }[] = []
    for (const surface of this.docStore.getSurfacesForRunAlias(runId)) {
      if (surface.source?.adapter !== adapter) continue
      const alias = (surface.aliases ?? []).find(a => a.bucket.kind === 'run' && a.bucket.runId === runId)
      if (alias) out.push({ surface, localId: alias.localId })
    }
    return out
  }

  contributors(id: string): SurfaceResult<{ id: string; contributors: SurfaceContributor[] }> {
    const surface = this.docStore.getSurface(id)
    if (!surface) return notFound(id)
    return { ok: true, data: { id, contributors: resolveContributors(surface, this.probe) } }
  }

  // --- Idempotency pre-flight ---

  /**
   * What every mutation does BEFORE it touches the store.
   *
   * The ordering here is the fix, not the lookup. The replay check used to live at
   * the bottom of the stack, inside the durable transaction, which meant a retry
   * had to survive this service's existence, liveness and compare-and-swap checks
   * to reach it — and it cannot:
   *
   *   · `update-content` and `transfer-content-authority` REQUIRE `expectedRev`,
   *     and a retry carries the revision it read before its FIRST attempt. That
   *     attempt succeeded and bumped the revision, so the retry is refused as
   *     stale. The one thing an idempotency key exists to make safe was the one
   *     thing it could not make safe, and the shipped skill documents
   *     compare-and-swap and `--idempotency-key` as independently combinable.
   *   · A retry whose target was purged in the meantime is refused as `not-found`,
   *     though the receipt for the transaction it is asking about is on file.
   *
   * Consulting the receipt first answers both from the record of what happened,
   * which is what the caller is actually asking for. The durable layer keeps its
   * own identical check as the backstop for the narrow race where two retries
   * arrive together.
   */
  private preflight(
    op: SurfaceOperation, target: string | undefined, body: unknown, ctx: SurfaceCallContext,
  ): { done: SurfaceResult<SurfaceMutation> } | { done?: undefined; fingerprint?: string } {
    const key = ctx.idempotencyKey
    if (!key) return {}
    if (key.length > IDEMPOTENCY_KEY_MAX) {
      return { done: invalid(`Idempotency-Key exceeds ${IDEMPOTENCY_KEY_MAX} characters`) }
    }
    const fingerprint = requestFingerprint(op, target, body)
    const receipt = this.docStore.lookupSurfaceReceipt(key)
    if (!receipt) return { fingerprint }
    if (receipt.fingerprint !== fingerprint) {
      return { done: this.keyReuse(key, receipt) }
    }
    // A receipt whose payload this build cannot read is treated as ABSENT rather
    // than as a replay: fabricating a success from an unreadable envelope is worse
    // than re-running through the durable layer, which holds the same receipt and
    // will short-circuit there.
    if (!isReceipt(receipt.result)) return { fingerprint }
    return { done: this.fromReceipt(op, receipt.result) }
  }

  private keyReuse(key: string, receipt: SurfaceIdempotencyReceipt): { ok: false; error: SurfaceServiceError } {
    const owner = receipt.fingerprint ? fingerprintDescription(receipt.fingerprint) : 'an earlier request'
    return {
      ok: false,
      error: {
        code: 'conflict',
        reason: 'idempotency-key-reuse',
        message:
          `Idempotency-Key "${key}" already belongs to ${owner}. A key identifies one request, not a caller — ` +
          'reusing it across two different operations would report the first one\'s success for work the second ' +
          'never did. Use a fresh key.',
        current: receipt.ids.map(id => this.docStore.getSurface(id)).filter((s): s is Surface => !!s),
      },
    }
  }

  /** Rebuild a mutation response from a persisted receipt, at the records' CURRENT
   *  revisions — the same reconstruction {@link fromCommit} does on a replay, and
   *  for the same reason (see the receipt note above). */
  private fromReceipt(op: SurfaceOperation, receipt: SurfaceReceipt): SurfaceResult<SurfaceMutation> {
    const surfaces = Object.keys(receipt.revs)
      .map(id => this.docStore.getSurface(id))
      .filter((s): s is Surface => !!s)
      .map(s => this.view(s))
    return {
      ok: true,
      data: {
        op,
        spaceId: receipt.spaceId,
        baseTopologyRev: receipt.baseTopologyRev,
        topologyRev: receipt.topologyRev,
        spaceTopologyRev: this.docStore.getSurfaceTopologyRev(receipt.spaceId),
        surfaces,
        ...(receipt.purged ? { purged: receipt.purged } : {}),
        replayed: true,
      },
    }
  }

  // --- Create ---

  /**
   * Mint a Surface.
   *
   * A compatibility alias is assigned HERE rather than later, so rollback
   * reachability exists from the first durable commit: a Surface created while
   * recursive mode is on must still be findable through a flat run or
   * workspace-recovery list if that mode is switched off five minutes later
   * (KTD3). The run alias is used when the caller declared a run; otherwise the
   * Surface joins the workspace-recovery bucket, which is exactly its definition —
   * a Surface with no source run.
   */
  async create(body: unknown, ctx: SurfaceCallContext): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('create', undefined, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body)
    if (!raw) return invalid('body must be a JSON object')
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on create`)

    if (typeof raw.spaceId !== 'string' || !raw.spaceId) return invalid('spaceId must be a non-empty string')
    const home = parseHome(raw.home)
    if (typeof home === 'string') return invalid(home)
    const content = parseContent(raw.content, true)
    if (typeof content === 'string') return invalid(content)
    if (!content) return invalid('content is required')

    const provenance = parseProvenance(raw.provenance)
    if (typeof provenance === 'string') return invalid(provenance)
    const owner = parsePrincipal(raw.owner, 'owner')
    if (typeof owner === 'string') return invalid(owner)
    const source = parseSource(raw.source)
    if (typeof source === 'string') return invalid(source)

    if (raw.contentAuthority !== undefined
      && raw.contentAuthority !== 'source-binding' && raw.contentAuthority !== 'canonical-direct') {
      return invalid("contentAuthority must be 'source-binding' or 'canonical-direct'")
    }
    if (raw.contentAuthority === 'source-binding' && !source) {
      return invalid('contentAuthority source-binding requires a source binding')
    }

    const opts = this.topologyOpts(raw, ctx)
    if (typeof opts === 'string') return invalid(opts)

    const id = this.mintId()
    const runId = provenance?.runId
    const alias: SurfaceCompatAlias = runId
      ? { bucket: { kind: 'run', runId }, localId: id, visible: true }
      : { bucket: { kind: 'workspace-recovery' }, localId: id, visible: true }

    const plan = this.docStore.planSurfaceCreate({
      id,
      spaceId: raw.spaceId,
      home,
      content,
      ...(raw.contentAuthority ? { contentAuthority: raw.contentAuthority as SurfaceContentAuthority } : {}),
      author: authorFor(ctx.actor),
      ...(source ? { source } : {}),
      ...(provenance && Object.keys(provenance).length > 0 ? { provenance } : {}),
      ...(owner ? { owner } : {}),
      aliases: [alias],
      ...(raw.compatibilityOnly === true ? { compatibilityOnly: true } : {}),
    }, opts)
    return this.commitPlan('create', plan, ctx, [id, ...homeIds(home)], flight.fingerprint)
  }

  // --- Content ---

  /**
   * Replace authored content behind a revision gate.
   *
   * The whitelist is `headline`, `body`, `recipe`, and `claims` — nothing else on
   * the record is authored content, and a caller that names anything else is told so
   * rather than having it quietly ignored. `null` clears `body`, `recipe`, or
   * `claims`; omitting them keeps what is there, which is the distinction a PATCH
   * has to make and a PUT cannot.
   *
   * The whitelist is ENFORCED, exhaustively, which it was not: every field outside
   * the set below used to be dropped in silence, so a caller that believed it had
   * moved content authority, changed the owner, or rewritten provenance in the same
   * PATCH got a 200 and none of it. Naming the field back is the whole difference
   * between a caller that retries correctly and one that never finds out.
   */
  async updateContent(id: string, body: unknown, ctx: SurfaceCallContext): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('update-content', id, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body)
    if (!raw) return invalid('body must be a JSON object')
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on update-content`)
    if (raw.home !== undefined) {
      return invalid('home is topology and changes only through reparent, group, or ungroup')
    }
    if (raw.spaceId !== undefined) return invalid('spaceId is immutable')
    const unknown = Object.keys(raw).find(k => !CONTENT_PATCH_FIELDS.includes(k))
    if (unknown) {
      return invalid(
        `${unknown} is not authored content and is not settable through a content PATCH ` +
        `(this endpoint takes ${CONTENT_PATCH_FIELDS.join(', ')})`,
      )
    }

    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'update-content')
    if (guard) return guard
    if (typeof raw.expectedRev !== 'number') {
      return invalid('expectedRev is required — a content write is a compare-and-swap on the record revision')
    }
    if (raw.expectedRev !== prior.rev) return this.conflictOn([prior], 'stale-surface-revision')

    const headline = raw.headline
    if (headline !== undefined && (typeof headline !== 'string' || !headline.trim())) {
      return invalid('headline must be a non-empty string')
    }
    const headlineTooLong = oversize('headline', typeof headline === 'string' ? headline : undefined, HEADLINE_MAX)
    if (headlineTooLong) return invalid(headlineTooLong)
    let nextBody: A2uiContent | undefined = prior.content.body
    if (raw.body === null) nextBody = undefined
    else if (raw.body !== undefined) {
      if (JSON.stringify(raw.body).length > CONTENT_MAX) return invalid(`body exceeds ${CONTENT_MAX} bytes`)
      const parsed = parseA2uiContent(raw.body)
      if (!parsed) return invalid('body is not valid A2UI for the bounded component catalog')
      nextBody = parsed
    }
    let recipe: string | undefined = prior.content.recipe
    if (raw.recipe === null) recipe = undefined
    else if (raw.recipe !== undefined) {
      if (typeof raw.recipe !== 'string') return invalid('recipe must be a string or null')
      const recipeTooLong = oversize('recipe', raw.recipe, TEXT_MAX)
      if (recipeTooLong) return invalid(recipeTooLong)
      recipe = raw.recipe || undefined
    }
    // PATCH semantics, exactly as `body` and `recipe` have them: `null` clears the
    // declaration, omitting it keeps what is there. The omission case is the
    // load-bearing one — this endpoint is where a headline edit arrives, and without
    // the carry-forward every such edit would silently delete the Surface's claims
    // from the record and, through the egress adapter, from the author's own file.
    let claims: SurfaceClaim[] | undefined = prior.content.claims
    if (raw.claims === null) claims = undefined
    else if (raw.claims !== undefined) {
      const parsed = parseClaimsField(raw.claims, 'claims')
      if (typeof parsed === 'string') return invalid(parsed)
      claims = parsed
    }

    const content: SurfaceContent = {
      headline: typeof headline === 'string' ? headline.trim() : prior.content.headline,
      ...(nextBody ? { body: nextBody } : {}),
      ...(recipe ? { recipe } : {}),
      // Carried, not settable. The freshness declaration is authored alongside the
      // recipe (U6) and this endpoint takes only CONTENT_PATCH_FIELDS, so omitting
      // it here would make every headline edit silently delete the Surface's
      // triggers and put it back on the host defaults.
      ...(prior.content.refreshPolicy ? { refreshPolicy: prior.content.refreshPolicy } : {}),
      // LAST, matching the key order every other content builder uses (the source
      // entry, and the refresh barrier below). The store's storm guard compares
      // records with `JSON.stringify`, so two builders that emit the same fields in
      // different orders make a semantically identical record look like a change —
      // one spurious revision and one SSE fan-out per API edit of a file-bound
      // Surface. `!== undefined`, not truthiness: `[]` is a declaration and survives.
      ...(claims !== undefined ? { claims } : {}),
    }

    // Source-bound content does not belong to the API (KTD4). Either an adapter
    // carries the edit back to the source — so the next reconciliation agrees with
    // it — or the caller transfers authority first. Silently writing the record
    // would let the file win on the very next epoch and lose the edit with no
    // error anywhere.
    let source = prior.source
    if (prior.contentAuthority === 'source-binding') {
      const adapter = prior.source ? this.adapters[prior.source.adapter] : undefined
      if (!prior.source || !adapter) {
        return {
          ok: false,
          error: {
            code: 'conflict',
            reason: 'content-authority',
            message:
              `content authority is the source binding "${prior.source?.adapter ?? 'unknown'}" and no adapter is ` +
              'registered to carry this edit back to it. Update the source, or call ' +
              'transfer-content-authority to take canonical-direct authority first.',
            current: [prior],
          },
        }
      }
      if (raw.expectedWatermark !== undefined && typeof raw.expectedWatermark !== 'string') {
        return invalid('expectedWatermark must be a string')
      }
      const written = await adapter.write({
        surface: prior,
        content,
        ...(typeof raw.expectedWatermark === 'string' ? { expectedWatermark: raw.expectedWatermark } : {}),
      })
      if (!written.ok) {
        return { ok: false, error: { code: 'conflict', reason: 'source-write-failed', message: written.message, current: [prior] } }
      }
      source = { ...prior.source, watermark: written.watermark }
    }

    const now = ctx.at ?? Date.now()
    const next: Surface = {
      ...prior,
      content,
      ...(source ? { source } : {}),
      rev: prior.rev + 1,
      amendedAt: now,
    }
    return this.commitContent('update-content', prior, next, ctx, flight.fingerprint)
  }

  /**
   * Move content authority between the source binding and the record (KTD4).
   *
   * Explicit, revision-checked, and persisted — never inferred. Inferring it from
   * whether a binding exists would silently reassign authority the first time a
   * source file went missing, which is the one moment the answer matters most.
   */
  async transferContentAuthority(
    id: string, body: unknown, ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('transfer-content-authority', id, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body)
    if (!raw) return invalid('body must be a JSON object')
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on transfer-content-authority`)
    const to = raw.to
    if (to !== 'source-binding' && to !== 'canonical-direct') {
      return invalid("to must be 'source-binding' or 'canonical-direct'")
    }
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'transfer-content-authority')
    if (guard) return guard
    if (typeof raw.expectedRev !== 'number') return invalid('expectedRev is required')
    if (raw.expectedRev !== prior.rev) return this.conflictOn([prior], 'stale-surface-revision')
    if (to === 'source-binding' && !prior.source) {
      return invalid('cannot give authority to a source binding: this Surface has none')
    }
    if (prior.contentAuthority === to) {
      return { ok: false, error: { code: 'conflict', reason: 'no-change', message: `content authority is already ${to}`, current: [prior] } }
    }
    // Taking authority does not by itself make the actor the AUTHOR — a user may
    // freeze an agent's content without claiming to have written it, and flipping the
    // byline for them would put the agent's words under the user's name. So the
    // authorship claim is opt-in and separate. The Objective's takeover uses it: the
    // headline it writes really is the user's, and rendering it as the agent's was
    // the failure the legacy `claim` flag existed to prevent.
    if (raw.claimAuthorship !== undefined && typeof raw.claimAuthorship !== 'boolean') {
      return invalid('claimAuthorship must be a boolean')
    }
    if (raw.claimAuthorship === true && to !== 'canonical-direct') {
      return invalid('claimAuthorship applies only when taking canonical-direct authority')
    }
    const next: Surface = {
      ...prior,
      contentAuthority: to,
      ...(raw.claimAuthorship === true ? { author: authorFor(ctx.actor) } : {}),
      rev: prior.rev + 1,
      amendedAt: ctx.at ?? Date.now(),
    }
    return this.commitContent('transfer-content-authority', prior, next, ctx, flight.fingerprint)
  }

  // --- Source ingress (plan U2) ---
  //
  // The counterpart to {@link SurfaceSourceAdapter}, which carries an API edit OUT
  // to a source. These three carry a source observation IN. They are typed rather
  // than `unknown`-and-whitelisted like the operations above, because the caller is
  // the host's own reconciler and not a request body: there is no untrusted field
  // to strip, and parsing a shape the server just built would be ceremony.
  //
  // WHAT THEY REFUSE TO DO IS THE POINT. None of them touches home, thread,
  // lifecycle, owner, or per-user view state — a source may replace authored
  // content and its own binding evidence, and nothing else (KTD4). None of them
  // removes a record: an omission marks a binding missing, and a Surface only ever
  // leaves the tree through the deletion service.

  /**
   * Reconcile ONE observation of a source binding.
   *
   * Creates the Surface when nothing holds its derived id, updates authored content
   * when the binding is authoritative and the evidence moved, and records DIVERGENCE
   * when authority has been transferred to the record (KTD4: "Canonical-direct
   * content ignores later file changes except to report divergence").
   *
   * The generation advances only when the WATERMARK changes, which is what makes
   * this safe to call on the poll floor: a re-observation of unchanged content is a
   * no-op that never reaches the durable layer, so a three-second poll does not burn
   * a revision per surface per tick. A rename — same evidence, new locator — rewrites
   * the address without advancing the generation, because no new content was
   * observed.
   */
  async observeSource(obs: SurfaceSourceObservation, ctx: SurfaceCallContext): Promise<SurfaceResult<SurfaceMutation>> {
    const now = ctx.at ?? Date.now()
    const prior = this.docStore.getSurface(obs.id)
    if (!prior) {
      const plan = this.docStore.planSurfaceCreate({
        id: obs.id,
        spaceId: obs.spaceId,
        home: obs.home,
        content: obs.content,
        contentAuthority: 'source-binding',
        author: obs.author,
        source: {
          adapter: obs.adapter,
          locator: obs.locator,
          ...(obs.worktree ? { worktree: obs.worktree } : {}),
          generation: 1,
          watermark: obs.watermark,
          state: 'present',
        },
        ...(obs.provenance ? { provenance: obs.provenance } : {}),
        ...(obs.order != null ? { order: obs.order } : {}),
        ...(obs.createdAt != null ? { createdAt: obs.createdAt } : {}),
        aliases: [obs.alias],
        freshness: { phase: 'current', overdue: false, observedGeneration: 1, verifiedAt: now },
      }, { at: now })
      return this.commitPlan('observe-source', plan, ctx, [obs.id, ...homeIds(obs.home)])
    }

    const guard = this.guardLive(prior, 'reconciling its source')
    if (guard) return guard

    // An adapter may only be REPLACED when the prior one was the migration's
    // placeholder. `legacy-slate-point` is a logical address into the legacy bridge
    // with no file behind it, so a real file reconciler taking it over is the
    // binding finally learning where it lives. Two real adapters claiming one
    // Surface is a different thing entirely — whichever ran last would win every
    // epoch — so it is refused rather than resolved.
    const priorAdapter = prior.source?.adapter
    if (priorAdapter && priorAdapter !== obs.adapter && priorAdapter !== LEGACY_PLACEHOLDER_ADAPTER) {
      return {
        ok: false,
        error: {
          code: 'conflict',
          reason: 'source-conflict',
          message:
            `Surface ${obs.id} is already bound to source adapter "${priorAdapter}"; ` +
            `"${obs.adapter}" may not take it over. Transfer content authority explicitly instead.`,
          current: [prior],
        },
      }
    }

    const authoritative = prior.contentAuthority === 'source-binding'
    const evidenceMoved = prior.source?.watermark !== obs.watermark
    const binding: SurfaceSourceBinding = {
      adapter: obs.adapter,
      locator: obs.locator,
      ...(obs.worktree ? { worktree: obs.worktree } : {}),
      generation: (prior.source?.generation ?? 0) + (authoritative && evidenceMoved ? 1 : 0),
      // The last-VALID watermark. Under canonical-direct authority the record's
      // content still reflects the older observation, so overwriting the watermark
      // would erase the very difference divergence is reported from.
      watermark: authoritative ? obs.watermark : prior.source?.watermark,
      state: 'present',
      ...(!authoritative && evidenceMoved ? { divergedWatermark: obs.watermark } : {}),
    }

    const next: Surface = {
      ...prior,
      ...(authoritative ? { content: obs.content, author: obs.author } : {}),
      source: binding,
      ...(authoritative && evidenceMoved
        ? {
          freshness: {
            ...prior.freshness,
            phase: 'current',
            observedGeneration: binding.generation,
            verifiedAt: now,
          },
        }
        : {}),
      rev: prior.rev + 1,
      amendedAt: now,
    }
    // `commitContent` reports a candidate that changes nothing as a `no-change`
    // conflict. That is the RIGHT answer for an API caller and the WRONG one here:
    // the poll floor re-observes every binding every few seconds, and the steady
    // state is precisely "nothing moved". Short-circuited to a success so the
    // reconciler's own counters stay meaningful.
    if (this.docStore.checkSurfaceUpsert(next) === 'no-change') {
      return this.unchanged('observe-source', prior)
    }
    return this.commitContent('observe-source', prior, next, ctx)
  }

  /**
   * Record that an epoch which COULD see this binding's source did not find it.
   *
   * Content is retained verbatim — the last-valid body stays on screen — and the
   * Surface is marked `possibly-stale`, which is the honest state: what it shows was
   * true when the source was last read, and nothing has confirmed it since. It does
   * NOT retract the record. Under KTD15 a Surface only leaves the tree through the
   * deletion service, and letting a missing file delete one would mean an editor
   * crash, a `git checkout`, or a stray `rm` silently destroying a thread.
   *
   * `adapter` is required and checked: a reconciler may only report on bindings it
   * owns, so the file reconciler cannot mark a `legacy-slate-point` binding — whose
   * locator names no file — missing for want of a file.
   */
  async markSourceMissing(
    id: string, adapter: string, ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'marking its source missing')
    if (guard) return guard
    if (!prior.source) return invalid(`Surface ${id} has no source binding to mark missing`)
    if (prior.source.adapter !== adapter) {
      return invalid(
        `Surface ${id} is bound to source adapter "${prior.source.adapter}", not "${adapter}"; ` +
        'a reconciler may only report on the bindings it owns',
      )
    }
    if (prior.source.state === 'missing') return this.unchanged('mark-source-missing', prior)

    const now = ctx.at ?? Date.now()
    const next: Surface = {
      ...prior,
      source: { ...prior.source, state: 'missing', missingSince: now },
      freshness: { ...prior.freshness, phase: 'possibly-stale' },
      rev: prior.rev + 1,
      amendedAt: now,
    }
    return this.commitContent('mark-source-missing', prior, next, ctx)
  }

  /**
   * Make sure a run's compatibility ROOT exists, so its reconciled entries have a
   * home (KTD3).
   *
   * Migration creates one per run at boot. A run created AFTER boot has none, and
   * without this its authored files would have nowhere to land until the next
   * restart — the reconciler would either quarantine the whole run for hours or home
   * its entries on the Canvas, which is exactly the "dump every legacy point onto
   * the canvas" outcome the compatibility root exists to prevent.
   *
   * Idempotent and write-free when the root is already there, including when it has
   * since been PROMOTED or rehomed: the check is on the id, not on the home.
   */
  async ensureRunRoot(
    input: { id: string; spaceId: string; runId: string; createdAt: number },
    ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const existing = this.docStore.getSurface(input.id)
    if (existing) return this.unchanged('create', existing)
    const now = ctx.at ?? Date.now()
    const plan = this.docStore.planSurfaceCreate({
      id: input.id,
      spaceId: input.spaceId,
      home: { kind: 'canvas', spaceId: input.spaceId },
      // The run's own id, matching what migration builds. A decorated label would
      // be the first thing to go stale when a run is renamed.
      content: { headline: input.runId },
      contentAuthority: 'canonical-direct',
      author: 'agent',
      provenance: { runId: input.runId },
      aliases: [{ bucket: { kind: 'run', runId: input.runId }, localId: LEGACY_RUN_ROOT_LOCAL_ID, visible: false }],
      compatibilityOnly: true,
      createdAt: input.createdAt,
    }, { at: now })
    return this.commitPlan('create', plan, ctx, [input.id])
  }

  /**
   * Mint a USER-authored Surface at a run's compatibility alias (KTD3).
   *
   * Separate from {@link create} because two host-derived things differ and neither
   * may come from a request body: the Surface id (derived from the run incarnation
   * and the local id, so it converges with whatever the boot migration would derive
   * for the same point) and the alias's `localId` (the legacy point id, which
   * `create` has no way to express — it aliases a Surface under its own id).
   *
   * Authority is `canonical-direct` and there is no source binding: this record IS
   * the content, which is what makes it immune to a later file epoch claiming the
   * same local id (that reports divergence instead — KTD4).
   */
  async createRunPoint(
    input: {
      id: string
      spaceId: string
      home: SurfaceHome
      runId: string
      localId: string
      content: SurfaceContent
      createdAt?: number
    },
    ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const now = ctx.at ?? Date.now()
    const plan = this.docStore.planSurfaceCreate({
      id: input.id,
      spaceId: input.spaceId,
      home: input.home,
      content: input.content,
      contentAuthority: 'canonical-direct',
      author: authorFor(ctx.actor),
      provenance: { runId: input.runId },
      aliases: [{ bucket: { kind: 'run', runId: input.runId }, localId: input.localId, visible: true }],
      ...(input.createdAt != null ? { createdAt: input.createdAt } : {}),
    }, { at: now })
    return this.commitPlan('create', plan, ctx, [input.id, ...homeIds(input.home)])
  }

  /** A successful no-op, shaped exactly like a mutation so a caller need not branch.
   *  `replayed` is deliberately NOT set: nothing was replayed, and nothing was
   *  written either — the revisions it reports are simply the current ones. */
  private unchanged(op: SurfaceOperation, current: Surface): SurfaceResult<SurfaceMutation> {
    const rev = this.docStore.getSurfaceTopologyRev(current.spaceId)
    return {
      ok: true,
      data: {
        op,
        spaceId: current.spaceId,
        baseTopologyRev: rev,
        topologyRev: rev,
        spaceTopologyRev: rev,
        surfaces: [this.view(current)],
        replayed: false,
      },
    }
  }

  /** Append one message to a Surface's thread. Persist-first: the message is
   *  durable before anything is dispatched anywhere, which is what makes delivery
   *  best-effort rather than lossy (Canonical Field Authority: "Thread and
   *  discussion status … Persist first, then dispatch best-effort"). */
  async appendThread(id: string, body: unknown, ctx: SurfaceCallContext): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('append-thread', id, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body)
    if (!raw) return invalid('body must be a JSON object')
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on append-thread`)
    if (typeof raw.text !== 'string' || !raw.text.trim()) return invalid('text must be a non-empty string')
    const tooLong = oversize('text', raw.text, TEXT_MAX)
    if (tooLong) return invalid(tooLong)
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'append-thread')
    if (guard) return guard
    if (raw.expectedRev !== undefined) {
      if (typeof raw.expectedRev !== 'number') return invalid('expectedRev must be a number')
      if (raw.expectedRev !== prior.rev) return this.conflictOn([prior], 'stale-surface-revision')
    }

    const now = ctx.at ?? Date.now()
    // Derived from the actor, ALWAYS. A human actor posting through the browser is
    // a `user` reply; a managed session is an `agent` one. It used to be
    // overridable from the body, which meant an agent could post a thread message
    // that renders as something the human said — and a reply is exactly where that
    // matters, because the thread is the record of a conversation.
    const author: Reply['author'] = authorFor(ctx.actor)
    const reply: Reply = {
      id: `${id}-r${prior.thread.replies.length + 1}-${now.toString(36)}`,
      author,
      text: raw.text.trim(),
      createdAt: now,
    }
    const thread = {
      ...prior.thread,
      replies: [...prior.thread.replies, reply],
    }
    const next: Surface = {
      ...prior,
      thread: { ...thread, status: derivePointStatus(thread) },
      rev: prior.rev + 1,
      amendedAt: now,
    }
    return this.commitContent('append-thread', prior, next, ctx, flight.fingerprint)
  }

  /**
   * Resolve, reopen, or dismiss a Surface's discussion.
   *
   * The EXPLICIT half of thread status. `open`/`discussing`/`waiting` are derived
   * from the replies; `resolved` and `dismissed` are decisions someone made, which
   * is why they are stamps on the record rather than a function of the messages —
   * and why a later source re-observation cannot undo one. The Slate never
   * auto-resolves a point, and this operation is the only thing that resolves one.
   *
   * `reopen` clears both stamps and lets the derivation take over again.
   */
  async setThreadDisposition(
    id: string, body: unknown, ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('set-thread-disposition', id, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body)
    if (!raw) return invalid('body must be a JSON object')
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on set-thread-disposition`)
    const action = raw.action
    if (action !== 'resolve' && action !== 'reopen' && action !== 'dismiss') {
      return invalid("action must be 'resolve', 'reopen', or 'dismiss'")
    }
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'setting its thread disposition')
    if (guard) return guard
    if (raw.expectedRev !== undefined) {
      if (typeof raw.expectedRev !== 'number') return invalid('expectedRev must be a number')
      if (raw.expectedRev !== prior.rev) return this.conflictOn([prior], 'stale-surface-revision')
    }

    const now = ctx.at ?? Date.now()
    // Rebuilt rather than spread-with-undefined: an `undefined` property survives in
    // memory and disappears across JSON, so a reopened record and its reload would
    // not be the same object.
    const thread = {
      replies: prior.thread.replies,
      ...(action === 'resolve' ? { resolvedAt: now } : {}),
      ...(action === 'dismiss' ? { dismissedAt: now } : {}),
    }
    const next: Surface = {
      ...prior,
      thread: { ...thread, status: derivePointStatus(thread) },
      rev: prior.rev + 1,
      amendedAt: now,
    }
    return this.commitContent('set-thread-disposition', prior, next, ctx, flight.fingerprint)
  }

  /**
   * Ask for this Surface to be rebuilt.
   *
   * U3 owns the REQUEST; U6 owns the durable job that services it. So this moves
   * freshness to `queued` and stops — it does not launch anything, and it is
   * careful not to claim more than that. A Surface already `refreshing` is left
   * alone rather than re-queued: the state machine has no refreshing→queued edge
   * for a human request, and pretending otherwise would let a request cancel work
   * that is in flight.
   */
  async refreshRequest(id: string, body: unknown, ctx: SurfaceCallContext): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('refresh-request', id, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body) ?? {}
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on refresh-request`)
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'refresh-request')
    if (guard) return guard
    if (raw.expectedRev !== undefined) {
      if (typeof raw.expectedRev !== 'number') return invalid('expectedRev must be a number')
      if (raw.expectedRev !== prior.rev) return this.conflictOn([prior], 'stale-surface-revision')
    }
    if (prior.freshness.phase === 'refreshing' || prior.freshness.phase === 'queued') {
      return {
        ok: false,
        error: {
          code: 'conflict',
          reason: prior.freshness.phase === 'queued' ? 'already-queued' : 'already-refreshing',
          message: `Surface ${id} is already ${prior.freshness.phase}; one refresh runs per Surface`,
          current: [prior],
        },
      }
    }
    const next: Surface = {
      ...prior,
      // `overdue` is deliberately carried through, not cleared. It is orthogonal
      // to the phase and only a successful verification may clear it — otherwise a
      // retry loop would make an overdue Surface look attended to (R18).
      freshness: { ...prior.freshness, phase: 'queued' },
      rev: prior.rev + 1,
      amendedAt: ctx.at ?? Date.now(),
    }
    return this.commitContent('refresh-request', prior, next, ctx, flight.fingerprint)
  }

  // --- Freshness lifecycle (plan U6, KTD10) ----------------------------------
  //
  // These four are the durable half of the refresh engine. Like the source-ingress
  // trio above they are TYPED rather than `unknown`-and-whitelisted, because the
  // caller is the host's own coordinator and not a request body — and like them,
  // what they refuse to do is the point: none of them touches home, thread,
  // lifecycle, owner, or aliases.
  //
  // THE GENERATION IS THE CLOCK. `source.generation` counts host observations;
  // `freshness.observedGeneration` records which one the CURRENT content reflects.
  // Stale is `observedGeneration < source.generation` and nothing else — never a
  // wall-clock age, never a comparison of content hashes or Git SHAs.

  /**
   * Record that a typed trigger says this Surface may no longer reflect its
   * sources, and advance the host observation generation.
   *
   * IDEMPOTENT ON THE REASON KEY, PER TRIGGER KIND. An event whose key matches the
   * last one recorded for ITS OWN KIND commits NOTHING — no revision, no
   * generation, no SSE. That is what makes the poll floor free: it re-reports the
   * same Git SHA every few seconds, and every repeat collapses onto the one it
   * already recorded.
   *
   * PER KIND, and that is the whole correctness of it. This used to compare against
   * `staleReason.key` — a single slot holding whichever trigger fired last. With the
   * host defaults (`git-revision` + `periodic`) BOTH are live, so each overwrote the
   * other's key and then read the other's back as new. On a completely IDLE repo
   * that ping-ponged forever: a revision and a generation burned every few seconds,
   * every in-flight refresh superseded by the churn its own supersession caused, so
   * `verifiedAt` never advanced, so `overdue` never cleared, and each cycle launched
   * a real background agent in the user's worktree. Measured at twelve whole-sidecar
   * rewrites a minute with `HEAD` never moving.
   *
   * A Surface already `queued` or `refreshing` KEEPS that phase. Demoting it to
   * `possibly-stale` would lose the fact that work is in flight; the generation
   * advance is what supersedes that work, and the barrier is where that is
   * noticed.
   */
  async markPossiblyStale(
    id: string, reason: Omit<SurfaceStaleReason, 'generation'>, ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'marking it possibly stale')
    if (guard) return guard
    if (prior.freshness.lastReasonKeys?.[reason.kind] === reason.key) {
      return this.unchanged('mark-possibly-stale', prior)
    }

    const now = ctx.at ?? Date.now()
    const generation = (prior.source?.generation ?? 0) + 1
    const next: Surface = {
      ...prior,
      ...(prior.source ? { source: { ...prior.source, generation } } : {}),
      freshness: {
        ...prior.freshness,
        phase: prior.freshness.phase === 'queued' || prior.freshness.phase === 'refreshing'
          ? prior.freshness.phase
          : 'possibly-stale',
        staleReason: { ...reason, generation },
        lastReasonKeys: { ...prior.freshness.lastReasonKeys, [reason.kind]: reason.key },
      },
      rev: prior.rev + 1,
      amendedAt: now,
    }
    return this.commitContent('mark-possibly-stale', prior, next, ctx)
  }

  /**
   * Take a Surface into `queued` and stamp the job that now owns it.
   *
   * `queued` MEANS "a durable job exists for this and has not launched yet" — it is
   * what the concurrency cap is visible as. A Surface held back by the cap sits
   * here, badged, for as long as the fleet is full, which is the honest answer to
   * "why has nothing happened": the work is real and its turn has not come.
   *
   * Idempotent: a Surface already `queued` under the same job is unchanged, so the
   * human path (which reaches `queued` through `refreshRequest` before the
   * coordinator has minted a job) can adopt it without a second commit.
   */
  async enqueueRefresh(
    id: string, input: { jobId: string }, ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'queueing its refresh')
    if (guard) return guard
    if (prior.freshness.phase === 'refreshing') {
      return {
        ok: false,
        error: {
          code: 'conflict',
          reason: 'already-refreshing',
          message: `Surface ${id} is already refreshing; one refresh runs per Surface`,
          current: [prior],
        },
      }
    }
    if (prior.freshness.phase === 'queued' && prior.freshness.jobId === input.jobId) {
      return this.unchanged('enqueue-refresh', prior)
    }
    const next: Surface = {
      ...prior,
      // `overdue`, `staleReason`, and `failure` all carry through: queueing is not
      // an outcome, and clearing any of them here would make an unattended Surface
      // look attended to (R18).
      freshness: { ...prior.freshness, phase: 'queued', jobId: input.jobId },
      rev: prior.rev + 1,
      amendedAt: ctx.at ?? Date.now(),
    }
    return this.commitContent('enqueue-refresh', prior, next, ctx)
  }

  /**
   * Move a Surface from `queued` to `refreshing` and stamp the owning job.
   *
   * `expectedRev` is a compare-and-swap and is REQUIRED: two coordinator sweeps,
   * or a sweep racing a human request, must not both believe they own the same
   * Surface. That is the "two workers cannot complete the same lease" invariant,
   * enforced on the record rather than on the job table.
   */
  async beginRefresh(
    id: string, input: { jobId: string; expectedRev: number }, ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'starting its refresh')
    if (guard) return guard
    if (input.expectedRev !== prior.rev) return this.conflictOn([prior], 'stale-surface-revision')
    if (prior.freshness.phase !== 'queued') {
      return {
        ok: false,
        error: {
          code: 'conflict',
          reason: prior.freshness.phase === 'refreshing' ? 'already-refreshing' : 'stale-surface-revision',
          message: `Surface ${id} is ${prior.freshness.phase}, not queued; only a queued Surface may start refreshing`,
          current: [prior],
        },
      }
    }
    const next: Surface = {
      ...prior,
      freshness: { ...prior.freshness, phase: 'refreshing', jobId: input.jobId },
      rev: prior.rev + 1,
      amendedAt: ctx.at ?? Date.now(),
    }
    return this.commitContent('begin-refresh', prior, next, ctx)
  }

  /**
   * The observation barrier (KTD10). Commit a refresh result, or refuse it as
   * superseded.
   *
   * `observedGeneration` is the generation the RESULT reflects — what the host had
   * observed when the worker was dispatched. If the binding has moved past it, a
   * newer observation arrived while the worker ran and this result describes a
   * world that no longer exists: the Surface goes back to `possibly-stale` with its
   * reason intact so one successor can consume the newest generation, and NOTHING
   * about the stale result is written. That is the difference between "we finished"
   * and "we are current", and conflating them is the failure this whole unit exists
   * to prevent.
   *
   * When content is supplied and authority is the source binding, the write is
   * carried into the SOURCE first and only the watermark the adapter returns is
   * persisted — otherwise the next reconciliation epoch would revert the refresh
   * and nobody would know why (the same rule `updateContent` obeys).
   */
  async completeRefresh(
    id: string,
    input: {
      jobId: string
      expectedRev: number
      /** The generation this result was computed against. */
      observedGeneration: number
      /** {@link surfaceContentDigest} of the content this result was computed to
       *  REPLACE, snapshotted at `beginRefresh`. A mismatch means somebody rewrote
       *  the content while the worker ran, and the result is superseded rather
       *  than allowed to overwrite them. Optional so a caller that genuinely holds
       *  no baseline (a recovery-path completion) is not forced to invent one. */
      expectedContentDigest?: string
      /** Validated authored content, or absent for a verification that found
       *  nothing to change (a byte-identical regeneration). */
      content?: SurfaceContent
    },
    ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'completing its refresh')
    if (guard) return guard
    if (prior.freshness.phase !== 'refreshing') {
      // THE SURFACE LEFT THE REFRESH THIS RESULT BELONGS TO. That is a
      // SUPERSESSION, not a stale revision, and the distinction is the difference
      // between one successor and a Surface committed as `failed` for no reason.
      //
      // The ordinary way it happens: `observeSource` sets `phase: 'current'`
      // whenever its binding is authoritative and the watermark moved — including
      // mid-refresh — so an ordinary agent write during a refresh takes the Surface
      // out of `refreshing`. Harvest then arrived here, got `stale-surface-revision`,
      // and the coordinator's supersession branch did not match it, so it fell
      // through to `failJob`. Net: a Surface the watcher had just made current was
      // committed as `failed`, no successor was scheduled, and the badge read "The
      // last refresh failed: mutation refused: stale-surface-revision". Both the
      // state and the message were wrong.
      //
      // NOTHING IS WRITTEN HERE, deliberately — unlike the generation branch below,
      // which owns the Surface and puts it back to `possibly-stale`. This job does
      // not own it any more: whatever moved it (a watcher observation, a failure, a
      // newer job) is a more recent and better-informed statement than a result
      // computed before any of that.
      return {
        ok: false,
        error: {
          code: 'conflict',
          reason: 'superseded',
          message:
            `Surface ${id} is ${prior.freshness.phase}, not refreshing — it left the refresh this result ` +
            'belongs to, so the result cannot claim current',
          current: [prior],
        },
      }
    }
    if (input.expectedRev !== prior.rev) return this.conflictOn([prior], 'stale-surface-revision')

    const now = ctx.at ?? Date.now()
    const hostGeneration = prior.source?.generation ?? 0
    const supersede = async (message: string): Promise<SurfaceResult<SurfaceMutation>> => {
      // Back to possibly-stale, reason and overdue retained, job cleared so exactly
      // one successor is scheduled for whatever moved past this result.
      const superseded: Surface = {
        ...prior,
        freshness: { ...omitJob(prior.freshness), phase: 'possibly-stale' },
        rev: prior.rev + 1,
        amendedAt: now,
      }
      const committed = await this.commitContent('complete-refresh', prior, superseded, ctx)
      if (!committed.ok) return committed
      return {
        ok: false,
        error: { code: 'conflict', reason: 'superseded', message, current: this.currentFor([id]) },
      }
    }

    if (input.observedGeneration !== hostGeneration) {
      return supersede(
        `Surface ${id} moved to observation generation ${hostGeneration} while this refresh was running ` +
        `(it was computed against ${input.observedGeneration}); the result cannot claim current`,
      )
    }

    // THE CONTENT COMPARE-AND-SWAP. The generation catches SOURCE movement and
    // nothing else, and the two things that write authored content mid-refresh do
    // not move it: `updateContent` — the path an agent's Slate write and a user's
    // edit both take — bumps `rev` but writes the adapter's new watermark straight
    // onto the binding, so `observeSource` sees no evidence move and there is
    // nothing for the generation to notice.
    //
    // What that cost, executed against this branch: a run's agent posted a point
    // update while a refresh of that point was running; the barrier's revision check
    // could not fire (see `surfaceContentDigest`); and `content = input.content`
    // replaced the agent's headline and body. Phase committed `current`. No
    // conflict, no trace, and the Surface asserting it had been verified. A user
    // edit reading "DO NOT TOUCH, I am mid-triage" was destroyed the same way.
    //
    // Compared against the digest snapshotted at `beginRefresh` rather than against
    // `job.baseRev`, because the coordinator's own `setSchedule`/`markPossiblyStale`/
    // `beginRefresh` commits all bump `rev` inside the refresh window — a revision
    // comparison would refuse every result the engine ever produced.
    if (
      input.expectedContentDigest !== undefined
      && surfaceContentDigest(prior.content) !== input.expectedContentDigest
    ) {
      return supersede(
        `Surface ${id}'s content was rewritten while this refresh was running; the result would have ` +
        'overwritten that edit, so it cannot claim current',
      )
    }

    let source = prior.source
    let content = prior.content
    if (input.content) {
      // A refresh result replaces authored OUTPUT. The recipe, the freshness
      // declaration, and the claims are authored INPUT — a worker restates none, and
      // `parseStagedResult` cannot even express them (it emits `headline` or
      // `headline` + `body`, nothing else). Assigning `input.content` wholesale
      // therefore DELETED both on the first successful refresh: from the record,
      // and — because canonical Slate Surfaces are `source-binding` — from the
      // author's own `.tinstar/slate/*.json`, since the adapter treats an absent
      // recipe as an instruction to drop it. The Surface was then unrefreshable
      // forever, having destroyed the thing that made it refreshable. Carried
      // here for the same reason `updateContent` carries them two hundred lines
      // above, where the identical hazard is already documented.
      content = {
        ...input.content,
        ...(input.content.recipe ?? prior.content.recipe
          ? { recipe: input.content.recipe ?? prior.content.recipe }
          : {}),
        ...(prior.content.refreshPolicy ? { refreshPolicy: prior.content.refreshPolicy } : {}),
        // The same hazard for the same reason (U1): a rebuild that dropped the
        // claims would leave a Surface that had just been rebuilt with nothing left
        // saying what would prove it wrong — and would delete them from the author's
        // file on the write-back below. `!== undefined` so `[]` survives too.
        ...(prior.content.claims !== undefined ? { claims: prior.content.claims } : {}),
      }
      if (prior.contentAuthority === 'source-binding') {
        const adapter = prior.source ? this.adapters[prior.source.adapter] : undefined
        if (!prior.source || !adapter) {
          return {
            ok: false,
            error: {
              code: 'conflict',
              reason: 'content-authority',
              message:
                `content authority is the source binding "${prior.source?.adapter ?? 'unknown'}" and no adapter is ` +
                'registered to carry a refresh result back to it',
              current: [prior],
            },
          }
        }
        // THE WATERMARK IS PASSED, so the adapter's own guard actually runs. It was
        // omitted here, which made `SlateFileAdapter` skip the check whose comment
        // says it "is what makes a lost update visible rather than silent" — so a
        // refresh result overwrote a file entry an author had edited since the host
        // last read it, and nothing anywhere said so. `prior.source.watermark` is
        // the host's most recent observation of that entry, which is exactly the
        // baseline the CAS wants.
        const written = await adapter.write({
          surface: prior,
          content,
          ...(prior.source.watermark !== undefined ? { expectedWatermark: prior.source.watermark } : {}),
        })
        if (!written.ok) {
          // A STALE refusal means the entry moved under us, which is the same claim
          // the generation and the content digest make: this result describes a world
          // that no longer exists. Superseded, so ONE successor is scheduled against
          // what the file says now. Anything else — an unreadable file, a locator
          // that resolves nowhere, a read-only filesystem — is a genuine failure and
          // must stay one: mapping it to supersession would spawn a worker per sweep
          // forever against a write that can never land.
          if (written.stale) {
            return supersede(
              `Surface ${id}'s source entry changed while this refresh was running (${written.message}); ` +
              'the result cannot claim current',
            )
          }
          return { ok: false, error: { code: 'conflict', reason: 'source-write-failed', message: written.message, current: [prior] } }
        }
        source = { ...prior.source, watermark: written.watermark }
      }
    }

    const next: Surface = {
      ...prior,
      content,
      ...(source ? { source } : {}),
      freshness: {
        // Rebuilt rather than spread: `staleReason`, `failure`, and `jobId` are all
        // ANSWERED by a successful barrier, and a spread would carry them forward
        // as decoration on a Surface that is genuinely current.
        phase: 'current',
        overdue: false,
        ...(prior.freshness.dueAt !== undefined ? { dueAt: prior.freshness.dueAt } : {}),
        // `lastReasonKeys` is the ONE thing here a success does not answer, and it
        // has to survive: it records which observations have already been counted,
        // and this refresh was computed against exactly those. Dropping it let the
        // very next poll of the unchanged Git SHA re-stale a Surface that had just
        // been verified against that SHA — a fresh background agent every fifteen
        // seconds on a repo where nothing happened.
        ...(prior.freshness.lastReasonKeys
          ? { lastReasonKeys: prior.freshness.lastReasonKeys }
          : {}),
        observedGeneration: hostGeneration,
        verifiedAt: now,
      },
      rev: prior.rev + 1,
      amendedAt: now,
    }
    return this.commitContent('complete-refresh', prior, next, ctx)
  }

  /**
   * Record that a refresh could not produce a verified result.
   *
   * The Surface goes to `failed` and KEEPS its stale reason: the trigger that made
   * it stale is still true, and clearing it would leave a failed Surface with no
   * account of what it was trying to catch up to. `overdue` is likewise untouched —
   * only a successful verification may clear it (R18).
   */
  async failRefresh(
    id: string, input: { jobId: string; message: string }, ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'failing its refresh')
    if (guard) return guard
    const now = ctx.at ?? Date.now()
    const next: Surface = {
      ...prior,
      freshness: {
        ...omitJob(prior.freshness),
        phase: 'failed',
        failure: { message: input.message.slice(0, 400), at: now },
      },
      rev: prior.rev + 1,
      amendedAt: now,
    }
    if (this.docStore.checkSurfaceUpsert(next) === 'no-change') return this.unchanged('fail-refresh', prior)
    return this.commitContent('fail-refresh', prior, next, ctx)
  }

  /**
   * Set the verification deadline and the derived `overdue` flag.
   *
   * Separate from the phase transitions because it is ORTHOGONAL to them (R18): a
   * queued or refreshing Surface stays overdue until a verification actually
   * succeeds, so a retry loop cannot make it look attended to. Writes nothing when
   * neither value moved — this runs on every sweep, for every Surface.
   */
  async setSchedule(
    id: string, input: { dueAt?: number; overdue: boolean }, ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'setting its refresh schedule')
    if (guard) return guard
    if (prior.freshness.dueAt === input.dueAt && prior.freshness.overdue === input.overdue) {
      return this.unchanged('set-refresh-schedule', prior)
    }
    const freshness = { ...prior.freshness, overdue: input.overdue }
    if (input.dueAt === undefined) delete freshness.dueAt
    else freshness.dueAt = input.dueAt
    const next: Surface = {
      ...prior,
      freshness,
      rev: prior.rev + 1,
      amendedAt: ctx.at ?? Date.now(),
    }
    return this.commitContent('set-refresh-schedule', prior, next, ctx)
  }

  /**
   * Record what a witness saw, and stamp the Surface witnessed when every claim
   * held (R9/R10/R11/R19, plan U3).
   *
   * THE CHEAP HALF OF THE SPLIT. Detection is generous and costs nothing; repair is
   * expensive and rare. A revalidation in which every claim returns its stored value
   * ends HERE — no job, no agent session, no worker — and the only thing it writes is
   * the fact that the host looked and was not contradicted.
   *
   * THE BARRIER IS DELIBERATELY NARROWER THAN `completeRefresh`'s, in three places
   * that each cost something real if widened:
   *
   *   · `jobId` IS NOT CLEARED. Clearing it orphans a queued rebuild, and `dispatch`
   *     then cancels that job with "another refresh (none) took this Surface over" —
   *     so a deadline pass would silently swallow a human pressing ⟳.
   *   · A FOREIGN `staleReason` SURVIVES. Only a reason whose kind some claim's locus
   *     observes is answered by this pass; a `human-intent` or `semantic-signal`
   *     reason is not something a claim witness can speak to, and clearing it would
   *     make an unattended Surface look attended to.
   *   · A `queued`, `refreshing`, or `failed` phase IS KEPT. Work in flight is not
   *     answered by a claim check, and a failed rebuild is a fact about the rebuild.
   *     Only `possibly-stale` — the state a trigger or a deadline put it in — is
   *     resolved back to `current`.
   *
   * `lastReasonKeys` is carried forward verbatim, for exactly the reason its own
   * docstring records: without it the next unchanged poll of the same Git SHA
   * re-stales the Surface that was just witnessed against that SHA, and the measured
   * result was a fresh background agent every fifteen seconds on an idle repo.
   *
   * `verifiedAt` IS NOT TOUCHED (KTD7). It means "content last arrived or was
   * rebuilt", which a claim check does not do.
   *
   * WRITES NOTHING WHEN NOTHING MOVED, which is the property that makes this safe to
   * call on a sweep. See {@link SurfaceClaimObservation} for why whole-record
   * equality is a sufficient comparator here: no field this operation writes records
   * a mere LOOK, so "the record is byte-identical" and "the world did not move" are
   * the same statement.
   */
  async recordWitnessResult(
    id: string, input: { observations: readonly WitnessObservationInput[] }, ctx: SurfaceCallContext,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    const prior = this.docStore.getSurface(id)
    if (!prior) return notFound(id)
    const guard = this.guardLive(prior, 'recording a witness result')
    if (guard) return guard

    // A Surface that declares nothing may not be stamped witnessed by anybody. This
    // is the record-level half of the `unwitnessed` contract (R18): the state has to
    // be UNREACHABLE rather than merely unwritten, or one stray call would make a
    // claimless Surface assert a verification that never happened.
    const declared = prior.content.claims
    if (!declared?.length) {
      return invalid(`Surface ${id} declares no claims, so there is nothing a witness could have checked`)
    }

    const now = ctx.at ?? Date.now()
    const stored = prior.freshness.claimObservations
    const observations: Record<string, SurfaceClaimObservation> = {}
    let observedEvery = true
    let matchedEvery = true

    // Driven by the DECLARATION, not by the input. That is the "still holds the same
    // claims" re-check the collect/run/commit split needs (KTD3): the author may have
    // edited the file while the witnesses were running, and a result for a claim that
    // no longer exists must neither be stored nor counted. It is also what prunes a
    // deleted claim's observation instead of leaving a ghost value nothing renders.
    // Sorted so the stored key order is a function of the ids alone — a reordered
    // declaration must not read as moved observation state.
    for (const claim of [...declared].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const was = stored?.[claim.id]
      const seen = input.observations.find(o => o.claimId === claim.id)
      if (!seen) {
        observedEvery = false
        if (was) observations[claim.id] = was
        continue
      }
      // `witnessMatches` is U2's and is the SINGLE place a three-valued outcome
      // becomes a yes or a no. Re-deriving it here is how `unresolved` would quietly
      // start counting as a match against a stored absence (KTD8).
      if (!witnessMatches(was?.value, seen.outcome)) matchedEvery = false
      observations[claim.id] = observationFrom(was, seen.outcome, now)
    }

    const freshness: SurfaceFreshness = { ...prior.freshness }
    if (Object.keys(observations).length) freshness.claimObservations = observations
    else delete freshness.claimObservations

    // R10 in full: EVERY declared claim observed in THIS run, and every one matched.
    // A partial run — one trigger's locus, say — records what it saw and stamps
    // nothing, because a Surface cannot be verified against claims nobody checked.
    if (observedEvery && matchedEvery) {
      freshness.witnessedAt = now
      // A successful verification is the one thing allowed to clear the overdue
      // badge (R18), and this is one.
      freshness.overdue = false
      if (freshness.staleReason && claimsObserveTriggerKind(declared, freshness.staleReason.kind)) {
        delete freshness.staleReason
      }
      // ONLY once the reason is actually gone. A Surface holding a `human-intent`
      // reason this pass could not answer is still possibly-stale, and committing it
      // `current` with the reason still attached would put two contradictory
      // statements on one record — which is exactly how a badge starts disagreeing
      // with the sentence under it.
      if (freshness.phase === 'possibly-stale' && !freshness.staleReason) freshness.phase = 'current'
    }

    const next: Surface = { ...prior, freshness, rev: prior.rev + 1, amendedAt: now }
    if (this.docStore.checkSurfaceUpsert(next) === 'no-change') {
      return this.unchanged('record-witness-result', prior)
    }
    return this.commitContent('record-witness-result', prior, next, ctx)
  }

  // --- Topology ---

  async group(body: unknown, ctx: SurfaceCallContext): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('group', undefined, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body)
    if (!raw) return invalid('body must be a JSON object')
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on group`)
    const childIds = parseIdList(raw.childIds, 'childIds')
    if (typeof childIds === 'string') return invalid(childIds)
    if (childIds.length === 0) return invalid('childIds must name at least one Surface')
    const content = parseContent(raw.content, true)
    if (typeof content === 'string') return invalid(content)
    if (!content) return invalid('content is required — the new parent needs a headline')
    const owner = parsePrincipal(raw.owner, 'owner')
    if (typeof owner === 'string') return invalid(owner)
    const opts = this.topologyOpts(raw, ctx)
    if (typeof opts === 'string') return invalid(opts)

    const parentId = this.mintId()
    const plan = this.docStore.planSurfaceGroup(childIds, {
      id: parentId,
      content,
      ...(owner ? { owner } : {}),
      author: authorFor(ctx.actor),
    }, opts)
    return this.commitPlan('group', plan, ctx, [parentId, ...childIds], flight.fingerprint)
  }

  async reparent(body: unknown, ctx: SurfaceCallContext): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('reparent', undefined, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body)
    if (!raw) return invalid('body must be a JSON object')
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on reparent`)
    const ids = parseIdList(raw.ids, 'ids')
    if (typeof ids === 'string') return invalid(ids)
    if (ids.length === 0) return invalid('ids must name at least one Surface')
    const home = parseHome(raw.home)
    if (typeof home === 'string') return invalid(home)
    const opts = this.topologyOpts(raw, ctx)
    if (typeof opts === 'string') return invalid(opts)
    const plan = this.docStore.planSurfaceReparent(ids, home, opts)
    return this.commitPlan('reparent', plan, ctx, [...ids, ...homeIds(home)], flight.fingerprint)
  }

  /**
   * Dissolve a group: its immediate children go back to its own home, and the now
   * empty parent goes to the recovery store.
   *
   * That IS `delete` with the `reparent-children` disposition, and reusing it is
   * deliberate rather than lazy — ungroup is the exact inverse of group, so it
   * must be one transaction with the same cycle, revision, and descendant checks.
   * Moving children out while KEEPING the box is a different intent and is spelled
   * `reparent`.
   *
   * A CHILDLESS Surface is refused rather than dissolved. Sharing `delete`'s
   * machinery means an ungroup of a leaf is a perfectly valid delete — it moved the
   * Surface into the recovery store and reported `op: ungroup`, so a caller
   * tidying its tree could take a Surface out of circulation while being told a
   * box had been opened. There is no box; say so.
   */
  async ungroup(id: string, body: unknown, ctx: SurfaceCallContext): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('ungroup', id, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body) ?? {}
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on ungroup`)
    const target = this.docStore.getSurface(id)
    if (!target) return notFound(id)
    const opts = this.topologyOpts(raw, ctx)
    if (typeof opts === 'string') return invalid(opts)
    if (this.docStore.getSurfaceChildren(id).length === 0) {
      return {
        ok: false,
        error: {
          code: 'conflict',
          reason: 'not-a-group',
          message:
            `Surface ${id} holds no children, so there is nothing to dissolve. Ungrouping it would move it into ` +
            'the recovery store — if that is what you meant, call delete.',
          current: [target],
          topologyRev: this.docStore.getSurfaceTopologyRev(target.spaceId),
        },
      }
    }
    // Ungroup means "dissolve THIS box", so the descendant set is read here rather
    // than demanded from the caller: unlike a delete, no descendant is removed —
    // the immediate children move up and everything below them rides along.
    const descendants = this.docStore.getSurfaceDescendants(id).map(s => s.id)
    const plan = this.docStore.planSurfaceDelete(id, {
      ...opts,
      descendants,
      disposition: 'reparent-children',
      by: ctx.actor,
    })
    return this.commitPlan('ungroup', plan, ctx, [id, ...descendants], flight.fingerprint)
  }

  // --- Recoverable deletion (KTD15) ---

  /**
   * Move a Surface into the recovery store.
   *
   * Direct — there is no approval step and no ownership check, because an agent
   * may delete any Surface. What IS required, for a non-empty parent, is the exact
   * descendant set the caller displayed plus a disposition (R6/AE6). That is a
   * compare-and-swap on what the human agreed to: a confirmation dialog built
   * before a child arrived must not take that child with it.
   */
  async delete(id: string, body: unknown, ctx: SurfaceCallContext): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('delete', id, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body) ?? {}
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on delete`)
    if (raw.disposition !== undefined
      && raw.disposition !== 'reparent-children' && raw.disposition !== 'delete-subtree') {
      return invalid("disposition must be 'reparent-children' or 'delete-subtree'")
    }
    let descendants: string[] | undefined
    if (raw.descendants !== undefined) {
      const parsed = parseIdList(raw.descendants, 'descendants')
      if (typeof parsed === 'string') return invalid(parsed)
      descendants = parsed
    }
    const target = this.docStore.getSurface(id)
    if (!target) return notFound(id)

    const topology = this.topologyOpts(raw, ctx)
    if (typeof topology === 'string') return invalid(topology)
    const opts: SurfaceDeleteOpts = {
      ...topology,
      ...(descendants ? { descendants } : {}),
      ...(raw.disposition ? { disposition: raw.disposition as SurfaceDeleteDisposition } : {}),
      by: ctx.actor,
    }
    const plan = this.docStore.planSurfaceDelete(id, opts)
    if (!plan.applied && plan.reason === 'descendant-mismatch') {
      // Worth its own message: the generic conflict text would leave the caller
      // guessing whether it named too many descendants, too few, or forgot the
      // disposition entirely.
      return this.descendantMismatch(
        target,
        'deleting',
        "and a disposition of 'reparent-children' or 'delete-subtree'",
      )
    }
    return this.commitPlan('delete', plan, ctx, [id, ...(descendants ?? [])], flight.fingerprint)
  }

  /** Put a deleted subtree back. A former home that is gone does not fail the
   *  restore — see `SurfaceStore.planRestore`; the Surface lands on the Canvas
   *  with the workspace-recovery alias rather than becoming unreachable. */
  async restore(id: string, body: unknown, ctx: SurfaceCallContext): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('restore', id, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body) ?? {}
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on restore`)
    if (!this.docStore.getSurface(id)) return notFound(id)
    const opts = this.topologyOpts(raw, ctx)
    if (typeof opts === 'string') return invalid(opts)
    const plan = this.docStore.planSurfaceRestore(id, opts)
    return this.commitPlan('restore', plan, ctx, [id], flight.fingerprint)
  }

  /**
   * ERASE a deleted subtree. The one irreversible operation in this service, and it
   * refuses anything not already in the recovery store — purge is always the second
   * step of a decision, never the first.
   *
   * A subtree with descendants requires the EXACT set, exactly as `delete` does.
   * The doomed set is computed from the tree as it is NOW, so without that check a
   * purge could erase records that arrived under the subtree after the human read
   * the recovery list — records nobody deleted, that were never shown as
   * recoverable, and that no undo exists for. The irreversible operation must not
   * be able to exceed the blast radius the caller named.
   */
  async purge(id: string, body: unknown, ctx: SurfaceCallContext): Promise<SurfaceResult<SurfaceMutation>> {
    const flight = this.preflight('purge', id, body, ctx)
    if (flight.done) return flight.done
    const raw = asObject(body) ?? {}
    const forbidden = forbiddenField(raw)
    if (forbidden) return invalid(`${forbidden} is host-owned and may not be supplied on purge`)
    const target = this.docStore.getSurface(id)
    if (!target) return notFound(id)
    let descendants: string[] | undefined
    if (raw.descendants !== undefined) {
      const parsed = parseIdList(raw.descendants, 'descendants')
      if (typeof parsed === 'string') return invalid(parsed)
      descendants = parsed
    }
    const opts = this.topologyOpts(raw, ctx)
    if (typeof opts === 'string') return invalid(opts)
    const plan = this.docStore.planSurfacePurge(id, {
      ...opts,
      ...(descendants ? { descendants } : {}),
    })
    if (!plan.applied && plan.reason === 'descendant-mismatch') {
      return this.descendantMismatch(
        target,
        'purging',
        '— a purge ERASES every one of them, and there is no undo',
      )
    }
    return this.commitPlan('purge', plan, ctx, [id, ...(descendants ?? [])], flight.fingerprint)
  }

  // --- Internals ---

  private view(surface: Surface): SurfaceRecordView {
    const root = this.docStore.surfaceRecoveryRootFor(surface.id)
    return {
      surface,
      capabilities: surfaceCapabilities(surface, {
        deleted: !!root,
        recoveryRoot: root?.id === surface.id,
        sourceAdapterAvailable: !!surface.source && !!this.adapters[surface.source.adapter],
      }),
    }
  }

  /** Every content-path operation refuses a deleted Surface. Editing a record in
   *  the recovery store would make the restored copy differ from what the user
   *  deleted, which quietly defeats the point of the store. */
  private guardLive(surface: Surface, op: string): { ok: false; error: SurfaceServiceError } | undefined {
    if (!this.docStore.surfaceRecoveryRootFor(surface.id)) return undefined
    return {
      ok: false,
      error: {
        code: 'conflict',
        reason: 'deleted',
        message: `Surface ${surface.id} is in the recovery store; restore it before ${op}`,
        current: [surface],
      },
    }
  }

  /**
   * Pull the compare-and-swap inputs a caller may state on any topology body.
   * Returns the refusal message instead of the options when the body is wrong.
   *
   * `expectedRevs` used to be the one field in this file that skipped the
   * whitelisting everything else gets: an is-it-an-object check and then a cast.
   * That let `{"expectedRevs": {"sf-1": "3"}}` through, where the string `"3"`
   * compares unequal to every real revision forever — a compare-and-swap that can
   * never be satisfied, reported as an ordinary stale-revision conflict, so the
   * caller re-reads, retries with the same body, and loops.
   */
  private topologyOpts(raw: Record<string, unknown>, ctx: SurfaceCallContext): SurfaceTopologyOpts | string {
    if (raw.expectedTopologyRev !== undefined) {
      if (typeof raw.expectedTopologyRev !== 'number' || !Number.isFinite(raw.expectedTopologyRev)) {
        return 'expectedTopologyRev must be a finite number'
      }
    }
    let expectedRevs: Record<string, number> | undefined
    if (raw.expectedRevs !== undefined) {
      const parsed = asObject(raw.expectedRevs)
      if (!parsed) return 'expectedRevs must be an object of Surface id -> revision'
      expectedRevs = {}
      for (const [id, rev] of Object.entries(parsed)) {
        if (typeof rev !== 'number' || !Number.isFinite(rev)) {
          return `expectedRevs.${id} must be a finite number`
        }
        expectedRevs[id] = rev
      }
    }
    return {
      ...(typeof raw.expectedTopologyRev === 'number' ? { expectedTopologyRev: raw.expectedTopologyRev } : {}),
      ...(expectedRevs ? { expectedRevs } : {}),
      ...(ctx.at != null ? { at: ctx.at } : {}),
    }
  }

  /** The "you named the wrong descendants" conflict, shared by `delete` and
   *  `purge`. Both are compare-and-swaps on WHAT THE HUMAN WAS SHOWN, so both owe
   *  the caller the set it should have named rather than a bare reason code. */
  private descendantMismatch(
    target: Surface, verb: string, tail: string,
  ): { ok: false; error: SurfaceServiceError } {
    const actual = this.docStore.getSurfaceDescendants(target.id)
    return {
      ok: false,
      error: {
        code: 'conflict',
        reason: 'descendant-mismatch',
        message:
          `${verb} Surface ${target.id} requires the exact descendant set it currently has ` +
          `(${actual.length}: ${actual.map(s => s.id).join(', ') || 'none'}) ${tail}`,
        current: [target, ...actual],
        topologyRev: this.docStore.getSurfaceTopologyRev(target.spaceId),
      },
    }
  }

  private conflictOn(current: Surface[], reason: SurfaceErrorReason): { ok: false; error: SurfaceServiceError } {
    const spaceId = current[0]?.spaceId
    return {
      ok: false,
      error: {
        code: 'conflict',
        reason,
        message: `mutation refused: ${reason}`,
        current,
        ...(spaceId ? { topologyRev: this.docStore.getSurfaceTopologyRev(spaceId) } : {}),
      },
    }
  }

  /**
   * One durable content write, in the KTD7 order. Content writes bump no topology
   * revision, so the batch's base and result are the same number.
   *
   * A candidate that changes NOTHING but `rev` and `amendedAt` never reaches the
   * durable layer. The store's storm guard refuses to install one (correctly — it
   * would wake every SSE subscriber for a frame nobody can see), so committing it
   * anyway advanced the durable revision past the live one and left the record
   * permanently unwritable. Refusing here, before the commit, is the fix; the same
   * predicate is re-asserted inside the transaction queue as defence in depth.
   *
   * Reported as `conflict / no-change` rather than as a success, matching
   * `transferContentAuthority` above and the store's own `no-change` rejection:
   * "reported as not-applied so a caller cannot mistake a no-op for progress". A
   * success carrying an unbumped revision would be worse than a refusal — the
   * caller would record a revision the record never reached.
   */
  private async commitContent(
    op: SurfaceOperation, prior: Surface, next: Surface, ctx: SurfaceCallContext, fingerprint?: string,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    if (this.docStore.checkSurfaceUpsert(next) === 'no-change') {
      return {
        ok: false,
        error: {
          code: 'conflict',
          reason: 'no-change',
          message: `${op} would change nothing on Surface ${next.id}`,
          current: [prior],
          topologyRev: this.docStore.getSurfaceTopologyRev(next.spaceId),
        },
      }
    }
    const rev = this.docStore.getSurfaceTopologyRev(next.spaceId)
    const receipt: SurfaceReceipt = {
      op, spaceId: next.spaceId, baseTopologyRev: rev, topologyRev: rev, revs: { [next.id]: next.rev },
    }
    const commit = await this.docStore.commitSurfaceContent(next, {
      ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      result: receiptJson(receipt),
    })
    return this.fromCommit(op, commit, receipt, [prior])
  }

  /**
   * One durable topology transaction, in the KTD7 order.
   *
   * `targets` is the ids the caller named — the Surfaces it is about to move, the
   * home it is moving them to, the descendants it listed. It exists so that a
   * REFUSED plan can still carry `current`, which the type four lines above states
   * as an invariant ("`conflict` always carries `current`") and which every
   * topology operation used to break: `create`, `group`, `reparent`, `ungroup`,
   * `restore`, `purge` and most of `delete` returned a bare `reason`, so the
   * "re-read and retry with no second round trip" design held only on the content
   * path, and a UI recovering from a topology conflict had to go back for a
   * snapshot it was promised it would not need.
   */
  private async commitPlan(
    op: SurfaceOperation,
    plan: SurfacePlanResult,
    ctx: SurfaceCallContext,
    targets: string[],
    fingerprint?: string,
  ): Promise<SurfaceResult<SurfaceMutation>> {
    if (!plan.applied) {
      return {
        ok: false,
        error: {
          code: plan.reason === 'unknown-surface' || plan.reason === 'unknown-home' ? 'not-found' : 'conflict',
          reason: plan.reason,
          message: rejectionMessage(plan.reason),
          current: this.currentFor(targets),
          topologyRev: plan.topologyRev,
        },
      }
    }
    // Built FROM the plan rather than from THE plan: the durable half re-validates
    // and re-computes before it writes, and the revision it allocates there — not
    // the one planning proposed — is what the space ends up at. A receipt frozen at
    // plan time would report `2 -> 3` for a mutation that produced `3 -> 4`, and
    // `topologyRev` is documented as the revision this operation produced.
    const receiptFor = (effective: SurfaceTopologyPlan): SurfaceReceipt => ({
      op,
      spaceId: effective.spaceId,
      baseTopologyRev: effective.baseTopologyRev,
      topologyRev: effective.topologyRev,
      revs: Object.fromEntries(effective.records.map(r => [r.id, r.rev])),
      ...(effective.purged.length > 0 ? { purged: effective.purged } : {}),
    })
    const proposed = receiptFor(plan.plan)
    const commit = await this.docStore.commitSurfacePlan(plan.plan, {
      ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      result: effective => receiptJson(receiptFor(effective)),
    })
    return this.fromCommit(op, commit, proposed, plan.plan.records)
  }

  /** Authoritative records for a set of named ids, deduplicated and skipping ids
   *  that resolve to nothing. What `current` is on every conflict. */
  private currentFor(ids: string[]): Surface[] {
    const seen = new Set<string>()
    const out: Surface[] = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const surface = this.docStore.getSurface(id)
      if (surface) out.push(surface)
    }
    return out
  }

  /**
   * Turn a sidecar outcome into the caller's answer.
   *
   * The replay branch is where the receipt decision shows up: `commit.result` is
   * the scalar envelope this service persisted, and the records it names are
   * re-read at their CURRENT revision rather than restored from the receipt. See
   * the receipt note above for the measured reason and the cost.
   */
  private fromCommit(
    op: SurfaceOperation,
    commit: SurfaceCommitResult,
    receipt: SurfaceReceipt,
    fallback: Surface[],
  ): SurfaceResult<SurfaceMutation> {
    if (!commit.committed) {
      // A re-validation refusal is reported as though the FIRST pass had refused —
      // same code, same reason vocabulary, same sentence — because from the
      // caller's side that is exactly what happened: the mutation was refused
      // before anything changed, and the world it was refused against is the one
      // `current` now describes. A distinct error shape would mean every client
      // handling `stale-topology-revision` needed a second branch for the identical
      // situation arriving a few milliseconds later.
      if (commit.reason === 'precommit-refused') {
        const reason = commit.detail as SurfaceRejection
        return {
          ok: false,
          error: {
            code: reason === 'unknown-surface' || reason === 'unknown-home' ? 'not-found' : 'conflict',
            reason,
            message: rejectionMessage(reason),
            current: fallback.map(r => this.docStore.getSurface(r.id)).filter((s): s is Surface => !!s),
            topologyRev: this.docStore.getSurfaceTopologyRev(receipt.spaceId),
          },
        }
      }
      const code = commit.reason === 'faulted-read-only' ? 'faulted'
        : commit.reason === 'write-failed' ? 'write-failed'
          : commit.reason === 'unknown-record' ? 'not-found' : 'conflict'
      return {
        ok: false,
        error: {
          code,
          reason: commit.reason,
          message: commit.detail ?? commitMessage(commit.reason),
          current: fallback.map(r => this.docStore.getSurface(r.id)).filter((s): s is Surface => !!s),
          topologyRev: this.docStore.getSurfaceTopologyRev(receipt.spaceId),
        },
      }
    }
    // The committed receipt, not the proposed one, whenever the durable half
    // returned one — on a fresh commit it carries the revision re-validation
    // actually allocated, and on a replay it is the ORIGINAL transaction's. The
    // local `receipt` is only the fallback for the no-receipt paths.
    const applied = isReceipt(commit.result) ? commit.result : receipt
    const ids = Object.keys(applied.revs)
    const surfaces = ids
      .map(id => this.docStore.getSurface(id))
      .filter((s): s is Surface => !!s)
      .map(s => this.view(s))
    return {
      ok: true,
      data: {
        op,
        spaceId: applied.spaceId,
        baseTopologyRev: applied.baseTopologyRev,
        topologyRev: applied.topologyRev,
        spaceTopologyRev: this.docStore.getSurfaceTopologyRev(applied.spaceId),
        surfaces,
        ...(applied.purged ? { purged: applied.purged } : {}),
        replayed: commit.replayed,
      },
    }
  }
}

/** One sentence per store rejection. Written out rather than echoed as a code so
 *  a CLI user and an agent reading an HTTP error get the same explanation. */
function rejectionMessage(reason: SurfaceRejection): string {
  switch (reason) {
    case 'unknown-surface': return 'no such Surface'
    case 'unknown-home': return 'the requested home does not exist'
    case 'cross-space': return 'the requested home is in a different space'
    case 'cycle': return 'the requested home is the Surface itself or one of its descendants'
    case 'stale-topology-revision': return 'the space topology has moved since you read it; re-read and retry'
    case 'stale-surface-revision': return 'one of the named Surfaces has moved since you read it; re-read and retry'
    case 'mixed-home': return 'group requires Surfaces that currently share one home'
    case 'duplicate-id': return 'that Surface id already exists; identity is non-reusable'
    case 'no-change': return 'every named Surface is already exactly where it was asked to go'
    case 'recovery-home': return 'the recovery store is not a home a caller may name; use delete'
    case 'deleted': return 'the Surface is in the recovery store; restore it first'
    case 'not-deleted': return 'the Surface is not the root of a deleted subtree'
    case 'descendant-mismatch': return 'the named descendant set or disposition does not match this Surface'
  }
}

function commitMessage(reason: string): string {
  switch (reason) {
    case 'faulted-read-only':
      return 'the canonical Surface store is faulted (read-only): both snapshots are unreadable and are being preserved as evidence'
    case 'stale-revision': return 'a named Surface has moved since you read it; re-read and retry'
    case 'unknown-record': return 'the transaction named a record the durable store does not hold'
    case 'invalid-record': return 'the candidate record did not survive validation'
    case 'write-failed': return 'the durable write failed; nothing changed'
    default: return `commit refused: ${reason}`
  }
}
