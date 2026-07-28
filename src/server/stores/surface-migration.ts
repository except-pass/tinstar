// Legacy Slate → canonical Surface migration (plan U1).
//
// The Run Workspace's Slate is a set of run-scoped `Point`s whose ids are unique
// only WITHIN a run. Canonical Surfaces have global, non-reusable identity and one
// home. This module is the bridge between those two worlds: legacy points in,
// canonical records plus a diagnostics report out.
//
// Three properties drive every decision below.
//
// 1. RE-ENTRANT, NOT ONE-SHOT. The obvious implementation — "if any canonical
//    record exists, migration already ran, skip it" — is a data-loss bug, not an
//    optimisation. For the whole window between U1 and U2 the legacy bridge is
//    still the WRITE path: agents keep projecting files into `slatePoints` and the
//    user keeps typing replies into them. Anything written after the first
//    migration would never reach the canonical store, and would vanish the moment
//    U2 makes aliases authoritative. So every pass reconciles NEW and CHANGED
//    legacy points against whatever canonical records already exist.
//
// 2. DETERMINISTIC ACROSS BOOTS. Identity comes from `deriveRunIncarnation` plus
//    the point's run-local id, and every timestamp on a produced record is COPIED
//    from the legacy point rather than stamped with `Date.now()`. Two passes over
//    identical input therefore produce byte-identical records — which is what stops
//    a restart from minting a second Surface for every point and orphaning every
//    thread.
//
// 3. QUARANTINE, NEVER GUESS. A colliding id, a malformed entry, or a missing
//    derivation input is REPORTED and skipped. It is never repaired by inventing a
//    value, and the legacy snapshot is never mutated or deleted — this module only
//    reads its input. A guessed incarnation is indistinguishable from a real one
//    forever after, and a quarantined candidate must still leave the legacy Run
//    Workspace fully usable, because that legacy view is the user's only copy.
//
// NOTHING CALLS THIS YET. U1 introduces the model, the sidecar, and this
// migration; wiring it into boot, `DocumentStore`, and SSE are separate units. A
// reviewer should observe zero runtime change from this file.

import type {
  Point,
  PointAuthor,
  PointStatus,
  Surface,
  SurfaceCompatAlias,
  SurfaceContent,
  SurfaceHome,
} from '../../domain/types'
import type { Reply } from '../../domain/pinSet'
import { derivePointStatus } from './slate'
import { buildTopologyIndex, deriveLegacySurfaceId, deriveRunIncarnation } from './surfaces'

/**
 * The compatibility-alias `localId` carried by a run's ROOT Surface.
 *
 * Leads with a NUL so it can never collide with a real point id: a point id is
 * either a file-authored slug, a generated `pt-syn-…`/`pt-user-…`, or the reserved
 * `objective` — all printable. A collision would still be caught (see the
 * `id-collision` quarantine) rather than silently merged, but being unable to
 * collide in the first place is better than detecting it.
 *
 * Written as a unicode escape, not a raw byte: a raw NUL makes git treat the whole
 * source file as binary. Same reason `SlateStore.k` spells its joiner out.
 */
export const LEGACY_RUN_ROOT_LOCAL_ID = '\u0000run-root'

/**
 * The space a run with NO `spaceId` is migrated into.
 *
 * `Run.spaceId` is optional and `Surface.spaceId` is required, so space-less runs
 * need somewhere to land. Quarantining them instead would be worse than a synthetic
 * space: it would leave a whole class of existing runs — every run created before
 * spaces, and every run in a single-space install — with no canonical
 * representation at all, which is precisely the outcome migration exists to avoid.
 *
 * The cost is stated rather than hidden: `Surface.spaceId` is IMMUTABLE, so a run
 * that later gains a real space cannot have its Surfaces moved into it by an
 * ordinary write. That case is detected and reported as a `space-drift` quarantine
 * rather than silently rewritten.
 */
export const LEGACY_SPACELESS_SPACE_ID = 'space-legacy-spaceless'

/**
 * The source adapter name stamped on migrated FILE-authored Surfaces.
 *
 * Deliberately NOT `slate-file`. A legacy `Point` records no file path — Slate
 * point identity is an `id` INSIDE the file and "the filename is incidental"
 * (`slate.ts`) — so there is no path to put in a `slate-file` locator. Claiming
 * that adapter with a fabricated path would hand U2's file reconciler a locator
 * that resolves to nothing. This adapter's locator is a logical (run, local id)
 * address, which is what the legacy bridge actually addresses points by.
 */
export const LEGACY_SLATE_ADAPTER = 'legacy-slate-point'

/** The logical locator for a migrated point: an address in the legacy bridge, not
 *  a filesystem path. See {@link LEGACY_SLATE_ADAPTER}. */
export function legacyPointLocator(runId: string, localId: string): string {
  return `run:${runId}/point:${localId}`
}

