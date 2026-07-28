// The canonical Surface store — one recursive work-artifact primitive, in memory.
//
// This is the successor to `SlateStore` (plan KTD1): where a `Point` is run-scoped
// and lives only inside one run's Slate, a `Surface` has GLOBAL, non-reusable
// identity and one home that may be the Canvas or another Surface. A Surface with
// children is the SAME entity as one without — the parent link lives on the child
// (`home`) and parent→children indexes are DERIVED here, never stored on the
// parent. That is the whole reason "container" can be shorthand instead of a
// second entity type.
//
// Ownership split, mirroring the Slate store's file-vs-store contract:
//   · content, thread, freshness, owner, aliases → written through `upsertSurface`
//     behind a per-record revision gate;
//   · home and sibling membership → written ONLY through the topology mutations
//     (`createSurface`, `setHome`, `reparent`, `group`), each of which validates
//     cycles and cross-space parentage and bumps the per-space topology revision.
// Splitting them is load-bearing: a content write that could also move a Surface
// would let an ordinary re-projection silently reparent a subtree the user
// arranged (plan's Canonical Field Authority table: "Home and sibling order …
// changed only by atomic topology mutation").
//
// Like `SlateStore`, every mutator equality-short-circuits and reports through an
// injected `emit` callback rather than importing an event bus — the store stays a
// plain data structure that `DocumentStore` (or, later, the Surface mutation
// service) composes and wires. It is server-only and React-free.
//
// NOTHING CALLS THIS YET. U1 introduces the model and the store; persistence,
// migration from legacy Slate points, SSE wiring, and the compatibility
// projection are separate units. A reviewer should observe zero runtime change.

import { createHash, randomUUID } from 'node:crypto'
import type {
  PointAuthor,
  Surface,
  SurfaceCompatAlias,
  SurfaceContent,
  SurfaceContentAuthority,
  SurfaceDeleteDisposition,
  SurfaceFreshness,
  SurfaceHome,
  SurfacePrincipalRef,
  SurfaceProvenance,
  SurfaceSourceBinding,
} from '../../domain/types'
import type { Reply } from '../../domain/pinSet'
// Reused rather than reimplemented on purpose: the canonical thread and the legacy
// point thread must agree on what "waiting" means for the whole migration window,
// and two copies of that derivation is precisely how a compatibility alias starts
// showing a different status than the Surface it aliases.
import { derivePointStatus } from './slate'

/** One record's worth of change. Unlike `SlateChange` there is no `data: null`
 *  retract case: under plan KTD15 deletion is a MOVE into a per-space recovery
 *  store, so a Surface leaves its parent's child list without ever leaving the
 *  record set. A retract shape can be added by the unit that needs one (space
 *  cascade), rather than shipping an unreachable branch now. */
export type SurfaceChange = {
  entity: 'surface'
  id: string
  spaceId: string
  data: Surface
}

/** One ATOMIC batch of changes (plan KTD7). Every mutator emits exactly one batch
 *  or none — never a change per record. A grouping that creates a parent and moves
 *  three children is one observable event, so a client can never render the
 *  half-applied frame where the parent exists but its children are still siblings.
 *
 *  Single-space by construction: cross-space parentage is rejected, so no mutation
 *  can ever span two spaces and the batch carries one `spaceId` and that space's
 *  post-mutation `topologyRev`.
 *
 *  BOTH revisions ride the batch, per the plan's wire spec ("`spaceId`, base and
 *  resulting topology revisions, ordered upserts, deletes, and explicit clear
 *  fields"). `baseTopologyRev` is what makes a client able to tell "I can apply
 *  this" from "I have missed something": a client whose local revision is not the
 *  base discards the batch and asks for a snapshot rather than applying a delta
 *  onto a tree it no longer agrees about.
 *
 *  There are no "explicit clear fields" here and that is deliberate: `changes`
 *  carry WHOLE records, so a client replaces rather than merges and a field the
 *  server dropped is simply absent from the replacement. A per-field clear list
 *  would be a second, separately-maintained description of the same state. */
export interface SurfaceBatch {
  spaceId: string
  /** The space topology revision this batch applies ON TOP OF. */
  baseTopologyRev: number
  /** The space topology revision after applying it. Equal to `baseTopologyRev`
   *  for a content-only write, which changed no topology. */
  topologyRev: number
  changes: SurfaceChange[]
  /** Ids ERASED from the record set. Only `purge` and the lifecycle cascade
   *  produce these — an ordinary delete is a move into the recovery store and
   *  arrives as a `change` whose `home.kind` is `recovery` (KTD15). */
  deletes?: string[]
}

type EmitFn = (batch: SurfaceBatch) => void

/** Why a topology mutation was refused. Returned rather than thrown: a stale
 *  revision is an ordinary race between two authors, not a programming error, and
 *  the caller's job is to re-read and retry — the same posture as
 *  `DocumentStore.upsertConstellationGraph` returning `false`. */
export type SurfaceRejection =
  /** A named Surface id is not in the store. */
  | 'unknown-surface'
  /** The requested home names a Surface (or space-less Canvas) that is not there. */
  | 'unknown-home'
  /** The home lives in a different space than the Surface being moved. */
  | 'cross-space'
  /** The requested home is the Surface itself or one of its descendants. */
  | 'cycle'
  /** The caller's expected space topology revision is not the current one. */
  | 'stale-topology-revision'
  /** The caller's expected revision for one of the affected Surfaces is stale. */
  | 'stale-surface-revision'
  /** `group` was asked to gather Surfaces that do not currently share one home. */
  | 'mixed-home'
  /** A create supplied an id that already exists — identity is non-reusable. */
  | 'duplicate-id'
  /** Valid, but every affected Surface is already exactly where it was asked to
   *  go. Reported as not-applied so a caller cannot mistake a no-op for progress. */
  | 'no-change'
  /** An ordinary topology mutation named the recovery store as a home. Only
   *  `planDelete` may put a Surface there (KTD15) — a reparent that could would be
   *  a delete with none of the bookkeeping that makes a delete undoable. */
  | 'recovery-home'
  /** The Surface is in the recovery store, or inside a subtree that is. A deleted
   *  Surface must be restored before it can be moved, edited, or regrouped. */
  | 'deleted'
  /** `restore` or `purge` named a Surface that is not a recovery-store root. */
  | 'not-deleted'
  /** A delete named a descendant set that is not the Surface's actual one, or
   *  omitted the disposition a non-empty parent requires (R6/AE6). */
  | 'descendant-mismatch'

export type SurfaceTopologyResult =
  | { applied: true; topologyRev: number; surfaces: Surface[] }
  | { applied: false; reason: SurfaceRejection; topologyRev: number }

/**
 * A VALIDATED topology change that has not been installed anywhere.
 *
 * This is the seam KTD7 needs and U1 did not have. The eager mutators below
 * write live state and emit in one step, which is correct for the single-writer
 * boot and migration paths but cannot satisfy "the service durably commits the
 * candidate snapshot before replacing in-memory state or acknowledging": by the
 * time a failed durable write returned, clients would already have seen the
 * batch. So every mutation is now two halves — `plan*` validates and computes
 * the resulting records against live state WITHOUT touching it, and
 * {@link SurfaceStore.applyPlan} installs and emits. The mutation service puts a
 * durable commit between them; boot and migration call them back to back.
 */
