// The Slate point/thread store — store-backed points with merge-by-id projection.
//
// A run's Slate carries store-owned points (open questions, decisions, follow-ups)
// each with its own append-only thread and lifecycle status. A file
// (`.tinstar/slate/*.json`) is ONE authoring input: it owns only the presentational
// fields (`headline`, `content`, `anchor`); the store owns `status`, `replies`, and
// the lifecycle timestamps.
//
// The load-bearing invariant (plan KTD1): a file re-projection MERGES BY `id` and
// must never clobber a store-owned thread or status. `applyProjection` overwrites the
// file-owned body of a point that already exists and PRESERVES its store-owned fields;
// it adds new points and retracts (drops) points absent from the file. Point identity
// is an `id` INSIDE the file — the filename is incidental — so a file entry that omits
// `id` gets a DETERMINISTIC synthesized id (stable across a rename) rather than
// orphaning its thread.
//
// This module is composed by `DocumentStore`, which owns the `changes` EventEmitter:
// every mutator here calls the injected `emit` and equality-short-circuits on
// unchanged content (mirrors `setRunSlate` / `noticeEqual`) — the file-watch storm
// guard. It is server-only (rides the server esbuild bundle) and React-free.

import { createHash, randomUUID } from 'node:crypto'
import type { A2uiContent, Point, PointAnchor, PointAuthor, PointStatus } from '../../domain/types'
import type { Reply } from '../../domain/pinSet'

/** The file-owned subset of a Point that a projection carries. Everything not here
 *  (status, replies, lifecycle timestamps) is store-owned and preserved by id. */
export interface PointInput {
  /** Point identity. When absent, a deterministic id is synthesized from the
   *  content so a file rename does not orphan the thread (plan B5/H1). */
  id?: string
  author?: PointAuthor
  anchor?: PointAnchor
  headline: string
  content?: A2uiContent
  /** File-owned refresh recipe (plan U3/KTD3): the exact prompt the agent re-runs to
   *  regenerate this surface. Optional — a recipe-less surface still gets a bare nudge.
   *  Rides the file→store→bridge path exactly like `headline`/`content`/`anchor`. */
  refresh?: string
  /** File-owned WORKBENCH set id (S4): points sharing a non-empty `group` render
   *  side-by-side as one multi-question workbench. Rides the same file→store→bridge
   *  path as `refresh` — overwritten on projection, cleared when the file omits it. */
  group?: string
  /** Server stamps `createdAt` on first projection; a file may seed it. */
  createdAt?: number
}

/** The change event a Slate mutator emits (through the DocumentStore's emitter).
 *  Mirrors the notice change shape: `data:null` signals a retract/prune. */
export type SlateChange = {
  entity: 'slatePoint'
  id: string
  runId: string
  data: Point | null
}

type EmitFn = (evt: SlateChange) => void

/** Derive a point's status from its thread. `resolved`/`dismissed` are EXPLICIT and
 *  win over any derivation (they survive a file re-projection and are cleared only by
 *  an explicit reopen). Otherwise: no reply → open; last reply by the user → waiting
 *  (the agent owes an answer); last reply by the agent → discussing. The Slate never
 *  auto-resolves — that was the CMT-1302 failure this prevents. */
export function derivePointStatus(
  p: Pick<Point, 'replies' | 'resolvedAt' | 'dismissedAt'>,
): PointStatus {
  if (p.dismissedAt != null) return 'dismissed'
  if (p.resolvedAt != null) return 'resolved'
  const last = (p.replies ?? []).at(-1)
  if (!last) return 'open'
  return last.author === 'user' ? 'waiting' : 'discussing'
}

/** Stable id for a file entry that omits its own `id`. Hashes the run + the
 *  file-owned content so the SAME surface yields the SAME id regardless of which
 *  file authored it — a rename cannot orphan the thread.
 *
 *  The basis deliberately holds only the fields that IDENTIFY the surface. `refresh`
 *  and `group` (S4) are excluded on purpose: they describe how a surface is
 *  regenerated and where it is laid out, not which surface it is, so folding them in
 *  would re-id the point the moment an agent grouped it — orphaning the very thread
 *  this hash exists to preserve. */
