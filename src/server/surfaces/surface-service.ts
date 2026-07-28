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
  SurfaceCompatAlias,
  SurfaceContent,
  SurfaceContentAuthority,
  SurfaceContext,
  SurfaceContributor,
  SurfaceDeleteDisposition,
  SurfaceHome,
  SurfacePrincipalRef,
  SurfaceProvenance,
  SurfaceSourceBinding,
} from '../../domain/types'
import { createHash } from 'node:crypto'
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
  | 'update-content'
  | 'transfer-content-authority'
  | 'append-thread'
  | 'group'
  | 'reparent'
  | 'ungroup'
  | 'refresh-request'
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
  /** A refresh was requested for a Surface already queued for one. */
  | 'already-queued'
  /** A refresh was requested for a Surface already being refreshed. */
  | 'already-refreshing'
  /** `ungroup` was asked to dissolve a Surface that holds nothing. */
  | 'not-a-group'

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
  }): Promise<{ ok: true; watermark: string } | { ok: false; message: string }>
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
  ['headline', 'body', 'recipe', 'expectedRev', 'expectedWatermark']

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
  return {
    headline: raw.headline.trim(),
    ...(body ? { body } : {}),
    ...(typeof raw.recipe === 'string' && raw.recipe ? { recipe: raw.recipe } : {}),
  }
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
  return {
    adapter: raw.adapter,
    locator: raw.locator,
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
   * The whitelist is `headline`, `body`, and `recipe` — nothing else on the record
   * is authored content, and a caller that names anything else is told so rather
   * than having it quietly ignored. `null` clears `body` or `recipe`; omitting
   * them keeps what is there, which is the distinction a PATCH has to make and a
   * PUT cannot.
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

    const content: SurfaceContent = {
      headline: typeof headline === 'string' ? headline.trim() : prior.content.headline,
      ...(nextBody ? { body: nextBody } : {}),
      ...(recipe ? { recipe } : {}),
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
    const next: Surface = {
      ...prior,
      contentAuthority: to,
      rev: prior.rev + 1,
      amendedAt: ctx.at ?? Date.now(),
    }
    return this.commitContent('transfer-content-authority', prior, next, ctx, flight.fingerprint)
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