export interface SurfaceTopologyPlan {
  spaceId: string
  /** The space topology revision the plan was computed against. */
  baseTopologyRev: number
  /** The revision after applying it. */
  topologyRev: number
  /** Records to write, in EMIT ORDER — a new parent precedes the children moved
   *  under it, so an ordered consumer never sees a child pointing at a home it has
   *  not been told about. */
  records: Surface[]
  /** Ids to erase. Only `planPurge` and the lifecycle cascade produce these. */
  purged: string[]
  /** Expected revisions for the durable compare-and-swap, keyed by id. `0` states
   *  "this record should not exist yet", which is how a create declares itself. */
  expectedRevs: Record<string, number>
  /**
   * RE-ASSERT every precondition this plan was built on, against live state, and
   * return a plan recomputed against it.
   *
   * This is the plan/apply seam's safety property and the reason a plan is not
   * plain data. Planning runs OUTSIDE the durable transaction queue (deliberately
   * — putting it inside would serialize every mutation in a space behind a whole
   * file rewrite), so live state is free to move between validation and install.
   * The durable half calls this immediately before it writes, from inside the
   * queue, and refuses the transaction if anything moved.
   *
   * It is EXHAUSTIVE by construction rather than by discipline: it re-runs the
   * very same planning routine that produced this plan, with the very same
   * arguments, and then compares the two outcomes. There is no second list of
   * checks to keep in step with the first — adding a check to a `plan*` method
   * adds it here in the same edit.
   *
   * The recomputed plan is what the caller should install: the topology revision
   * is allocated HERE, at commit time, so two mutations planned against the same
   * base cannot claim the same number.
   */
  revalidate: () => SurfacePlanResult
}

/** A plan without its {@link SurfaceTopologyPlan.revalidate} closure — what the
 *  `compute*` routines build. `planned` attaches the closure so that every plan,
 *  from every mutation, is re-assertable the same way. */
type PlanCore = Omit<SurfaceTopologyPlan, 'revalidate'>

type PlanOutcome =
  | { applied: true; plan: PlanCore }
  | { applied: false; reason: SurfaceRejection; topologyRev: number }

type PlanComputation = () => PlanOutcome

export type SurfacePlanResult =
  | { applied: true; plan: SurfaceTopologyPlan }
  | { applied: false; reason: SurfaceRejection; topologyRev: number }

/** Compare-and-swap inputs shared by every topology mutation (plan KTD7).
 *  Both expectations are OPTIONAL because the migration and boot paths are
 *  single-writer and have nothing to race against; an interactive caller that
 *  omits them is choosing last-write-wins, exactly as a `PinSet` PUT without a
 *  bumped `rev` would be. */
export interface SurfaceTopologyOpts {
  /** The space topology revision the caller believes it read. */
  expectedTopologyRev?: number
  /** Per-Surface expected revisions, keyed by Surface id. */
  expectedRevs?: Record<string, number>
  /** Epoch ms stamp for the mutation (injectable so tests are not time-dependent). */
  at?: number
}

/** Extra compare-and-swap inputs a delete carries (R6/AE6).
 *
 *  `descendants` is a revision check on WHAT THE HUMAN WAS SHOWN, not a
 *  convenience: a confirmation built before a child arrived would otherwise take
 *  that child with it, and the human would have agreed to a different deletion
 *  than the one that happened. It is the full transitive set, at every depth,
 *  because that is what "affected descendants" means for a subtree delete and
 *  what a reparent-children delete has to have counted to know it is safe. */
export interface SurfaceDeleteOpts extends SurfaceTopologyOpts {
  descendants?: string[]
  disposition?: SurfaceDeleteDisposition
  /** Who performed it. Recorded on the deletion marker so a recovery list can say
   *  "an agent deleted this" rather than presenting an anonymous tombstone. */
  by?: SurfacePrincipalRef
}

/** Everything needed to mint a Surface. Identity, revisions, and the derived
 *  timestamps are HOST-assigned and deliberately absent — per the plan's Canonical
 *  Field Authority table, identity and revision are "never accepted from mutable
 *  request fields". `id` is the one exception, and only so migration can install a
 *  DERIVED legacy identity (see {@link deriveLegacySurfaceId}) rather than a random
 *  one that would change on every re-run. */
export interface SurfaceInit {
  id?: string
  spaceId: string
  home: SurfaceHome
  content: SurfaceContent
  /** Defaults to `source-binding` when a source is supplied, `canonical-direct`
   *  otherwise — the only default that does not silently hand authority to a
   *  source that does not exist. */
  contentAuthority?: SurfaceContentAuthority
  author?: PointAuthor
  order?: number
  source?: SurfaceSourceBinding
  provenance?: SurfaceProvenance
  owner?: SurfacePrincipalRef
  /** Seeded thread. `status` is DERIVED from the replies, never supplied. */
  thread?: { replies?: Reply[]; resolvedAt?: number; dismissedAt?: number }
  freshness?: Partial<SurfaceFreshness>
  aliases?: SurfaceCompatAlias[]
  compatibilityOnly?: boolean
  createdAt?: number
}

/** A fresh global Surface identity. Random, not derived: a Surface created by a
 *  human or an agent has no natural key, and reusing one would resurrect a dead
 *  Surface's thread under a new card. The `sf-` prefix makes an id self-describing
 *  in a log line or a snapshot. */
export function newSurfaceId(): string {
  return 'sf-' + randomUUID()
}

/**
 * Derive the immutable INCARNATION of a legacy run — the identity of "this run,
 * this time" (plan U1). New runs get a random incarnation UUID at creation; a run
 * that predates that field has to have one reconstructed, and it must come out the
 * same on every boot or migration would mint fresh Surface ids each restart and
 * orphan every thread.
 *
 * `createdAt` is in the basis for one specific reason: a run id is a tmux session
 * name, which a user is free to delete and recreate. Hashing the name alone would
 * hand the new run the old run's Surface identities — inheriting a stranger's
 * threads and provenance. Two runs that share a name at different times have
 * different creation stamps and therefore different incarnations.
 *
 * SPACE IS DELIBERATELY NOT IN THE BASIS, though an early draft of the plan said
 * it should be. Three reasons, any one of them sufficient:
 *   · `Run.spaceId` is OPTIONAL, so requiring it would quarantine every space-less
 *     run — the exact population migration exists to rescue;
 *   · it adds no uniqueness. A run id is already unique across the install, so the
 *     space is a function of the run, not an independent coordinate;
 *   · it would make identity MOVABLE. If a run ever changed space, every Surface it
 *     owns would derive a different id and the whole run would migrate again as a
 *     duplicate set — precisely the "identity must never change" property this
 *     derivation exists to guarantee.
 *
 * Returns `null` when any input is missing, INSTEAD of substituting a placeholder.
 * The plan requires missing derivation inputs to be quarantined rather than
 * guessed, and a guessed incarnation is indistinguishable from a real one forever
 * after. The caller decides what quarantine means; this function only refuses.
 */
export function deriveRunIncarnation(
  runId: string | undefined,
  createdAt: string | undefined,
): string | null {
  if (!runId || !createdAt) return null
  const basis = JSON.stringify({ runId, createdAt })
  return 'inc-' + createHash('sha256').update(basis).digest('hex').slice(0, 24)
}

/**
 * The global Surface id for a legacy point, from a run incarnation plus the point's
 * RUN-LOCAL id. Deterministic, so repeated migration boots converge on one identity
 * instead of duplicating every point.
 *
 * The incarnation is what makes this safe. Local ids are slugs agents naturally
 * reuse (`decisions`, `blockers`, `objective`), so two runs routinely hold the same
 * local id for entirely unrelated surfaces; combining with the incarnation is what
 * gives them different global ids instead of colliding into one record.
 */
export function deriveLegacySurfaceId(incarnation: string, localId: string): string {
  const basis = JSON.stringify({ incarnation, localId })
  return 'sf-lg-' + createHash('sha256').update(basis).digest('hex').slice(0, 24)
}

/** The child-index key for a home. A NUL joins the discriminator to the id so the
 *  three cases can never collide (a space named `surface` and a Surface id are both
 *  arbitrary strings). Written as a unicode escape, not a raw byte: a raw NUL makes
 *  git treat the source file as binary. */
export function homeKey(home: SurfaceHome): string {
  if (home.kind === 'canvas') return 'canvas\u0000' + home.spaceId
  if (home.kind === 'recovery') return 'recovery\u0000' + home.spaceId
  return 'surface\u0000' + home.surfaceId
}

function sameHome(a: SurfaceHome, b: SurfaceHome): boolean {
  return homeKey(a) === homeKey(b)
}

/** Deterministic sibling order: explicit `order` when set, else creation time, with
 *  an id tiebreak. The tiebreak is not cosmetic — a migration creates every Surface
 *  of a run with one `now`, so ties are the COMMON case, and without it a rebuilt
 *  index could order siblings differently than the live one it is supposed to
 *  reproduce. */