function synthesizeId(runId: string, input: PointInput): string {
  const basis = JSON.stringify({
    runId,
    headline: input.headline,
    content: input.content ?? null,
    author: input.author ?? null,
    anchor: input.anchor ?? null,
  })
  return 'pt-syn-' + createHash('sha1').update(basis).digest('hex').slice(0, 16)
}

function pointEqual(a: Point, b: Point): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** True when a projection would change any file-owned field of an existing point. */
function fileOwnedChanged(prior: Point, input: PointInput): boolean {
  return (
    prior.headline !== input.headline ||
    (prior.refresh ?? undefined) !== (input.refresh ?? undefined) ||
    // LOAD-BEARING (S4): without this comparison an amend that changes ONLY `group`
    // short-circuits on `pointEqual` and never re-projects — the workbench would
    // silently never form. Guard-tested in slate.test.ts.
    (prior.group ?? undefined) !== (input.group ?? undefined) ||
    JSON.stringify(prior.content ?? null) !== JSON.stringify(input.content ?? null) ||
    JSON.stringify(prior.anchor ?? null) !== JSON.stringify(input.anchor ?? null)
  )
}

function createPoint(
  runId: string,
  id: string,
  input: PointInput,
  now: number,
  source: 'file' | 'user' = 'file',
): Point {
  const createdAt = input.createdAt ?? now
  const p: Point = {
    id,
    runId,
    author: input.author ?? 'agent',
    source,
    ...(input.anchor ? { anchor: input.anchor } : {}),
    headline: input.headline,
    ...(input.content ? { content: input.content } : {}),
    ...(input.refresh ? { refresh: input.refresh } : {}),
    ...(input.group ? { group: input.group } : {}),
    status: 'open',
    createdAt,
    amendedAt: createdAt,
  }
  p.status = derivePointStatus(p)
  return p
}

/** Merge a projection onto an existing point: overwrite the file-owned body, preserve
 *  every store-owned field (`replies`, `status` inputs, lifecycle timestamps, author,
 *  createdAt). `amendedAt` bumps only when a file-owned field actually changed, so an
 *  identical re-projection is byte-equal and short-circuits. */
function mergeFileOwned(prior: Point, input: PointInput, now: number): Point {
  const changed = fileOwnedChanged(prior, input)
  // The `...prior` spread is what preserves every STORE-owned field across a file
  // re-projection — `replies`, the lifecycle stamps, and (S6 U2) `order`. A file
  // never authors `order`, so there is nothing to overwrite here; the spread is the
  // whole mechanism, and dropping it would silently reset a user's reordering on
  // the next file write.
  const next: Point = {
    ...prior,
    headline: input.headline,
    amendedAt: changed ? now : prior.amendedAt,
  }
  // A fresh file update un-stalls the point (the wrapper resumed writing), so the
  // staleness backstop never sticks on a still-live process (plan R19).
  if (changed) delete next.stalledAt
  // File owns the body: an omitted `content` clears it.
  if (input.content) next.content = input.content
  else delete next.content
  // File owns the refresh recipe too: overwrite on projection, clear when omitted.
  if (input.refresh) next.refresh = input.refresh
  else delete next.refresh
  // File owns the workbench set id (S4) too: overwrite on projection, clear when
  // omitted — so removing `group` from the file dissolves the workbench.
  if (input.group) next.group = input.group
  else delete next.group
  if (input.anchor) next.anchor = input.anchor
  // status recomputes, but replies/resolvedAt/dismissedAt are untouched, so a
  // pure body change never disturbs a live thread or an explicit resolve.
  next.status = derivePointStatus(next)
  return next
}

