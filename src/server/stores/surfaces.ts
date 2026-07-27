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
 *  post-mutation `topologyRev`. */
export interface SurfaceBatch {
  spaceId: string
  topologyRev: number
  changes: SurfaceChange[]
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

export type SurfaceTopologyResult =
  | { applied: true; topologyRev: number; surfaces: Surface[] }
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
 *  two cases can never collide (a space named `surface` and a Surface id are both
 *  arbitrary strings). Written as a unicode escape, not a raw byte: a raw NUL makes
 *  git treat the source file as binary. */
export function homeKey(home: SurfaceHome): string {
  return home.kind === 'canvas' ? 'canvas\u0000' + home.spaceId : 'surface\u0000' + home.surfaceId
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
 * PURE and exported because it is the whole reload contract. A snapshot persists
 * records and nothing else; if the indexes could not be reconstructed exactly from
 * those records, the sidecar would need a second, separately-maintained copy of the
 * tree — and the two would eventually disagree. The topology revision reconstructs
 * as the maximum `homeRev` in the space, which holds because a Surface is never
 * erased (KTD15 makes deletion a move), so no record that carried the high-water
 * mark can vanish and let the revision run backwards.
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

  /** DERIVED: spaceId → topology revision (max `homeRev` in the space). */
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

  /** Ancestors nearest-first, stopping at the Canvas. Bounded by the record count
   *  so a cycle that reached the store through a corrupt snapshot degrades into a
   *  truncated chain instead of hanging the server — the mutation path rejects
   *  cycles, but a hydrated file has never been through it. */
  getAncestors(id: string): Surface[] {
    const out: Surface[] = []
    let cursor = this.surfaces.get(id)
    for (let hops = 0; cursor && hops <= this.surfaces.size; hops++) {
      if (cursor.home.kind === 'canvas') break
      const parent = this.surfaces.get(cursor.home.surfaceId)
      if (!parent || parent.id === id) break
      out.push(parent)
      cursor = parent
    }
    return out
  }

  /** The space's current topology revision; 0 for a space with no Surfaces. */
  getTopologyRev(spaceId: string): number {
    return this.topologyRevs.get(spaceId) ?? 0
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
   */
  load(records: Surface[]): void {
    for (const s of records) {
      if (!s || !s.id || !s.spaceId || !s.home) continue
      this.surfaces.set(s.id, s)
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
    const prior = this.surfaces.get(next.id)
    if (!prior) return false
    if (next.spaceId !== prior.spaceId) return false
    if (!sameHome(next.home, prior.home)) return false
    if (next.homeRev !== prior.homeRev) return false
    if (next.order !== prior.order) return false
    if (next.rev <= prior.rev) return false
    if (onlyBookkeepingChanged(prior, next)) return false
    this.surfaces.set(next.id, next)
    // No reindex needed, and that is a guarantee rather than an optimisation: the
    // four topology fields are all rejected above, so neither sibling membership
    // nor sibling order can have moved.
    this.emitBatch(prior.spaceId, [next])
    return true
  }

  // --- Topology mutation ---

  /**
   * Mint a Surface at a home. A create IS a topology change — it adds a node to the
   * tree — so it validates the home, bumps the space topology revision, and emits
   * the same batch shape a move does.
   */
  createSurface(init: SurfaceInit, opts: SurfaceTopologyOpts = {}): SurfaceTopologyResult {
    const spaceId = init.spaceId
    const rev = this.getTopologyRev(spaceId)
    const id = init.id ?? newSurfaceId()
    if (this.surfaces.has(id)) return { applied: false, reason: 'duplicate-id', topologyRev: rev }
    const homeCheck = this.checkHome(init.home, spaceId, new Set([id]))
    if (homeCheck) return { applied: false, reason: homeCheck, topologyRev: rev }
    if (opts.expectedTopologyRev !== undefined && opts.expectedTopologyRev !== rev) {
      return { applied: false, reason: 'stale-topology-revision', topologyRev: rev }
    }
    const now = opts.at ?? Date.now()
    const created = this.materialize(id, init, now, rev + 1)
    this.surfaces.set(id, created)
    return this.commit(spaceId, rev + 1, [created])
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
    const homeCheck = this.checkHome(home, spaceId, new Set(unique))
    if (homeCheck) return { applied: false, reason: homeCheck, topologyRev: rev }

    const gate = this.checkRevisions(moving, spaceId, opts)
    if (gate) return { applied: false, reason: gate, topologyRev: rev }

    const changed = moving.filter(s => !sameHome(s.home, home))
    if (changed.length === 0) return { applied: false, reason: 'no-change', topologyRev: rev }

    const now = opts.at ?? Date.now()
    const nextRev = rev + 1
    const written = changed.map(prior => {
      const next: Surface = { ...prior, home, homeRev: nextRev, rev: prior.rev + 1, amendedAt: now }
      this.surfaces.set(next.id, next)
      return next
    })
    return this.commit(spaceId, nextRev, written)
  }

  /**
   * Group existing siblings under a NEW parent Surface, in one transaction and one
   * emitted batch (F2/AE1). The parent inherits the children's shared home, so the
   * group appears exactly where the children were.
   *
   * Requiring a SHARED home (rather than reparenting from anywhere) is deliberate:
   * "group these" means folding siblings into a box, and gathering Surfaces from
   * scattered homes is a multi-move the caller should have to state explicitly —
   * silently pulling a Surface out of a parent the user built is precisely the
   * "moving an existing human-arranged surface" case R24 guards.
   */
  group(
    childIds: string[],
    parent: Omit<SurfaceInit, 'spaceId' | 'home' | 'id'> & { id?: string },
    opts: SurfaceTopologyOpts = {},
  ): SurfaceTopologyResult {
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
    const parentId = parent.id ?? newSurfaceId()
    if (this.surfaces.has(parentId)) {
      return { applied: false, reason: 'duplicate-id', topologyRev: rev }
    }
    const gate = this.checkRevisions(children, spaceId, opts)
    if (gate) return { applied: false, reason: gate, topologyRev: rev }

    const now = opts.at ?? Date.now()
    const nextRev = rev + 1
    const created = this.materialize(parentId, { ...parent, id: parentId, spaceId, home }, now, nextRev)
    this.surfaces.set(parentId, created)
    const newHome: SurfaceHome = { kind: 'surface', surfaceId: parentId }
    const moved = children.map(prior => {
      const next: Surface = {
        ...prior, home: newHome, homeRev: nextRev, rev: prior.rev + 1, amendedAt: now,
      }
      this.surfaces.set(next.id, next)
      return next
    })
    // Parent first in the batch so an ordered consumer never sees a child pointing
    // at a home it has not been told about yet.
    return this.commit(spaceId, nextRev, [created, ...moved])
  }

  // --- Lifecycle ---

  /** Silent bulk drop of a whole space, for the `clearSpace` cascade. Emits nothing
   *  (the caller emits one reset) and mirrors `SlateStore.deleteRunsSilently`. */
  clearSpaceSilently(spaceId: string): void {
    for (const [id, s] of this.surfaces) {
      if (s.spaceId === spaceId) this.surfaces.delete(id)
    }
    // The cleared space's topology revision falls back to 0 because `reindex`
    // rebuilds every revision from the surviving records — correct here precisely
    // because nothing of that space survives to be confused by the reset.
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

  /** Silent clear of everything, for the no-active-space `clear()` branch. */
  clearAll(): void {
    this.surfaces.clear()
    this.childIndex.clear()
    this.topologyRevs.clear()
  }

  // --- Internals ---

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

  /** Install the derived state for a completed topology mutation and emit its one
   *  batch. Reindexing from the records (rather than patching the index in place)
   *  is what guarantees the live index is identical to a reload of the same records
   *  — the property the snapshot reload test asserts. */
  private commit(spaceId: string, topologyRev: number, written: Surface[]): SurfaceTopologyResult {
    this.reindex()
    this.emit({
      spaceId,
      topologyRev,
      changes: written.map(s => ({ entity: 'surface' as const, id: s.id, spaceId: s.spaceId, data: s })),
    })
    return { applied: true, topologyRev, surfaces: written }
  }

  private emitBatch(spaceId: string, written: Surface[]): void {
    this.emit({
      spaceId,
      topologyRev: this.getTopologyRev(spaceId),
      changes: written.map(s => ({ entity: 'surface' as const, id: s.id, spaceId: s.spaceId, data: s })),
    })
  }

  private reindex(): void {
    const { children, topologyRevs } = buildTopologyIndex(this.surfaces.values())
    this.childIndex = children
    this.topologyRevs = topologyRevs
  }

  private resolveChildren(key: string): Surface[] {
    const ids = this.childIndex.get(key)
    if (!ids) return []
    return ids.map(id => this.surfaces.get(id)).filter((s): s is Surface => !!s)
  }
}