function compareSiblings(a: Surface, b: Surface): number {
  const rank = (s: Surface) => s.order ?? s.createdAt
  return rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Rebuild the derived topology from a flat record list: parent→children indexes
 * and the per-space topology revision.
 *
 * PURE and exported because parent→children indexes ARE the reload contract: if
 * they could not be reconstructed exactly from the records, the sidecar would need
 * a second, separately-maintained copy of the tree — and the two would eventually
 * disagree.
 *
 * `topologyRevs` IS NOT THAT. It is a FLOOR, not the revision. KTD5 originally had
 * the space topology revision reconstruct as `max(homeRev)` over the records, on
 * the premise that no record is ever erased (KTD15 made deletion a move). `purge`,
 * added in U3 under KTD15, erases — so the premise expired, and a derived revision
 * runs BACKWARDS across a purge, which makes `expectedTopologyRev` fail the two
 * properties a compare-and-swap token needs (monotonicity and per-mutation
 * uniqueness). The revision is now a PERSISTED monotonic per-space counter owned by
 * {@link SurfaceStore}; what this function returns is only the lower bound a
 * snapshot with no stored counter must start from, so an older snapshot still
 * reloads into a revision no smaller than any record's `homeRev`. See the KTD5
 * amendment in the plan.
 */
export function buildTopologyIndex(records: Iterable<Surface>): {
  children: Map<string, string[]>
  topologyRevs: Map<string, number>
} {
  const bySiblingGroup = new Map<string, Surface[]>()
  const topologyRevs = new Map<string, number>()
  for (const s of records) {
    const key = homeKey(s.home)
    const bucket = bySiblingGroup.get(key)
    if (bucket) bucket.push(s)
    else bySiblingGroup.set(key, [s])
    topologyRevs.set(s.spaceId, Math.max(topologyRevs.get(s.spaceId) ?? 0, s.homeRev))
  }
  const children = new Map<string, string[]>()
  for (const [key, group] of bySiblingGroup) {
    children.set(key, group.sort(compareSiblings).map(s => s.id))
  }
  return { children, topologyRevs }
}

/** Whole-record equality. Mirrors `pointEqual` in `slate.ts`, including its caveat:
 *  `JSON.stringify` compares key ORDER too, so a candidate built by spreading the
 *  prior record (which is how every caller builds one) compares correctly, while a
 *  hand-rebuilt object with reshuffled keys reads as changed. */
function surfaceEqual(a: Surface, b: Surface): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** True when a candidate differs from the stored record only in BOOKKEEPING —
 *  `rev` and `amendedAt`. Neither changes what any client renders, so emitting for
 *  them would wake every SSE subscriber for nothing. This is the same file-watch
 *  storm guard `SlateStore.applyProjection` gets from re-projecting to a byte-equal
 *  point, moved to where it belongs now that the caller (not the store) computes
 *  the candidate and will have bumped both fields on the way in. */
function onlyBookkeepingChanged(prior: Surface, next: Surface): boolean {
  return surfaceEqual(prior, { ...next, rev: prior.rev, amendedAt: prior.amendedAt })
}

/** Expected DURABLE revisions for a set of records about to be rewritten — their
 *  revisions BEFORE the plan bumped them. */
function expectedFrom(records: Surface[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of records) out[r.id] = r.rev
  return out
}

/**
 * The part of a plan that must not move between planning and installing.
 *
 * Everything a mutation DECIDES is in here: which records are written, what they
 * are written to, which ids are erased, and what durable revisions the transaction
 * asserts. Two fields are deliberately out:
 *   · `homeRev`, because the topology revision is ALLOCATED at commit time now —
 *     re-deriving a different one is the correction, not a conflict;
 *   · the two plan-level revisions, for the same reason.
 * Timestamps are not excluded and do not need to be: a plan freezes its `at` stamp
 * when it is first computed and the re-computation reuses it, so a re-run differs
 * from the original in `homeRev` and in nothing else unless the world moved.
 */
function planFingerprint(plan: PlanCore): string {
  return JSON.stringify({
    records: plan.records.map(r => ({ ...r, homeRev: 0 })),
    purged: [...plan.purged].sort(),
  })
}

/** Set equality over ids, order-independent and duplicate-tolerant. A caller that
 *  listed the same descendant twice still described the same set, and refusing it
 *  would be pedantry rather than safety. */
function sameIdSet(a: string[], b: string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size !== right.size) return false
  for (const id of left) if (!right.has(id)) return false
  return true
}

/** Add the `workspace-recovery` compatibility alias if the Surface lacks one.
 *  Used when a restore cannot reach its former home: KTD3 defines that bucket as
 *  the flat fallback for a Surface whose original context is gone, so a Surface
 *  that lands on the Canvas for want of anywhere else is exactly its population. */
function withRecoveryAlias(s: Surface): SurfaceCompatAlias[] {
  const existing = s.aliases ?? []
  if (existing.some(a => a.bucket.kind === 'workspace-recovery')) return existing
  return [...existing, { bucket: { kind: 'workspace-recovery' }, localId: s.id, visible: true }]
}

export class SurfaceStore {
  /** Every canonical Surface, keyed by its GLOBAL id. No composite key — unlike
   *  `SlateStore`, whose point ids are unique only within a run, a Surface id is
   *  unique everywhere, which is exactly what lets one move between homes (and
   *  eventually between the Canvas and a Run Workspace) without changing identity. */
  private surfaces = new Map<string, Surface>()

  /** DERIVED: home key → ordered child ids. Recomputed from the records by
   *  {@link reindex}, never written directly, so the live index and a reload of the
   *  same records cannot drift apart. */
  private childIndex = new Map<string, string[]>()

  /**
   * spaceId → topology revision. AUTHORITATIVE and MONOTONIC, not derived.
   *
   * It is allocated here, persisted in the sidecar snapshot alongside the records,
   * and only ever raised — {@link reindex} may lift it to the floor a rebuild
   * implies but can never lower it. That is what makes `expectedTopologyRev` an
   * actual compare-and-swap token: `purge` erases records, so a revision derived
   * from the surviving records would run backwards and let a stale expectation
   * match a topology it never saw (ABA). See {@link buildTopologyIndex}.
   */
  private topologyRevs = new Map<string, number>()

  constructor(private readonly emit: EmitFn) {}

  // --- Reads ---

  getSurface(id: string): Surface | undefined {
    return this.surfaces.get(id)
  }

  getAllSurfaces(): Surface[] {
    return [...this.surfaces.values()]
  }

  getSurfacesForSpace(spaceId: string): Surface[] {
    return [...this.surfaces.values()].filter(s => s.spaceId === spaceId)
  }

  /** A Surface's immediate children in deterministic sibling order. Empty for a
   *  leaf — which is not a different kind of record, just one nothing is homed on. */
  getChildren(id: string): Surface[] {
    return this.resolveChildren(homeKey({ kind: 'surface', surfaceId: id }))
  }

  /** The space's top-level Surfaces: those homed on the Canvas itself (R29). */
  getRoots(spaceId: string): Surface[] {
    return this.resolveChildren(homeKey({ kind: 'canvas', spaceId }))
  }

  /** Ancestors nearest-first, stopping at the Canvas or the recovery store.
   *  Bounded by the record count so a cycle that reached the store through a
   *  corrupt snapshot degrades into a truncated chain instead of hanging the
   *  server — the mutation path rejects cycles, but a hydrated file has never been
   *  through it. */
  getAncestors(id: string): Surface[] {
    const out: Surface[] = []
    let cursor = this.surfaces.get(id)
    for (let hops = 0; cursor && hops <= this.surfaces.size; hops++) {
      if (cursor.home.kind !== 'surface') break
      const parent = this.surfaces.get(cursor.home.surfaceId)
      if (!parent || parent.id === id) break
      out.push(parent)
      cursor = parent
    }
    return out
  }