/** The canonical id of a run's compatibility root Surface. */
export function deriveLegacyRunRootId(incarnation: string): string {
  return deriveLegacySurfaceId(incarnation, LEGACY_RUN_ROOT_LOCAL_ID)
}

// --- Input ---

/** One run's legacy state, as migration input. Read-only: this module never writes
 *  back into it, so a quarantined candidate always leaves the legacy Run Workspace
 *  exactly as it was. */
export interface LegacyRunSnapshot {
  runId: string
  /** `Run.createdAt` — an ISO string. Part of the incarnation basis, so a run that
   *  lacks it is quarantined rather than given a substitute. */
  createdAt?: string
  /** `Run.spaceId`. Absent falls back to {@link LEGACY_SPACELESS_SPACE_ID}. */
  spaceId?: string
  /** The run's `slatePoints`, in any order. */
  points: readonly Point[]
}

export interface SurfaceMigrationInput {
  runs: readonly LegacyRunSnapshot[]
  /**
   * Canonical records already in the store. THE re-entrancy input: a second boot
   * passes what the first one committed, and gets back only what actually changed.
   * Records belonging to runs absent from `runs` are left completely alone — they
   * are neither reported nor rewritten, because this pass has no evidence about
   * them either way.
   */
  existing?: readonly Surface[]
  /**
   * ADOPT, do not re-author (plan U2).
   *
   * Between U1 and U2 the legacy bridge was still the write path, so every pass had
   * to carry legacy changes forward onto the canonical records — which is why
   * {@link buildSurface} rebuilds content and thread from the legacy point.
   *
   * U2 ends that. Canonical Surfaces are the write path now, `Run.slate` derives
   * from them, and the legacy snapshot is FROZEN evidence (KTD5). Re-authoring an
   * existing record from that frozen copy on every boot is data loss, not
   * re-entrancy: it would revert every reply typed since the freeze and every body
   * the file reconciler has written, once per restart, silently. So a pass in this
   * mode creates the canonical counterpart of a legacy point that has none and
   * leaves every record that already exists exactly as it is.
   *
   * Defaulted OFF so the U1 semantics — and the tests that pin them — are unchanged
   * for a caller that has not made the switch. `bootSurfaces` passes `true`.
   */
  adoptOnly?: boolean
  /** Override for {@link LEGACY_SPACELESS_SPACE_ID}. */
  fallbackSpaceId?: string
  /** Epoch ms stamped on the REPORT (never on a record). Injectable so a caller
   *  can make the whole outcome deterministic. */
  now?: number
}

// --- Diagnostics ---

/** Why one candidate was refused. Every value here means "the legacy data is still
 *  intact and still rendering; the canonical copy was not made". */
export type SurfaceMigrationQuarantineReason =
  /** The run snapshot has no usable `runId`. */
  | 'missing-run-id'
  /** No `Run.createdAt`, so no incarnation can be derived. There is no safe
   *  deterministic substitute: any placeholder would be indistinguishable from a
   *  real basis on the next boot. */
  | 'missing-run-created-at'
  /** `Run.createdAt` is present but not a parseable date, so the root Surface has
   *  no honest creation stamp. */
  | 'unparsable-run-created-at'
  /** The point is not an object, or has no usable `id`. */
  | 'malformed-point'
  /** A `SurfaceContent` needs a headline to render anywhere; this point has none. */
  | 'missing-headline'
  /** Two points of the same run share a local id. First wins, rest quarantined —
   *  mirroring `SlateStore.applyProjection`'s "first entry wins on a duplicate id". */
  | 'duplicate-local-id'
  /** The derived Surface id is already held by a canonical record that is NOT this
   *  point's counterpart. Merging would graft one surface's thread onto another. */
  | 'id-collision'
  /** Another canonical record already claims this run+localId compatibility alias.
   *  Writing a second claimant would make `Run.slate` ambiguous. */
  | 'alias-collision'
  /** The existing canonical record sits in a different space than the run now
   *  reports, and `Surface.spaceId` is immutable. */
  | 'space-drift'
  /** The run's compatibility root could not be claimed, so its points have nowhere
   *  to be homed and none of them were migrated this pass. */
  | 'run-root-unavailable'

export interface SurfaceMigrationQuarantine {
  reason: SurfaceMigrationQuarantineReason
  /** The run the entry belongs to. Empty only for a snapshot with no run id. */
  runId: string
  /** The legacy point id. Absent when the whole run was refused. */
  localId?: string
  /** The canonical id this candidate WOULD have taken, when it was derivable. */
  surfaceId?: string
  /** A sentence safe to print verbatim in a human-readable dump. */
  detail: string
}

/** A legacy field with no canonical home yet. NOT a quarantine: the Surface was
 *  created, the legacy data is untouched, and only this one aspect failed to carry
 *  across. Reported so the loss is visible rather than discovered later by a user
 *  whose diagram anchor disappeared. */