/**
 * Given the order values a set of points CURRENTLY occupies, return the same set of
 * slots re-issued in ascending order and forced strictly increasing (S6 U2).
 *
 * Reusing the existing slots is what keeps a reorder local: the group as a whole
 * stays exactly where it was on the Slate's single `order` axis, and only its
 * internal sequence changes. Strictly-increasing matters because the render sort
 * tiebreaks equal `order` on `createdAt` — two points sharing a slot (both falling
 * back to the same `createdAt`, say) would otherwise silently ignore the new
 * sequence. Ties are broken by nudging up by 1, which can push the last slot at
 * most `n` past its original value: negligible against millisecond timestamps.
 */
export function assignOrderSlots(current: number[]): number[] {
  const slots = [...current].sort((a, b) => a - b)
  const out: number[] = []
  for (let i = 0; i < slots.length; i++) {
    const base = slots[i]!
    out.push(i === 0 ? base : Math.max(base, out[i - 1]! + 1))
  }
  return out
}

export class SlateStore {
  /** Points keyed by (runId, id) via {@link k}. Scoping the key by run is load-bearing:
   *  generic ids agents naturally reuse across runs (`session-arc`, `decisions`,
   *  `blockers`, `resources`) would otherwise collide — one run's surface silently
   *  vanishing, or one run's file clobbering another run's point body. */
  private points = new Map<string, Point>()

  constructor(private readonly emit: EmitFn) {}

  /** The composite map key. A point id is only unique WITHIN a run, so the run is part
   *  of the key. A NUL is the joiner — it can never appear in a runId (a tmux session
   *  name) or an id (a slug), so the split is unambiguous. Written as a JS unicode escape
   *  sequence, NOT a raw byte: a raw NUL makes git treat the whole source file as binary. */
  private k(runId: string, id: string): string {
    return runId + '\u0000' + id
  }

  getPoint(runId: string, id: string): Point | undefined {
    return this.points.get(this.k(runId, id))
  }