  /** Every descendant at every depth, parents before their own children. Bounded
   *  by the record count, for the same reason {@link getAncestors} is: a cycle that
   *  arrived through a corrupt snapshot must degrade, not hang. */
  getDescendants(id: string): Surface[] {
    const out: Surface[] = []
    const seen = new Set<string>([id])
    const queue = [id]
    while (queue.length > 0 && out.length <= this.surfaces.size) {
      const next = queue.shift()!
      for (const child of this.getChildren(next)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        out.push(child)
        queue.push(child.id)
      }
    }
    return out
  }

  /** The space's recovery store: the roots of every deleted subtree, in sibling
   *  order. What a "recently deleted" list renders and what `restore` picks from. */
  getRecoveryRoots(spaceId: string): Surface[] {
    return this.resolveChildren(homeKey({ kind: 'recovery', spaceId }))
  }

  /**
   * The recovery-store root governing a Surface, if it is deleted — itself when it
   * IS the root, an ancestor when it moved along with one, `undefined` when it is
   * live.
   *
   * This is how "is this deleted" is answered without stamping a marker on every
   * descendant. Stamping would bump every descendant's revision on a delete, and
   * then a restore would have to find and clear exactly the right ones; walking up
   * costs a bounded ancestor hop and cannot get out of step with the tree.
   */
  recoveryRootFor(id: string): Surface | undefined {
    const self = this.surfaces.get(id)
    if (!self) return undefined
    if (self.home.kind === 'recovery') return self
    for (const ancestor of this.getAncestors(id)) {
      if (ancestor.home.kind === 'recovery') return ancestor
    }
    return undefined
  }

  /** The space's current topology revision; 0 for a space with no Surfaces. */
  getTopologyRev(spaceId: string): number {
    return this.topologyRevs.get(spaceId) ?? 0
  }

  /** Every space's topology revision, for the durable snapshot. The counter is no
   *  longer derivable from the records (see {@link buildTopologyIndex}), so it has
   *  to be persisted; this is what the sidecar stores. */
  topologyRevSnapshot(): Record<string, number> {
    return Object.fromEntries(this.topologyRevs)
  }

  /**
   * Seed records from a persisted snapshot. HYDRATION, NOT A MUTATION: it emits
   * nothing (there is no client yet to tell) and does not bump any revision — the
   * revisions come back off the records themselves.
   *
   * Records missing the fields the topology is built from are skipped rather than
   * installed, mirroring `SlateStore.loadPoints`: a record with no id or no home
   * cannot be indexed, addressed, or repaired, and admitting it would corrupt the
   * derived indexes for every well-formed record around it.
   *
   * `topologyRevs` is the persisted monotonic counter from the same snapshot. It is
   * OPTIONAL because a snapshot written before U3 does not carry one: absent, the
   * counter starts at the floor {@link buildTopologyIndex} derives, which is
   * exactly the old behaviour and never smaller than any record's `homeRev`.
   */
  load(records: Surface[], topologyRevs?: Record<string, number>): void {
    for (const s of records) {
      if (!s || !s.id || !s.spaceId || !s.home) continue
      this.surfaces.set(s.id, s)
    }
    for (const [spaceId, rev] of Object.entries(topologyRevs ?? {})) {
      if (typeof rev !== 'number' || !Number.isFinite(rev)) continue
      this.raiseTopologyRev(spaceId, rev)
    }
    this.reindex()
  }

  // --- Content mutation ---

  /**
   * Write an updated whole record. Returns whether the write was APPLIED, mirroring
   * the `upsertConstellationGraph` / `upsertPinSet` contract, so a caller surfaces a
   * conflict instead of reporting a false success.
   *
   * Refused, all as `false`:
   *   · an unknown id — creation goes through {@link createSurface}, which is the
   *     only path that validates the home and bumps the topology revision;
   *   · a change to `spaceId`, `home`, `homeRev`, or `order` — those four ARE the
   *     topology ("home and sibling order … changed only by atomic topology
   *     mutation"), and letting a content write carry them would route a reparent
   *     around every cycle and cross-space check in this file. Note the
   *     consequence: this unit ships no way to CHANGE `order` after creation. A
   *     reorder primitive is a topology mutation and belongs with the mutation
   *     service that owns the ordering UX; it is deliberately absent rather than
   *     smuggled in through the content path;
   *   · a revision that is not NEWER than the stored one. An older write arriving
   *     after a newer one is a stale intent; dropping it keeps the latest intent
   *     authoritative regardless of arrival order, and equal-revision rejection
   *     also short-circuits redundant re-PUTs;
   *   · a candidate that changes nothing but `rev`/`amendedAt` (see
   *     {@link onlyBookkeepingChanged}) — the storm guard.
   */
  upsertSurface(next: Surface): boolean {
    if (this.checkUpsert(next)) return false
    const prior = this.surfaces.get(next.id)!
    this.surfaces.set(next.id, next)
    // No reindex needed, and that is a guarantee rather than an optimisation: the
    // four topology fields are all rejected above, so neither sibling membership
    // nor sibling order can have moved.
    this.emitBatch(prior.spaceId, [next])
    return true
  }

  /**
   * Would {@link upsertSurface} accept this candidate? The reason it would refuse,
   * or `undefined`.
   *
   * Extracted so the DURABLE half can re-assert the same predicates inside its
   * transaction queue immediately before it writes, rather than re-deriving them.
   * `upsertSurface` is this function plus the install, so the two cannot drift.
   *
   * The bookkeeping-only case is the one that mattered: a content write whose
   * candidate differs from the stored record ONLY in `rev`/`amendedAt` is refused
   * by the storm guard, and a durable layer that wrote it anyway would leave the
   * durable revision ahead of the live one — permanently refusing every later write
   * to that record. It is a rejection, not a silent no-op, precisely so no caller
   * can commit it.
   */
  checkUpsert(next: Surface): SurfaceRejection | undefined {
    const prior = this.surfaces.get(next.id)
    if (!prior) return 'unknown-surface'
    if (next.spaceId !== prior.spaceId) return 'cross-space'
    if (!sameHome(next.home, prior.home)) return 'recovery-home'
    if (next.homeRev !== prior.homeRev) return 'stale-topology-revision'
    if (next.order !== prior.order) return 'stale-surface-revision'
    if (next.rev <= prior.rev) return 'stale-surface-revision'
    if (onlyBookkeepingChanged(prior, next)) return 'no-change'
    return undefined
  }

  /**
   * Force a durably-committed record into memory and tell every client.
   *
   * The repair path for a corrupted invariant, and nothing else. A record that is
   * on disk but not in memory is not a no-op — it is a store that will refuse every
   * subsequent write to that id forever, because the durable revision has moved
   * past the live one and re-reading returns the stale copy. When the durable half
   * discovers that state it makes memory agree with disk here (disk is the
   * authority) and THEN raises, so the divergence is repaired and loud rather than
   * silently absorbed.
   */
  reconcileDurable(next: Surface): void {
    this.surfaces.set(next.id, next)
    this.reindex()
    this.emitBatch(next.spaceId, [next])
  }

  // --- Topology mutation ---
  //
  // Every mutation here is TWO halves: a `plan*` that validates against live state
  // and computes the resulting records without touching anything, and
  // {@link applyPlan}, which installs those records and emits one batch. The eager
  // wrappers (`createSurface`, `reparent`, `group`) run both back to back and are
  // what the single-writer boot and migration paths call. The mutation service
  // puts a durable commit BETWEEN the halves, which is the only way to satisfy
  // KTD7's "durably commits the candidate snapshot before replacing in-memory
  // state or acknowledging" — with one fused step, a failed write would already
  // have been broadcast.
  //
  // THE GAP THAT LEAVES, AND HOW IT IS CLOSED. Because planning happens outside the
  // durable transaction queue, live state is free to move while the commit is in
  // flight — and the sidecar's whole-file rewrite is not a short window (U1's own
  // measurement: p95 259ms at ~10 MiB, queued, so N concurrent mutations make it
  // N x that). Work created or moved into a subtree during a delete's commit used
  // to be swallowed into the recovery store with no deletion marker: invisible to
  // `list()`, absent from the recovery roots, and then erased by a later `purge`
  // the human agreed to for a different, smaller subtree.
  //
  // The fix is NOT to move planning inside the queue — that would serialize every
  // mutation in a space behind a whole-file write, and it was rejected for that
  // reason. Instead every plan carries {@link SurfaceTopologyPlan.revalidate},
  // which re-runs THE SAME computation against live state from inside the queue,
  // immediately before the durable write. One routine, invoked twice; there is no
  // second list of checks that could fall behind the first.
  //
  // Each `plan*` below therefore does two things before computing anything: it
  // FREEZES the inputs that would otherwise differ between the two runs (the `at`
  // stamp, and a minted id), and it hands the computation to `planned`.