export interface SurfaceMigrationPreservationGap {
  runId: string
  localId: string
  surfaceId: string
  /** Legacy `Point` field names, e.g. `anchor`, `group`, `stalledAt`. */
  fields: string[]
}

/** A canonical record aliased to a migrated run whose legacy point is GONE.
 *  Reported, never deleted: under KTD15 removal is a move into the recovery store
 *  inside a topology transaction, which is a later unit's mutation to make. */
export interface SurfaceMigrationOrphan {
  runId: string
  localId: string
  surfaceId: string
}

/** A Surface belonging to a PREVIOUS incarnation of a run whose name has since
 *  been recreated. Its run compatibility alias was moved to the
 *  `workspace-recovery` bucket so the new incarnation can claim the run's legacy
 *  presentation. Identity, thread, home, and revision lineage are untouched. */
export interface SurfaceMigrationRetirement {
  runId: string
  /** The legacy local id the retired alias carried. */
  localId: string
  surfaceId: string
}

export interface SurfaceMigrationRunReport {
  runId: string
  /** `null` when the run was quarantined before an incarnation could be derived. */
  incarnation: string | null
  /** The space its Surfaces were migrated into (possibly the fallback). */
  spaceId: string
  /** `null` when the run has no usable canonical root — which also means none of
   *  its points were migrated this pass. */
  rootSurfaceId: string | null
  created: number
  updated: number
  unchanged: number
  quarantined: number
  /** Surfaces of a previous incarnation of this run name, moved to the
   *  workspace-recovery bucket. See {@link SurfaceMigrationRetirement}. */
  retired: number
}

/**
 * The whole diagnostics report for one pass. Deliberately a DATA structure with no
 * formatting in it: the human-readable dump is a separate concern that renders
 * this, so the two can change independently and the numbers stay assertable.
 */
export interface SurfaceMigrationReport {
  /** Epoch ms the pass ran. Diagnostics only — never written onto a record. */
  at: number
  runsSeen: number
  /** Runs that produced (or confirmed) a canonical root. */
  runsMigrated: number
  /** Runs with no usable root — nothing of theirs was migrated, legacy untouched. */
  runsQuarantined: number
  surfacesCreated: number
  surfacesUpdated: number
  /** Candidates that matched an existing record exactly. The number that should
   *  dominate on a steady-state boot; a large `surfacesUpdated` on a boot with no
   *  legacy activity means something is churning revisions. */
  surfacesUnchanged: number
  quarantined: SurfaceMigrationQuarantine[]
  preservationGaps: SurfaceMigrationPreservationGap[]
  orphaned: SurfaceMigrationOrphan[]
  retired: SurfaceMigrationRetirement[]
  /** Per-run detail, ordered by `runId` like the pass itself. */
  runs: SurfaceMigrationRunReport[]
}

export interface SurfaceMigrationOutcome {
  /**
   * Records to write — created AND updated, nothing else. Empty means a boot with
   * no legacy drift, which is the steady state this pass should reach.
   *
   * Record level rather than a snapshot, so a caller can hand it straight to
   * `SurfaceSidecar.commit({ puts })` or `SurfaceStore.load` without this module
   * knowing which. Ordered deterministically (by run, then by the run's own render
   * order) so a diff between two passes is readable.
   */
  puts: Surface[]
  report: SurfaceMigrationReport
}

// --- Internals ---

const KNOWN_STATUSES: ReadonlySet<string> = new Set<PointStatus>([
  'open', 'discussing', 'waiting', 'resolved', 'dismissed',
])

/** Legacy `Point` fields that have no canonical `Surface` counterpart yet.
 *  `anchor` drives the legacy `diagram` kind, `group` the S4 workbench band, and
 *  `stalledAt` the dead-writer marker — none of which the canonical record models. */
const UNCARRIED_POINT_FIELDS = ['anchor', 'group', 'stalledAt'] as const

/** The render order `SlateStore.getPointsForRun` uses, reproduced here so a
 *  migrated run's sibling order matches the order the user was looking at. */