  /** All of a run's points in render order: `order` (S6 U2) when set, falling back
   *  to `createdAt`, with an id tiebreak. An un-reordered run is byte-identical to
   *  the old oldest-first behavior, since every point's effective order IS its
   *  createdAt until someone reorders. */
  getPointsForRun(runId: string): Point[] {
    const rank = (p: Point) => p.order ?? p.createdAt
    return [...this.points.values()]
      .filter(p => p.runId === runId)
      .sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  getAllPoints(): Point[] {
    return [...this.points.values()]
  }

  /** Seed points from a persisted snapshot (no emit — hydration, not a mutation). */
  loadPoints(points: Point[]): void {
    for (const p of points) {
      if (!p || !p.id || !p.runId) continue
      this.points.set(this.k(p.runId, p.id), p)
    }
  }

  /**
   * Project a run's file-authored surfaces onto the store, merging by id (KTD1).
   * Overwrites the file-owned body of existing points, preserves their store-owned
   * threads/status, adds new points, and retracts points of this run absent from the
   * projection. Emits one `slatePoint` change per point that actually changed — an
   * identical re-projection emits ZERO events (the file-watch storm guard).
   *
   * RETRACTION SCOPE (plan U7 reconciliation): only `source:'file'` points absent
   * from `inputs` are dropped. A `source:'user'` point (added over HTTP via
   * {@link addUserPoint}) is EXEMPT — the file that projects onto this run does not
   * know about it, so without this exemption the next file re-projection would nuke
   * a point the user just added. A prior point without a `source` field (legacy) is
   * treated as file-owned and retracted, so old snapshots keep their behavior.
   */
  applyProjection(runId: string, inputs: PointInput[], now: number = Date.now()): void {
    const seen = new Set<string>()
    for (const input of inputs) {
      const id = input.id && input.id.length > 0 ? input.id : synthesizeId(runId, input)
      if (seen.has(id)) continue // first entry wins on a duplicate id
      seen.add(id)
      const prior = this.points.get(this.k(runId, id))
      const next = prior ? mergeFileOwned(prior, input, now) : createPoint(runId, id, input, now)
      if (prior && pointEqual(prior, next)) continue // zero-change short-circuit
      this.points.set(this.k(runId, id), next)
      this.emit({ entity: 'slatePoint', id, runId, data: next })
    }
    // Retract this run's file-owned points absent from the projection. Iterate by map
    // key but scope on p.runId, and emit the POINT id (not the composite key).
    for (const [mapKey, p] of this.points) {
      if (p.runId !== runId || seen.has(p.id)) continue
      if (p.source === 'user') continue // user points survive a file re-projection
      this.points.delete(mapKey)
      this.emit({ entity: 'slatePoint', id: p.id, runId, data: null })
    }
  }

  /**
   * Create OR amend a USER-authored point (plan U7). Unlike {@link applyProjection}
   * (the file→store path), a user point carries `source:'user'` so a later file
   * re-projection does NOT retract it. When `input.id` names an existing point of
   * this run the file-owned body/headline/anchor are amended (its thread/status are
   * preserved, mirroring the merge rule); otherwise a fresh point is created with a
   * generated id. Emits one change (or none if a byte-identical amend). Returns the
   * resulting point.
   */
  addUserPoint(runId: string, input: PointInput, now: number = Date.now()): Point {
    const id = input.id && input.id.length > 0 ? input.id : 'pt-user-' + randomUUID().slice(0, 12)
    // Scoped to THIS run by the composite key — a prior hit is always this run's point.
    const prior = this.points.get(this.k(runId, id))
    const next = prior
      ? { ...mergeFileOwned(prior, input, now), source: prior.source ?? 'user' as const }
      : createPoint(runId, id, { author: 'user', ...input }, now, 'user')
    if (prior && pointEqual(prior, next)) return prior
    this.points.set(this.k(runId, id), next)
    this.emit({ entity: 'slatePoint', id, runId, data: next })
    return next
  }

  /** Append a reply to a point's thread (append-only; mirrors pins/notes). Re-derives
   *  status from the new last-author. A resolved/dismissed point stays terminal —
   *  reopen is explicit (see {@link reopen}). No-op if the point is unknown. */
  addReply(runId: string, pointId: string, reply: Reply): void {
    this.mutate(runId, pointId, prior => {
      const replies = [...(prior.replies ?? []), reply]
      const next: Point = { ...prior, replies, amendedAt: reply.createdAt }
      next.status = derivePointStatus(next)
      return next
    })
  }

  /** Explicit resolve — a soft, sticky status that SURVIVES a later file re-projection
   *  and is cleared only by {@link reopen}. Clears any dismiss. */
  resolve(runId: string, pointId: string, at: number = Date.now()): void {
    this.mutate(runId, pointId, prior => {
      const next: Point = { ...prior, resolvedAt: at, amendedAt: at }
      delete next.dismissedAt
      next.status = derivePointStatus(next)
      return next
    })
  }

  /** Explicit dismiss — sticky, survives re-projection, cleared only by reopen. */
  dismiss(runId: string, pointId: string, at: number = Date.now()): void {
    this.mutate(runId, pointId, prior => {
      const next: Point = { ...prior, dismissedAt: at, amendedAt: at }
      delete next.resolvedAt
      next.status = derivePointStatus(next)
      return next
    })
  }

  /** Server-side staleness backstop (plan R19): mark a `process`-authored point
   *  stalled so a `kill -9`'d `tinstar-run` wrapper (which can't run its finalize
   *  trap) doesn't leave a permanent fake-live spinner. Sets `stalledAt` WITHOUT
   *  bumping `amendedAt` (that would reset the staleness clock) and does NOT touch
   *  `status` (the renderer styles from `stalledAt`). No-op if already stalled, so a
   *  repeated sweep emits nothing. Cleared by a later file re-projection that changes
   *  the body ({@link mergeFileOwned}). */
  markStalled(runId: string, pointId: string, at: number = Date.now()): void {
    this.mutate(runId, pointId, prior => {
      if (prior.stalledAt != null) return prior
      return { ...prior, stalledAt: at }
    })
  }

  /**
   * Reorder a run's points (S6 U2). `ids` is the desired sequence; points of this
   * run not named in `ids` are untouched.
   *
   * The assigned values REUSE the slots the listed points already occupy (see
   * {@link assignOrderSlots}) rather than being 0,1,2… That matters: `order` is one
   * shared axis for the whole Slate, so numbering the open points 0..n-1 would
   * yank them ahead of every diagram/generic surface the moment anything was
   * reordered once. Reusing their own slots keeps the group exactly where it was
   * relative to everything else and only permutes it internally.
   *
   * `amendedAt` is deliberately NOT bumped — a reorder is not a re-authoring, and
   * bumping it would reset the freshness clock and clear an in-flight refresh
   * spinner. An identical reorder emits nothing (`mutate`'s equality guard).
   */
  reorderPoints(runId: string, ids: string[]): void {
    const targets: Point[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue // first mention wins on a duplicate id
      seen.add(id)
      const p = this.points.get(this.k(runId, id))
      if (p) targets.push(p)
    }
    if (targets.length < 2) return // nothing to permute
    const slots = assignOrderSlots(targets.map(p => p.order ?? p.createdAt))
    targets.forEach((p, i) => {
      const order = slots[i]!
      this.mutate(runId, p.id, prior => (prior.order === order ? prior : { ...prior, order }))
    })
  }

  /** Explicit reopen — clears resolve/dismiss and returns the point to its derived
   *  status (open/discussing/waiting). */
  reopen(runId: string, pointId: string, at: number = Date.now()): void {
    this.mutate(runId, pointId, prior => {
      if (prior.resolvedAt == null && prior.dismissedAt == null) return prior
      const next: Point = { ...prior, amendedAt: at }
      delete next.resolvedAt
      delete next.dismissedAt
      next.status = derivePointStatus(next)
      return next
    })
  }

  /**
   * Drop ONE point of a run, emitting the same `{ data: null }` retract `pruneRun`
   * emits per point. Scoped by the composite key, so another run's point with the
   * same id is untouched. A no-op (and no emit) when the point is absent — the
   * zero-change posture every other mutator here keeps.
   *
   * Added for the Objective (S2): clearing the objective is a single-point delete,
   * which the file-in path can't express (the objective is user-owned, so no file
   * projection retracts it) and `pruneRun` is far too blunt for.
   */
  deletePoint(runId: string, id: string): boolean {
    const mapKey = this.k(runId, id)
    const prior = this.points.get(mapKey)
    if (!prior) return false
    this.points.delete(mapKey)
    this.emit({ entity: 'slatePoint', id, runId, data: null })
    return true
  }

  /** Drop every point of a run, emitting a retract per point (deleteRun cascade). */
  pruneRun(runId: string): void {
    for (const [mapKey, p] of this.points) {
      if (p.runId !== runId) continue
      this.points.delete(mapKey)
      this.emit({ entity: 'slatePoint', id: p.id, runId, data: null })
    }
  }

  /** Silent bulk prune for `clearSpace` (which emits a single `all` reset itself). */
  deleteRunsSilently(runIds: Set<string>): void {
    for (const [id, p] of this.points) {
      if (runIds.has(p.runId)) this.points.delete(id)
    }
  }

  /** Silent clear for the no-active-space `clear()` branch. */
  clearAll(): void {
    this.points.clear()
  }

  /** Shared mutator plumbing: run-scoped lookup, zero-change short-circuit, emit. */
  private mutate(runId: string, pointId: string, fn: (prior: Point) => Point): void {
    const prior = this.points.get(this.k(runId, pointId))
    if (!prior) return // composite key already scopes to this run
    const next = fn(prior)
    if (next === prior || pointEqual(prior, next)) return
    this.points.set(this.k(runId, pointId), next)
    this.emit({ entity: 'slatePoint', id: pointId, runId, data: next })
  }
}