  /**
   * Mint a Surface at a home. A create IS a topology change — it adds a node to the
   * tree — so it validates the home, bumps the space topology revision, and emits
   * the same batch shape a move does.
   */
  createSurface(init: SurfaceInit, opts: SurfaceTopologyOpts = {}): SurfaceTopologyResult {
    return this.runPlan(this.planCreate(init, opts))
  }

  planCreate(init: SurfaceInit, opts: SurfaceTopologyOpts = {}): SurfacePlanResult {
    // Frozen so a re-computation is comparable: a fresh id or a fresh clock would
    // make every re-run differ from the original for reasons that are not conflicts.
    const seeded: SurfaceInit = { ...init, id: init.id ?? newSurfaceId() }
    const frozen = this.freeze(opts)
    return this.planned(() => this.computeCreate(seeded, frozen))
  }

  private computeCreate(init: SurfaceInit, opts: SurfaceTopologyOpts): PlanOutcome {
    const spaceId = init.spaceId
    const rev = this.getTopologyRev(spaceId)
    const id = init.id!
    if (this.surfaces.has(id)) return { applied: false, reason: 'duplicate-id', topologyRev: rev }
    const homeCheck = this.checkHome(init.home, spaceId, new Set([id]))
    if (homeCheck) return { applied: false, reason: homeCheck, topologyRev: rev }
    if (opts.expectedTopologyRev !== undefined && opts.expectedTopologyRev !== rev) {
      return { applied: false, reason: 'stale-topology-revision', topologyRev: rev }
    }
    const now = opts.at!
    const created = this.materialize(id, init, now, rev + 1)
    // `0` states "this record should not exist yet" — the durable half's way of
    // making a create a compare-and-swap rather than a blind write. The DESTINATION
    // carries its own expectation alongside it: without one, a create into a home
    // that is being deleted passes a durable compare-and-swap over a disjoint record
    // set and lands the new Surface inside the recovery store.
    return {
      applied: true,
      plan: this.makePlan(spaceId, rev, rev + 1, [created], [], {
        [id]: 0,
        ...this.expectedHome(init.home),
      }),
    }
  }

  /** Move ONE Surface to a new home. Thin alias over {@link reparent} — a single
   *  move and a group move must not be able to validate differently. */
  setHome(id: string, home: SurfaceHome, opts: SurfaceTopologyOpts = {}): SurfaceTopologyResult {
    return this.reparent([id], home, opts)
  }

  /**
   * Move a set of Surfaces under one home ATOMICALLY: every id is validated before
   * any is written, so a rejected member leaves the whole tree untouched rather
   * than half-moved. This is also the ungroup primitive (move the children up to
   * their grandparent's home) — R23's "reparent the canonical surface rather than
   * copying it", in both directions.
   *
   * Identity, revision lineage, thread, provenance, and per-user view state are all
   * untouched: a move rewrites `home`, `homeRev`, `rev`, and `amendedAt` and
   * nothing else (AE1/R22).
   */
  reparent(ids: string[], home: SurfaceHome, opts: SurfaceTopologyOpts = {}): SurfaceTopologyResult {
    return this.runPlan(this.planReparent(ids, home, opts))
  }

  planReparent(ids: string[], home: SurfaceHome, opts: SurfaceTopologyOpts = {}): SurfacePlanResult {
    const frozen = this.freeze(opts)
    return this.planned(() => this.computeReparent(ids, home, frozen))
  }

  private computeReparent(ids: string[], home: SurfaceHome, opts: SurfaceTopologyOpts): PlanOutcome {
    const unique = [...new Set(ids)]
    const moving: Surface[] = []
    for (const id of unique) {
      const s = this.surfaces.get(id)
      // `topologyRev: 0` here is "unknown", not "the space is at zero": with an
      // unresolvable id there is no space to report a revision for. A caller
      // retrying on a conflict must re-read; a caller that named a ghost has a bug.
      if (!s) return { applied: false, reason: 'unknown-surface', topologyRev: 0 }
      moving.push(s)
    }
    if (moving.length === 0) return { applied: false, reason: 'unknown-surface', topologyRev: 0 }

    const spaceId = moving[0]!.spaceId
    const rev = this.getTopologyRev(spaceId)
    // A single batch is single-space by construction, so a set spanning two spaces
    // is rejected here rather than silently split into two half-transactions.
    if (moving.some(s => s.spaceId !== spaceId)) {
      return { applied: false, reason: 'cross-space', topologyRev: rev }
    }
    // A deleted Surface must be restored before it can be arranged. Moving one
    // straight out of the recovery store would be an undo with no revision check
    // and no record that it ever happened.
    if (moving.some(s => this.recoveryRootFor(s.id))) {
      return { applied: false, reason: 'deleted', topologyRev: rev }
    }
    const homeCheck = this.checkHome(home, spaceId, new Set(unique))
    if (homeCheck) return { applied: false, reason: homeCheck, topologyRev: rev }

    const gate = this.checkRevisions(moving, spaceId, opts)
    if (gate) return { applied: false, reason: gate, topologyRev: rev }

    const changed = moving.filter(s => !sameHome(s.home, home))
    if (changed.length === 0) return { applied: false, reason: 'no-change', topologyRev: rev }

    const now = opts.at!
    const nextRev = rev + 1
    const written = changed.map(prior => this.rehome(prior, home, nextRev, now))
    // The DESTINATION carries an expectation too. Without one, a reparent into a
    // home deleted during the commit window passes its durable compare-and-swap
    // (the two record sets are disjoint) and leaves a live subtree inside the
    // recovery store with no deletion marker on it.
    return {
      applied: true,
      plan: this.makePlan(spaceId, rev, nextRev, written, [], {
        ...expectedFrom(changed),
        ...this.expectedHome(home),
      }),
    }
  }

  /**
   * Group existing siblings under a NEW parent Surface, in one transaction and one
   * emitted batch (F2/AE1). The parent inherits the children's shared home, so the
   * group appears exactly where the children were.
   *
   * Requiring a SHARED home (rather than reparenting from anywhere) is deliberate:
   * "group these" means folding siblings into a box, and gathering Surfaces from
   * scattered homes is a multi-move the caller should have to state explicitly —
   * silently pulling a Surface out of a parent the user built is a different
   * operation with a different blast radius.
   */
  group(
    childIds: string[],
    parent: Omit<SurfaceInit, 'spaceId' | 'home' | 'id'> & { id?: string },
    opts: SurfaceTopologyOpts = {},
  ): SurfaceTopologyResult {
    return this.runPlan(this.planGroup(childIds, parent, opts))
  }

  planGroup(
    childIds: string[],
    parent: Omit<SurfaceInit, 'spaceId' | 'home' | 'id'> & { id?: string },
    opts: SurfaceTopologyOpts = {},
  ): SurfacePlanResult {
    const seeded = { ...parent, id: parent.id ?? newSurfaceId() }
    const frozen = this.freeze(opts)
    return this.planned(() => this.computeGroup(childIds, seeded, frozen))
  }