function compareLegacyPoints(a: Point, b: Point): number {
  const rank = (p: Point) => p.order ?? p.createdAt
  return rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** The alias index key. NUL joins the two halves for the same reason
 *  `SlateStore.k` does: it can appear in neither a run id (a tmux session name)
 *  nor a point id, so the composite is unambiguous. */
function aliasKey(runId: string, localId: string): string {
  return runId + '\u0000' + localId
}

/** Everything that varies between building a fresh record and reconciling one. */
interface BuildParams {
  id: string
  spaceId: string
  /** Home for a NEWLY created record. An existing record keeps its own — see
   *  {@link buildSurface}. */
  defaultHome: SurfaceHome
  /** Topology revision for a newly created record. */
  batchHomeRev: number
  content: SurfaceContent
  author: PointAuthor
  order?: number
  /** Absent for a store-only (user-authored) surface — see the authority mapping
   *  in {@link buildSurface}. */
  sourceLocator?: string
  runId: string
  aliasLocalId: string
  aliasDefaultVisible: boolean
  replies: Reply[]
  status: PointStatus
  resolvedAt?: number
  dismissedAt?: number
  createdAt: number
  amendedAt: number
  /** Marks the per-run compatibility root (KTD3 presentation metadata). */
  compatibilityOnly?: boolean
}

/**
 * Build one canonical record, either fresh (`prior` absent) or reconciled.
 *
 * ONE builder for both paths is load-bearing, and not only for tidiness: the
 * unchanged-detection below compares `JSON.stringify`, which compares key ORDER
 * too (the same caveat `pointEqual` in `slate.ts` carries). Two builders would
 * emit the same fields in different orders as soon as an optional field appeared,
 * and every boot would then report a spurious change and burn a revision.
 *
 * What is carried from `prior` rather than rebuilt is the interesting part — it is
 * exactly the set of things the legacy bridge does NOT own:
 *   · `home`/`homeRev` — a later unit may PROMOTE a Surface from its run root onto
 *     the Canvas (KTD3). A migration pass that reset the home would drag it back
 *     under the run on the next boot, undoing the user's arrangement on a timer;
 *   · alias `visible` — closing a legacy presentation is a user decision, and
 *     re-showing a card the user dismissed is the same class of bug;
 *   · `owner` and `freshness` — host-owned lifecycle state with no legacy source,
 *     so rebuilding them would wipe an assigned owner or an in-flight refresh;
 *   · `createdAt` — identity-adjacent. The record's own birth stamp, not the
 *     legacy point's current opinion of it;
 *   · foreign aliases — a Surface may carry more than one bucket (KTD3), and only
 *     THIS run's alias is ours to rewrite.
 */
function buildSurface(p: BuildParams, prior?: Surface): Surface {
  // This run's alias keeps whatever visibility it already had; a brand-new one
  // starts at the caller's default (visible for a point, hidden for a root).
  const isOwnAlias = (a: SurfaceCompatAlias) =>
    a.bucket.kind === 'run' && a.bucket.runId === p.runId && a.localId === p.aliasLocalId
  const priorAlias = prior?.aliases?.find(isOwnAlias)
  const ownAlias: SurfaceCompatAlias = {
    bucket: { kind: 'run', runId: p.runId },
    localId: p.aliasLocalId,
    visible: priorAlias?.visible ?? p.aliasDefaultVisible,
  }
  const foreign = (prior?.aliases ?? []).filter(a => !isOwnAlias(a))
  return {
    id: p.id,
    spaceId: p.spaceId,
    home: prior?.home ?? p.defaultHome,
    ...(p.order != null ? { order: p.order } : {}),
    content: p.content,
    // The AUTHORITY mapping, and the field that carries legacy `Point.source`
    // across losslessly. A `source:'file'` point is reconciled from an authoring
    // file, so the binding wins (`source-binding`); a `source:'user'` point has no
    // file behind it at all, so the record itself is authoritative
    // (`canonical-direct`, no binding). That pairing is what lets a projection back
    // to `Run.slate` recover `source:'user'` — which, together with the reserved
    // alias localId, is exactly the `source === 'user' && id === OBJECTIVE_POINT_ID`
    // test `document-store.ts` uses to render the Objective as the pinned goal.
    contentAuthority: p.sourceLocator ? 'source-binding' : 'canonical-direct',
    ...(p.sourceLocator
      ? { source: { adapter: LEGACY_SLATE_ADAPTER, locator: p.sourceLocator, generation: 0 } }
      : {}),
    provenance: { runId: p.runId },
    author: p.author,
    ...(prior?.owner ? { owner: prior.owner } : {}),
    thread: {
      replies: p.replies,
      status: p.status,
      ...(p.resolvedAt != null ? { resolvedAt: p.resolvedAt } : {}),
      ...(p.dismissedAt != null ? { dismissedAt: p.dismissedAt } : {}),
    },
    freshness: prior?.freshness ?? { phase: 'current', overdue: false },
    aliases: [ownAlias, ...foreign],
    ...(p.compatibilityOnly ? { compatibilityOnly: true as const } : {}),
    rev: prior ? prior.rev + 1 : 1,
    homeRev: prior?.homeRev ?? p.batchHomeRev,
    createdAt: prior?.createdAt ?? p.createdAt,
    amendedAt: p.amendedAt,
  }
}

/** True when the candidate differs from the stored record in nothing but its
 *  revision — i.e. the legacy side has not moved since the last pass. Comparing
 *  with the prior revision substituted in is what makes a steady-state boot a
 *  no-op instead of a revision-burning rewrite of every record. */
function unchanged(prior: Surface, candidate: Surface): boolean {
  return JSON.stringify({ ...candidate, rev: prior.rev }) === JSON.stringify(prior)
}

/** Mutable bookkeeping threaded through one pass. A plain object rather than
 *  closures-over-locals so the reconcile step reads the same whether it is called
 *  for a run root or for a point — one code path, one set of collision rules. */
interface PassState {
  adoptOnly: boolean
  byId: Map<string, Surface>
  byAlias: Map<string, Surface>
  claimedIds: Set<string>
  claimedAliases: Set<string>
  puts: Surface[]
  quarantined: SurfaceMigrationQuarantine[]
  retired: SurfaceMigrationRetirement[]
}

/**
 * Hand a recreated run's legacy presentation over from the incarnation that died
 * with the old run.
 *
 * THE PROBLEM. A run id is a tmux session name. Delete it, recreate it, and the
 * new run has a new `createdAt` and therefore a new incarnation — which is the
 * point: the reborn run must not inherit the dead run's threads. But compatibility
 * aliases are keyed on the run NAME (`SurfaceCompatAlias.bucket` is
 * `{kind:'run', runId}`), not on the incarnation. So the dead run's Surfaces still
 * hold every alias the reborn run needs, and without this step the reborn run
 * collides on its own root and NEVER migrates — permanently, on every boot.
 *
 * THE SIGNAL, and why it is not a guess. `LEGACY_RUN_ROOT_LOCAL_ID` is a reserved
 * NUL-prefixed local id that only this module ever writes. If it is held for this
 * run by a Surface whose id is not the one THIS incarnation derives, then this run
 * name was migrated before under a different incarnation. That is an invariant of
 * this module, not an inference about the outside world.
 *
 * THE ACTION, and why it is not destructive. Each stale Surface keeps its identity,
 * thread, home, provenance, and revision lineage; only its run alias moves to the
 * `workspace-recovery` bucket — which KTD3 defines as exactly "the fallback bucket
 * for a Surface whose source run no longer exists", so that disabling recursive
 * mode still exposes it as a flat compatibility list. Nothing is erased, and the
 * user can still reach the old run's discussion.
 *
 * Scoped narrowly on purpose: only aliases for THIS run, and only on records this
 * incarnation does not derive. A record holding an alias for some other run keeps
 * it, and a record this incarnation DOES derive is an ordinary reconcile.
 */
function retirePreviousIncarnation(
  state: PassState,
  report: SurfaceMigrationRunReport,
  runId: string,
  incarnation: string,
): void {
  const rootHolder = state.byAlias.get(aliasKey(runId, LEGACY_RUN_ROOT_LOCAL_ID))
  if (!rootHolder || rootHolder.id === deriveLegacyRunRootId(incarnation)) return

  // Sorted so a boot that retires several records emits them in a stable order —
  // the report is a diff a human reads.
  const stale = [...state.byId.values()]
    .filter(s => (s.aliases ?? []).some(
      a => a.bucket.kind === 'run'
        && a.bucket.runId === runId
        && deriveLegacySurfaceId(incarnation, a.localId) !== s.id,
    ))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  for (const s of stale) {
    const aliases = (s.aliases ?? []).map(a => {
      if (a.bucket.kind !== 'run' || a.bucket.runId !== runId) return a
      if (deriveLegacySurfaceId(incarnation, a.localId) === s.id) return a
      state.byAlias.delete(aliasKey(runId, a.localId))
      state.retired.push({ runId, localId: a.localId, surfaceId: s.id })
      report.retired++
      // `visible` is carried over rather than reset: the user's decision about
      // whether to show this card outlives the bucket it shows up in.
      return { bucket: { kind: 'workspace-recovery' as const }, localId: a.localId, visible: a.visible }
    })
    // `amendedAt` is deliberately NOT bumped — re-bucketing a compatibility alias
    // is not a re-authoring, and bumping it would reset the freshness clock on a
    // Surface nobody touched.
    const next: Surface = { ...s, aliases, rev: s.rev + 1 }
    state.byId.set(s.id, next)
    state.puts.push(next)
  }
}

/**
 * Claim an identity and either stage a record or record a quarantine. Shared by
 * the run root and its points so both are subject to the SAME collision rules — a
 * root that could quietly overwrite a colliding record would be the one place
 * where "quarantine, never guess" had an exception.
 */
function reconcile(
  state: PassState,
  report: SurfaceMigrationRunReport,
  params: BuildParams,
): boolean {
  const key = aliasKey(params.runId, params.aliasLocalId)
  const prior = state.byId.get(params.id)
  const aliasHolder = state.byAlias.get(key)

  const refuse = (reason: SurfaceMigrationQuarantineReason, detail: string): boolean => {
    report.quarantined++
    state.quarantined.push({
      reason, runId: params.runId, localId: params.aliasLocalId, surfaceId: params.id, detail,
    })
    return false
  }

  // Someone else already holds this alias. Refuse rather than write a second
  // claimant: `Run.slate` is derived THROUGH aliases, so two records claiming one
  // local id makes the legacy view ambiguous — and the legacy view is what the
  // user is still looking at for the whole migration window.
  if (aliasHolder && aliasHolder.id !== params.id) {
    return refuse(
      'alias-collision',
      `canonical Surface ${aliasHolder.id} already claims run ${params.runId} alias ${JSON.stringify(params.aliasLocalId)}; the legacy entry was left in place and not migrated`,
    )
  }
  // The derived id is held by a record that is NOT this candidate's counterpart
  // (it does not carry our alias). Merging would graft this point's content onto a
  // stranger's thread.
  if (prior && !prior.aliases?.some(
    a => a.bucket.kind === 'run' && a.bucket.runId === params.runId && a.localId === params.aliasLocalId,
  )) {
    return refuse(
      'id-collision',
      `derived Surface id ${params.id} is already held by a record that does not alias run ${params.runId}/${params.aliasLocalId}`,
    )
  }
  // `Surface.spaceId` is immutable, so a run that moved between spaces cannot have
  // its canonical records followed over. Reported instead of rewritten — rewriting
  // would silently teleport a subtree, the exact failure `SurfaceStore.checkHome`'s
  // cross-space rejection exists to prevent.
  if (prior && prior.spaceId !== params.spaceId) {
    return refuse(
      'space-drift',
      `canonical Surface ${params.id} lives in space ${prior.spaceId} but run ${params.runId} now reports ${params.spaceId}; spaceId is immutable`,
    )
  }
  // Two candidates in ONE pass resolving to the same identity — a hash collision or
  // a reserved-id clash. A guess-free refusal rather than last-write-wins.
  if (state.claimedIds.has(params.id) || state.claimedAliases.has(key)) {
    return refuse(
      'id-collision',
      `two legacy entries in this pass resolve to Surface id ${params.id}; the first was migrated and this one was refused`,
    )
  }

  // ADOPT-ONLY: a record that already exists is the authority and this pass has
  // nothing to add to it. Counted as `unchanged` rather than as a separate outcome
  // because from the report's side that is exactly what it is — the canonical store
  // already holds this point and no write was needed.
  if (prior && state.adoptOnly) {
    state.claimedIds.add(params.id)
    state.claimedAliases.add(key)
    report.unchanged++
    return true
  }
  const candidate = buildSurface(params, prior)
  state.claimedIds.add(params.id)
  state.claimedAliases.add(key)
  if (prior && unchanged(prior, candidate)) {
    report.unchanged++
    return true
  }
  // Index the write immediately so a later candidate in this same pass sees it —
  // otherwise a second entry deriving the same id would read the pre-pass state and
  // the collision checks above would never fire.
  state.byId.set(params.id, candidate)
  state.byAlias.set(key, candidate)
  state.puts.push(candidate)
  if (prior) report.updated++
  else report.created++
  return true
}

// --- The pass ---

/**
 * Reconcile legacy Slate points into canonical Surface records.
 *
 * PURE: it reads its input and returns records plus a report. It writes no file,
 * touches no store, and mutates nothing it was given — including on the failure
 * paths, which is what makes "an alias collision leaves the legacy Run Workspace
 * usable" true by construction rather than by care.
 */
export function migrateLegacySlate(input: SurfaceMigrationInput): SurfaceMigrationOutcome {
  const at = input.now ?? Date.now()
  const fallbackSpaceId = input.fallbackSpaceId ?? LEGACY_SPACELESS_SPACE_ID
  const existing = [...(input.existing ?? [])].filter(s => s && typeof s.id === 'string' && s.id.length > 0)

  // Indexes over what is already canonical. Built once: a per-candidate scan would
  // be quadratic on the record set, and this runs on every boot.
  const state: PassState = {
    adoptOnly: input.adoptOnly === true,
    byId: new Map(),
    byAlias: new Map(),
    claimedIds: new Set(),
    claimedAliases: new Set(),
    puts: [],
    quarantined: [],
    retired: [],
  }
  /** runId → the run aliases already claimed, for orphan detection. */
  const aliasesByRun = new Map<string, { localId: string; surfaceId: string }[]>()
  for (const s of existing) {
    state.byId.set(s.id, s)
    for (const a of s.aliases ?? []) {
      if (a.bucket.kind !== 'run') continue
      const key = aliasKey(a.bucket.runId, a.localId)
      // First writer wins on a pre-existing duplicate: the store should never hold
      // two claimants, and if it somehow does, this pass must not pick a different
      // one each boot and flap the identity it reconciles against.
      if (!state.byAlias.has(key)) state.byAlias.set(key, s)
      const bucket = aliasesByRun.get(a.bucket.runId)
      const entry = { localId: a.localId, surfaceId: s.id }
      if (bucket) bucket.push(entry)
      else aliasesByRun.set(a.bucket.runId, [entry])
    }
  }
  // The topology revision each space is already at, rebuilt from the records by the
  // same pure function the store's reload uses — so a migrated record's `homeRev`
  // is consistent with what `SurfaceStore` would have assigned.
  const { topologyRevs } = buildTopologyIndex(existing)
  const batchHomeRevs = new Map<string, number>()
  const batchHomeRev = (spaceId: string): number => {
    const cached = batchHomeRevs.get(spaceId)
    if (cached != null) return cached
    // ONE topology revision for the whole pass per space, not one per record: a
    // migration is a single atomic topology change (KTD7), and numbering it that way
    // keeps the revision from jumping by the point count on the first boot.
    const next = (topologyRevs.get(spaceId) ?? 0) + 1
    batchHomeRevs.set(spaceId, next)
    return next
  }

  const preservationGaps: SurfaceMigrationPreservationGap[] = []
  const orphaned: SurfaceMigrationOrphan[] = []
  const runReports: SurfaceMigrationRunReport[] = []

  // Deterministic run order. The output is a diff a human reads; an iteration order
  // that changed between boots would make every dump look different.
  const runs = [...input.runs].sort((a, b) => {
    const x = a?.runId ?? '', y = b?.runId ?? ''
    return x < y ? -1 : x > y ? 1 : 0
  })

  for (const run of runs) {
    const runId = typeof run?.runId === 'string' ? run.runId : ''
    if (!runId) {
      state.quarantined.push({
        reason: 'missing-run-id',
        runId: '',
        detail: 'run snapshot has no runId; its points cannot be addressed or aliased',
      })
      runReports.push({
        runId: '', incarnation: null, spaceId: '', rootSurfaceId: null,
        created: 0, updated: 0, unchanged: 0, quarantined: 1, retired: 0,
      })
      continue
    }
    const spaceId = run.spaceId || fallbackSpaceId
    const report: SurfaceMigrationRunReport = {
      runId, incarnation: null, spaceId, rootSurfaceId: null,
      created: 0, updated: 0, unchanged: 0, quarantined: 0, retired: 0,
    }
    runReports.push(report)

    const incarnation = deriveRunIncarnation(runId, run.createdAt)
    if (!incarnation) {
      report.quarantined++
      state.quarantined.push({
        reason: 'missing-run-created-at',
        runId,
        detail: `run ${runId} has no createdAt; the incarnation basis is incomplete and there is no safe substitute`,
      })
      continue
    }
    const rootCreatedAt = Date.parse(run.createdAt!)
    if (!Number.isFinite(rootCreatedAt)) {
      report.quarantined++
      state.quarantined.push({
        reason: 'unparsable-run-created-at',
        runId,
        detail: `run ${runId} createdAt ${JSON.stringify(run.createdAt)} is not a parseable date`,
      })
      continue
    }
    report.incarnation = incarnation

    // Hand the run's legacy presentation over from a previous incarnation before
    // anything tries to claim it. Must run BEFORE the root reconcile: otherwise the
    // dead incarnation's root still holds the alias and the reborn run quarantines
    // itself out of existence on every boot.
    retirePreviousIncarnation(state, report, runId, incarnation)

    // --- The compatibility root ---
    //
    // Created for EVERY migrated run, including one with no points. A root that
    // only appeared once a run had its first point would have its creation (and so
    // its `homeRev`) depend on when that point arrived, which makes the run→root
    // mapping partial and boot-order-dependent for no gain — the root is
    // `compatibilityOnly`, so it is excluded from ordinary Canvas projection and
    // costs one invisible record.
    const rootId = deriveLegacyRunRootId(incarnation)
    const rootOk = reconcile(state, report, {
      id: rootId,
      spaceId,
      defaultHome: { kind: 'canvas', spaceId },
      batchHomeRev: batchHomeRev(spaceId),
      // The run's own id, not a decorated label: the root is never rendered as a
      // card, and inventing prose here would be the first thing to go stale when a
      // run is renamed.
      content: { headline: runId },
      author: 'agent',
      runId,
      aliasLocalId: LEGACY_RUN_ROOT_LOCAL_ID,
      // Hidden by design: the root is migration scaffolding, and a visible alias
      // would put a "run root" row into the very Slate list it contains.
      aliasDefaultVisible: false,
      replies: [],
      status: 'open',
      createdAt: rootCreatedAt,
      amendedAt: rootCreatedAt,
      compatibilityOnly: true,
    })
    if (!rootOk) {
      // Without a root there is no home for the run's points, and homing them on
      // the Canvas instead would dump every legacy point onto the canvas as a
      // top-level card. Leave the whole run for the next boot: the legacy Slate
      // still renders it, which is the entire point of the compatibility window.
      state.quarantined.push({
        reason: 'run-root-unavailable',
        runId,
        surfaceId: rootId,
        detail: `run ${runId} has no usable compatibility root, so none of its ${run.points?.length ?? 0} point(s) were migrated this pass`,
      })
      continue
    }
    report.rootSurfaceId = rootId

    // --- The points ---
    const seenLocalIds = new Set<string>()
    const points = [...(run.points ?? [])].filter(p => !!p).sort(compareLegacyPoints)
    for (const p of points) {
      if (typeof p !== 'object' || typeof p.id !== 'string' || p.id.length === 0) {
        report.quarantined++
        state.quarantined.push({
          reason: 'malformed-point',
          runId,
          detail: `run ${runId} holds a point with no usable id; it cannot be given a derived identity`,
        })
        continue
      }
      const localId = p.id
      const derivedId = deriveLegacySurfaceId(incarnation, localId)
      if (seenLocalIds.has(localId)) {
        report.quarantined++
        state.quarantined.push({
          reason: 'duplicate-local-id',
          runId,
          localId,
          surfaceId: derivedId,
          detail: `run ${runId} lists local id ${localId} more than once; the first entry was migrated and this one was refused`,
        })
        continue
      }
      seenLocalIds.add(localId)
      if (typeof p.headline !== 'string' || p.headline.length === 0) {
        report.quarantined++
        state.quarantined.push({
          reason: 'missing-headline',
          runId,
          localId,
          surfaceId: derivedId,
          detail: `point ${localId} in run ${runId} has no headline; a Surface with no headline has nothing to render in a rail row, a breadcrumb, or a collapsed parent preview`,
        })
        continue
      }

      // `status` is preserved VERBATIM when it is a value this build understands,
      // because it is what the user was actually looking at. A status from a future
      // (or corrupt) build is re-derived from the thread instead of propagated —
      // `derivePointStatus` is the same function the legacy store maintains it
      // with, so agreement is the normal case.
      const status = KNOWN_STATUSES.has(p.status as string)
        ? p.status
        : derivePointStatus({ replies: p.replies, resolvedAt: p.resolvedAt, dismissedAt: p.dismissedAt })

      const ok = reconcile(state, report, {
        id: derivedId,
        spaceId,
        defaultHome: { kind: 'surface', surfaceId: rootId },
        batchHomeRev: batchHomeRev(spaceId),
        content: {
          headline: p.headline,
          ...(p.content ? { body: p.content } : {}),
          // The legacy file-owned `refresh` prompt IS the canonical author-declared
          // recipe — the same field under its canonical name (R13).
          ...(p.refresh ? { recipe: p.refresh } : {}),
        },
        author: p.author,
        // Preserved explicitly (not left to fall back on `createdAt`) so a user's
        // reorder survives: `SlateStore.reorderPoints` writes exactly this field.
        ...(p.order != null ? { order: p.order } : {}),
        ...(p.source === 'user' ? {} : { sourceLocator: legacyPointLocator(runId, localId) }),
        runId,
        aliasLocalId: localId,
        aliasDefaultVisible: true,
        // COPIED, never aliased: the produced record must not share an array with
        // the legacy point, or a later canonical mutation would reach back into the
        // Slate store's live thread.
        replies: [...(p.replies ?? [])],
        status,
        ...(p.resolvedAt != null ? { resolvedAt: p.resolvedAt } : {}),
        ...(p.dismissedAt != null ? { dismissedAt: p.dismissedAt } : {}),
        createdAt: p.createdAt,
        amendedAt: p.amendedAt,
      })
      if (!ok) continue

      const missing = UNCARRIED_POINT_FIELDS.filter(f => p[f] != null)
      if (missing.length > 0) {
        preservationGaps.push({ runId, localId, surfaceId: derivedId, fields: [...missing] })
      }
    }

    // --- Orphans ---
    //
    // Canonical records aliased to THIS run whose legacy point is gone. Reported and
    // left alone: removing one is a move into the per-space recovery store inside a
    // topology transaction (KTD15), which is a later unit's mutation. A migration
    // pass that deleted them would make "the legacy snapshot is never destroyed"
    // false for exactly the records with the most to lose.
    for (const a of aliasesByRun.get(runId) ?? []) {
      if (a.localId === LEGACY_RUN_ROOT_LOCAL_ID) continue
      if (seenLocalIds.has(a.localId)) continue
      orphaned.push({ runId, localId: a.localId, surfaceId: a.surfaceId })
    }
  }

  return {
    puts: state.puts,
    report: {
      at,
      runsSeen: runs.length,
      runsMigrated: runReports.filter(r => r.rootSurfaceId != null).length,
      runsQuarantined: runReports.filter(r => r.rootSurfaceId == null).length,
      surfacesCreated: runReports.reduce((n, r) => n + r.created, 0),
      surfacesUpdated: runReports.reduce((n, r) => n + r.updated, 0),
      surfacesUnchanged: runReports.reduce((n, r) => n + r.unchanged, 0),
      quarantined: state.quarantined,
      preservationGaps,
      orphaned,
      retired: state.retired,
      runs: runReports,
    },
  }
}