  private computeGroup(
    childIds: string[],
    parent: Omit<SurfaceInit, 'spaceId' | 'home' | 'id'> & { id: string },
    opts: SurfaceTopologyOpts,
  ): PlanOutcome {
    const unique = [...new Set(childIds)]
    const children: Surface[] = []
    for (const id of unique) {
      const s = this.surfaces.get(id)
      // `topologyRev: 0` here is "unknown", not "the space is at zero": with an
      // unresolvable id there is no space to report a revision for. A caller
      // retrying on a conflict must re-read; a caller that named a ghost has a bug.
      if (!s) return { applied: false, reason: 'unknown-surface', topologyRev: 0 }
      children.push(s)
    }
    if (children.length === 0) return { applied: false, reason: 'unknown-surface', topologyRev: 0 }

    const spaceId = children[0]!.spaceId
    const rev = this.getTopologyRev(spaceId)
    if (children.some(s => s.spaceId !== spaceId)) {
      return { applied: false, reason: 'cross-space', topologyRev: rev }
    }
    const home = children[0]!.home
    if (children.some(s => !sameHome(s.home, home))) {
      return { applied: false, reason: 'mixed-home', topologyRev: rev }
    }
    // Their shared home being the recovery store means every one of them is
    // deleted; grouping there would build a parent nobody can reach.
    if (home.kind === 'recovery' || children.some(s => this.recoveryRootFor(s.id))) {
      return { applied: false, reason: 'deleted', topologyRev: rev }
    }
    const parentId = parent.id
    if (this.surfaces.has(parentId)) {
      return { applied: false, reason: 'duplicate-id', topologyRev: rev }
    }
    const gate = this.checkRevisions(children, spaceId, opts)
    if (gate) return { applied: false, reason: gate, topologyRev: rev }

    const now = opts.at!
    const nextRev = rev + 1
    const created = this.materialize(parentId, { ...parent, id: parentId, spaceId, home }, now, nextRev)
    const newHome: SurfaceHome = { kind: 'surface', surfaceId: parentId }
    const moved = children.map(prior => this.rehome(prior, newHome, nextRev, now))
    // Parent first in the batch so an ordered consumer never sees a child pointing
    // at a home it has not been told about yet.
    return {
      applied: true,
      plan: this.makePlan(spaceId, rev, nextRev, [created, ...moved], [], {
        [parentId]: 0,
        ...expectedFrom(children),
        // The shared home gains the new parent and loses the children, so it is a
        // destination like any other and carries its own expectation.
        ...this.expectedHome(home),
      }),
    }
  }

  // --- Recoverable deletion (plan KTD15) ---
  //
  // There is no proposal or approval step anywhere in this file, and that is the
  // ratified product decision rather than an omission: agents create, group,
  // reparent and delete directly, and safety comes from the fact that a delete is
  // UNDOABLE. Concretely, `planDelete` re-homes the subtree ROOT into the space's
  // recovery store inside the same transaction that would otherwise have destroyed
  // it. The descendants do not move at all — they keep pointing at their own
  // parents, so the subtree stays assembled and "is this deleted" is answered by
  // walking up to a recovery home.
  //
  // Not moving descendants is what makes NESTED deletion behave. Delete a child,
  // then delete its parent: two independent recovery roots, because the child left
  // the parent's child list when it was deleted. Restoring the parent restores
  // exactly what it still held, instead of resurrecting a child somebody deleted on
  // purpose.

  /**
   * Move a Surface (and whatever still hangs off it) into the recovery store.
   *
   * A non-empty parent requires BOTH the exact set of descendants the caller
   * displayed and a disposition (R6/AE6). The descendant set is a compare-and-swap
   * on what the human was shown: a confirmation dialog built before a child was
   * added must not silently take that child with it.
   */
  planDelete(id: string, opts: SurfaceDeleteOpts = {}): SurfacePlanResult {
    const frozen: SurfaceDeleteOpts = { ...opts, at: opts.at ?? Date.now() }
    return this.planned(() => this.computeDelete(id, frozen))
  }

  private computeDelete(id: string, opts: SurfaceDeleteOpts): PlanOutcome {
    const target = this.surfaces.get(id)
    if (!target) return { applied: false, reason: 'unknown-surface', topologyRev: 0 }
    const spaceId = target.spaceId
    const rev = this.getTopologyRev(spaceId)
    if (this.recoveryRootFor(id)) return { applied: false, reason: 'deleted', topologyRev: rev }

    const descendants = this.getDescendants(id)
    if (descendants.length > 0) {
      if (opts.disposition === undefined || opts.descendants === undefined) {
        return { applied: false, reason: 'descendant-mismatch', topologyRev: rev }
      }
    }
    if (opts.descendants !== undefined && !sameIdSet(opts.descendants, descendants.map(s => s.id))) {
      return { applied: false, reason: 'descendant-mismatch', topologyRev: rev }
    }

    const disposition: SurfaceDeleteDisposition = opts.disposition ?? 'delete-subtree'
    const promoted = disposition === 'reparent-children' ? this.getChildren(id) : []
    const affected = [...promoted, target]
    const gate = this.checkRevisions(affected, spaceId, opts)
    if (gate) return { applied: false, reason: gate, topologyRev: rev }

    const now = opts.at!
    const nextRev = rev + 1
    // Children first, then the root: an ordered consumer sees them re-homed onto
    // the grandparent before the root leaves the tree, never orphaned in between.
    const written = promoted.map(child => this.rehome(child, target.home, nextRev, now))
    written.push({
      ...target,
      home: { kind: 'recovery', spaceId },
      homeRev: nextRev,
      rev: target.rev + 1,
      amendedAt: now,
      deleted: {
        at: now,
        ...(opts.by ? { by: opts.by } : {}),
        formerHome: target.home,
        disposition,
      },
    })
    return {
      applied: true,
      plan: this.makePlan(spaceId, rev, nextRev, written, [], {
        ...expectedFrom(affected),
        // The home the target is leaving — and, under `reparent-children`, the home
        // the promoted children are landing on. Same record either way, and it is a
        // destination like any other.
        ...this.expectedHome(target.home),
      }),
    }
  }

  /**
   * The exact inverse: take a recovery-store root back to where it came from.
   *
   * A former home that no longer exists does NOT fail the restore. KTD15 is
   * explicit that it "lands in the workspace recovery bucket rather than failing",
   * so the Surface goes to the Canvas — the only home guaranteed to exist — and
   * gains the `workspace-recovery` compatibility alias KTD3 already defines for a
   * Surface whose original context is gone. Failing instead would leave a record
   * that can never be reached again, which is precisely the loss the recovery store
   * exists to prevent.
   */
  planRestore(id: string, opts: SurfaceTopologyOpts = {}): SurfacePlanResult {
    const frozen = this.freeze(opts)
    return this.planned(() => this.computeRestore(id, frozen))
  }

  private computeRestore(id: string, opts: SurfaceTopologyOpts): PlanOutcome {
    const target = this.surfaces.get(id)
    if (!target) return { applied: false, reason: 'unknown-surface', topologyRev: 0 }
    const spaceId = target.spaceId
    const rev = this.getTopologyRev(spaceId)
    if (target.home.kind !== 'recovery' || !target.deleted) {
      return { applied: false, reason: 'not-deleted', topologyRev: rev }
    }
    const gate = this.checkRevisions([target], spaceId, opts)
    if (gate) return { applied: false, reason: gate, topologyRev: rev }

    const former = target.deleted.formerHome
    const homeUsable = this.checkHome(former, spaceId, new Set([id])) === undefined
    const home: SurfaceHome = homeUsable ? former : { kind: 'canvas', spaceId }

    const now = opts.at!
    const nextRev = rev + 1
    // Destructure the deletion marker OFF rather than setting it undefined: an
    // `undefined` property survives in memory and disappears across JSON, so the
    // in-memory record and its reload would not be the same object.
    const { deleted: _cleared, ...rest } = target
    const restored: Surface = {
      ...rest,
      home,
      homeRev: nextRev,
      rev: target.rev + 1,
      amendedAt: now,
      ...(homeUsable ? {} : { aliases: withRecoveryAlias(target) }),
    }
    return {
      applied: true,
      plan: this.makePlan(spaceId, rev, nextRev, [restored], [], {
        ...expectedFrom([target]),
        // The home it is going back to. A restore into a home that is being deleted
        // would otherwise land the rescued Surface INSIDE the recovery store with
        // its own marker stripped — strictly less reachable than while it was
        // deleted, and the caller was told `ok`.
        ...this.expectedHome(home),
      }),
    }
  }

  /**
   * ERASE a recovery-store root and everything under it. The single irreversible
   * operation in the model, which is why it refuses anything that is not already in
   * the recovery store: purge is the second step of a decision, never the first.
   *
   * And why it demands the descendant set, exactly as `planDelete` does. The doomed
   * set is computed from the CURRENT tree, so anything that arrived under the
   * subtree after the human read the recovery list would be erased by a purge they
   * agreed to for a smaller blast radius. Naming the set makes that a refusal
   * instead of a silent loss — the irreversible operation must not be able to
   * exceed what the caller named.
   */
  planPurge(id: string, opts: SurfaceDeleteOpts = {}): SurfacePlanResult {
    const frozen: SurfaceDeleteOpts = { ...opts, at: opts.at ?? Date.now() }
    return this.planned(() => this.computePurge(id, frozen))
  }

  private computePurge(id: string, opts: SurfaceDeleteOpts): PlanOutcome {
    const target = this.surfaces.get(id)
    if (!target) return { applied: false, reason: 'unknown-surface', topologyRev: 0 }
    const spaceId = target.spaceId
    const rev = this.getTopologyRev(spaceId)
    if (target.home.kind !== 'recovery' || !target.deleted) {
      return { applied: false, reason: 'not-deleted', topologyRev: rev }
    }
    const gate = this.checkRevisions([target], spaceId, opts)
    if (gate) return { applied: false, reason: gate, topologyRev: rev }

    const descendants = this.getDescendants(id)
    if (descendants.length > 0 && opts.descendants === undefined) {
      return { applied: false, reason: 'descendant-mismatch', topologyRev: rev }
    }
    if (opts.descendants !== undefined && !sameIdSet(opts.descendants, descendants.map(s => s.id))) {
      return { applied: false, reason: 'descendant-mismatch', topologyRev: rev }
    }

    const doomed = [target, ...descendants]
    // A purge DOES advance the space's topology revision, even though it re-homes
    // nothing: records left the tree, so a client holding the previous revision no
    // longer describes the space. It can advance it because the revision is a
    // persisted monotonic counter rather than `max(homeRev)` over the survivors —
    // under the old derivation a purge LOWERED the number, which is what let a
    // stale `expectedTopologyRev` match a topology it had never seen. See the KTD5
    // amendment in the plan.
    return {
      applied: true,
      plan: this.makePlan(spaceId, rev, rev + 1, [], doomed.map(s => s.id), expectedFrom([target])),
    }
  }

  /**
   * Install a plan and emit its one batch.
   *
   * Separated from planning so a durable commit can sit between them. The plan's
   * `topologyRev` is INSTALLED as the space's counter (never lowering it), and the
   * emitted number is read back from the store afterwards, so what clients are told
   * is what the store actually holds.
   *
   * A plan should be {@link SurfaceTopologyPlan.revalidate}d against live state
   * before it reaches here whenever anything could have moved since it was computed
   * — which is every path except the single-writer boot and migration ones.
   */
  applyPlan(plan: SurfaceTopologyPlan): Surface[] {
    for (const record of plan.records) this.surfaces.set(record.id, record)
    for (const id of plan.purged) this.surfaces.delete(id)
    this.raiseTopologyRev(plan.spaceId, plan.topologyRev)
    this.reindex()
    this.emit({
      spaceId: plan.spaceId,
      baseTopologyRev: plan.baseTopologyRev,
      topologyRev: this.getTopologyRev(plan.spaceId),
      changes: plan.records.map(s => ({ entity: 'surface' as const, id: s.id, spaceId: s.spaceId, data: s })),
      ...(plan.purged.length > 0 ? { deletes: plan.purged } : {}),
    })
    return plan.records
  }

  // --- Lifecycle ---

  /** Silent bulk drop of a whole space, for the `clearSpace` cascade. Emits nothing
   *  (the caller emits one reset) and mirrors `SlateStore.deleteRunsSilently`. */
  clearSpaceSilently(spaceId: string): void {
    for (const [id, s] of this.surfaces) {
      if (s.spaceId === spaceId) this.surfaces.delete(id)
    }
    // The counter is NOT reset. Monotonic means monotonic: a space whose records
    // were cascaded away can be repopulated (a run recreated under the same space),
    // and restarting its revision at 0 would hand a client that still holds an old
    // token a number it could match against a topology it never saw. One integer
    // per space is not worth the ABA window.
    this.reindex()
  }

  /** Silent drop of named records, for the `clearSpace` cascade. Emits nothing —
   *  the caller emits one `all` reset, exactly as the Slate cascade does. This is
   *  the retract shape the change type deliberately left unbuilt until a unit
   *  needed one; note it is NOT a user "delete", which under KTD15 is a move into
   *  the recovery store and stays an ordinary revision-checked mutation. This path
   *  exists only for a space or run that no longer exists at all. */
  deleteSilently(ids: Iterable<string>): void {
    let removed = false
    for (const id of ids) removed = this.surfaces.delete(id) || removed
    if (removed) this.reindex()
  }

  /** Silent clear of everything, for the no-active-space `clear()` branch. The one
   *  place the topology counters DO reset, because this is a total reset of the
   *  store — equivalent to booting against an empty snapshot, which is a state the
   *  revision contract already has to survive. */
  clearAll(): void {
    this.surfaces.clear()
    this.childIndex.clear()
    this.topologyRevs.clear()
  }

  // --- Internals ---

  /**
   * Attach {@link SurfaceTopologyPlan.revalidate} to a computed plan.
   *
   * ONE routine, invoked twice. The closure re-runs the very computation that
   * produced the plan — same method, same frozen arguments — so a check added to a
   * `plan*` is re-asserted at commit time in the same edit that adds it. A second,
   * hand-written list of preconditions is exactly how the fifth of five checks goes
   * missing six months later, and a re-validation that covers four of five is worse
   * than none because the fifth becomes a bug nobody looks for again.
   */
  private planned(compute: PlanComputation): SurfacePlanResult {
    const first = compute()
    if (!first.applied) return first
    const plan: SurfaceTopologyPlan = {
      ...first.plan,
      revalidate: () => this.recheck(compute, plan),
    }
    return { applied: true, plan }
  }

  /**
   * Re-run a plan's computation against live state and report whether the decision
   * still holds.
   *
   * Three outcomes, and the third is the interesting one:
   *   · the recomputation is REFUSED — the world moved enough that the mutation is
   *     no longer legal at all (the home was deleted, the descendant set changed,
   *     the caller's expected revision is stale). Its own reason is returned;
   *   · the recomputation DECIDES SOMETHING ELSE — same legality, different effect
   *     (a restore whose former home vanished now lands on the Canvas). Refused as
   *     a conflict, because the caller was answered about the first decision;
   *   · it agrees. The FRESH plan is returned, not the original, because the
   *     topology revision is allocated here — at commit time — so two mutations
   *     planned against the same base cannot both claim `base + 1`.
   */
  private recheck(compute: PlanComputation, original: SurfaceTopologyPlan): SurfacePlanResult {
    const fresh = compute()
    if (!fresh.applied) return fresh
    const rev = this.getTopologyRev(original.spaceId)
    // Split before the whole-plan comparison purely so the caller gets the accurate
    // reason: a moved record revision is a per-record conflict, everything else is
    // the space's topology having moved underneath the plan.
    if (JSON.stringify(fresh.plan.expectedRevs) !== JSON.stringify(original.expectedRevs)) {
      return { applied: false, reason: 'stale-surface-revision', topologyRev: rev }
    }
    if (planFingerprint(fresh.plan) !== planFingerprint(original)) {
      return { applied: false, reason: 'stale-topology-revision', topologyRev: rev }
    }
    return { applied: true, plan: { ...fresh.plan, revalidate: original.revalidate } }
  }

  /** Pin the wall clock at planning time so a re-computation differs from the
   *  original only where the world moved, never because `Date.now()` did. */
  private freeze<T extends SurfaceTopologyOpts>(opts: T): T {
    return { ...opts, at: opts.at ?? Date.now() }
  }

  /** The durable expectation for a home that is gaining or losing a child. Empty
   *  for the Canvas and the recovery store, which are homes rather than records and
   *  so have no revision to compare — and empty for a home that is not there, which
   *  the plan's own `checkHome` has already refused for every path that cares. */
  private expectedHome(home: SurfaceHome): Record<string, number> {
    if (home.kind !== 'surface') return {}
    const parent = this.surfaces.get(home.surfaceId)
    return parent ? { [parent.id]: parent.rev } : {}
  }

  /** Raise a space's topology revision. Never lowers it — that is the whole point
   *  of the counter (see {@link topologyRevs}). */
  private raiseTopologyRev(spaceId: string, rev: number): void {
    const current = this.topologyRevs.get(spaceId) ?? 0
    if (rev > current) this.topologyRevs.set(spaceId, rev)
  }

  /** Build the stored record from an init. Host-assigned fields (identity, both
   *  revisions, timestamps, derived thread status) are set HERE and never read off
   *  the init, so no request shape can smuggle in a revision. */
  private materialize(id: string, init: SurfaceInit, now: number, homeRev: number): Surface {
    const createdAt = init.createdAt ?? now
    const thread = {
      replies: init.thread?.replies ?? [],
      ...(init.thread?.resolvedAt != null ? { resolvedAt: init.thread.resolvedAt } : {}),
      ...(init.thread?.dismissedAt != null ? { dismissedAt: init.thread.dismissedAt } : {}),
    }
    return {
      id,
      spaceId: init.spaceId,
      home: init.home,
      ...(init.order != null ? { order: init.order } : {}),
      content: init.content,
      contentAuthority: init.contentAuthority ?? (init.source ? 'source-binding' : 'canonical-direct'),
      ...(init.source ? { source: init.source } : {}),
      ...(init.provenance ? { provenance: init.provenance } : {}),
      author: init.author ?? 'agent',
      ...(init.owner ? { owner: init.owner } : {}),
      thread: { ...thread, status: derivePointStatus(thread) },
      freshness: {
        phase: init.freshness?.phase ?? 'current',
        overdue: init.freshness?.overdue ?? false,
        ...(init.freshness?.dueAt != null ? { dueAt: init.freshness.dueAt } : {}),
        ...(init.freshness?.observedGeneration != null
          ? { observedGeneration: init.freshness.observedGeneration }
          : {}),
        ...(init.freshness?.verifiedAt != null ? { verifiedAt: init.freshness.verifiedAt } : {}),
      },
      ...(init.aliases ? { aliases: init.aliases } : {}),
      ...(init.compatibilityOnly ? { compatibilityOnly: true } : {}),
      rev: 1,
      homeRev,
      createdAt,
      amendedAt: now,
    }
  }

  /**
   * Validate a proposed home for Surfaces in `spaceId`. Returns the rejection
   * reason, or `undefined` when the home is legal.
   *
   * `subject` holds the ids being placed, which is what makes the cycle check work
   * for a batch: walking up from the target home must not meet ANY of them, since a
   * move that puts A under B while B is being moved under A is a cycle even though
   * neither leg is one on its own.
   */
  private checkHome(home: SurfaceHome, spaceId: string, subject: Set<string>): SurfaceRejection | undefined {
    if (home.kind === 'canvas') {
      // Canvas is a home, not a Surface (R29), so the only thing to check is that
      // it is THIS space's canvas — otherwise a "promote to canvas" would quietly
      // teleport the Surface into another space.
      return home.spaceId === spaceId ? undefined : 'cross-space'
    }
    if (home.kind === 'recovery') {
      // Refused for every ordinary mutation. `planDelete` does not come through
      // here — it constructs the recovery home itself — so there is no flag to
      // pass and no way for a caller to opt into deleting something by naming a
      // home (KTD15).
      return 'recovery-home'
    }
    if (subject.has(home.surfaceId)) return 'cycle'
    const parent = this.surfaces.get(home.surfaceId)
    if (!parent) return 'unknown-home'
    if (parent.spaceId !== spaceId) return 'cross-space'
    // Walk the parent's ancestry: if any subject is up there, the move would put a
    // Surface inside its own descendant. Bounded by the record count so corrupt
    // hydrated data cannot spin here.
    let cursor: Surface | undefined = parent
    for (let hops = 0; cursor && hops <= this.surfaces.size; hops++) {
      if (subject.has(cursor.id)) return 'cycle'
      if (cursor.home.kind === 'canvas') return undefined
      // The proposed parent is itself inside the recovery store. Homing a live
      // Surface under it would delete that Surface with none of the bookkeeping
      // that makes a delete undoable, and it would vanish from the tree without
      // ever appearing in the recovery list.
      if (cursor.home.kind === 'recovery') return 'deleted'
      cursor = this.surfaces.get(cursor.home.surfaceId)
    }
    // Ran out of hops or hit a dangling parent: the existing chain is already
    // broken, so refuse rather than append to it.
    return 'cycle'
  }

  /** The KTD7 compare-and-swap: space topology revision plus the affected records'
   *  own revisions. An expectation the caller omitted is not checked. */
  private checkRevisions(
    affected: Surface[],
    spaceId: string,
    opts: SurfaceTopologyOpts,
  ): SurfaceRejection | undefined {
    if (opts.expectedTopologyRev !== undefined && opts.expectedTopologyRev !== this.getTopologyRev(spaceId)) {
      return 'stale-topology-revision'
    }
    if (opts.expectedRevs) {
      for (const s of affected) {
        const expected = opts.expectedRevs[s.id]
        if (expected !== undefined && expected !== s.rev) return 'stale-surface-revision'
      }
    }
    return undefined
  }

  /** Assemble a plan. Trivial, but centralised so every mutation reports the same
   *  fields and a later one cannot forget `baseTopologyRev`. */
  private makePlan(
    spaceId: string,
    baseTopologyRev: number,
    topologyRev: number,
    records: Surface[],
    purged: string[],
    expectedRevs: Record<string, number>,
  ): PlanCore {
    return { spaceId, baseTopologyRev, topologyRev, records, purged, expectedRevs }
  }

  /** The eager path: plan, then apply. What boot and migration call, and what the
   *  mutation service deliberately does NOT — it needs the durable write in the
   *  gap. */
  private runPlan(result: SurfacePlanResult): SurfaceTopologyResult {
    if (!result.applied) return result
    const surfaces = this.applyPlan(result.plan)
    return { applied: true, topologyRev: this.getTopologyRev(result.plan.spaceId), surfaces }
  }

  /** One Surface's move: `home`, `homeRev`, `rev`, `amendedAt`, and nothing else.
   *  Identity, thread, provenance, freshness, and source bindings are untouched by
   *  construction rather than by discipline (AE1/R22). */
  private rehome(prior: Surface, home: SurfaceHome, homeRev: number, now: number): Surface {
    return { ...prior, home, homeRev, rev: prior.rev + 1, amendedAt: now }
  }

  /** A content write's batch. Both revisions are the current one: nothing moved,
   *  so there is no base-to-result step for a client to reconcile. */
  private emitBatch(spaceId: string, written: Surface[]): void {
    const rev = this.getTopologyRev(spaceId)
    this.emit({
      spaceId,
      baseTopologyRev: rev,
      topologyRev: rev,
      changes: written.map(s => ({ entity: 'surface' as const, id: s.id, spaceId: s.spaceId, data: s })),
    })
  }

  private reindex(): void {
    const { children, topologyRevs } = buildTopologyIndex(this.surfaces.values())
    this.childIndex = children
    // The rebuilt revisions are a FLOOR, not the answer. Assigning them outright is
    // what used to make `purge` — the one operation that erases records — drive the
    // counter backwards, past a token some client was still holding.
    for (const [spaceId, floor] of topologyRevs) this.raiseTopologyRev(spaceId, floor)
  }

  private resolveChildren(key: string): Surface[] {
    const ids = this.childIndex.get(key)
    if (!ids) return []
    return ids.map(id => this.surfaces.get(id)).filter((s): s is Surface => !!s)
  }
}
