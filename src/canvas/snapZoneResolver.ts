import type { ConstellationSlot } from '../domain/constellationGraph'
import { DEFAULT_ANCHORS, type AnchorPair } from '../domain/anchors'
import { anchorPoint, anchorPosition } from './anchors'
import type { Rect } from './constellationCohesion'
import { SNAP_GAP } from './snapConstants'

export interface SnapWidget extends Rect {
  id: string
}

export type SnapEdge = 'left' | 'right' | 'top' | 'bottom'

/** The single widget a drag would snap against, plus the flush top-left position for the dragged widget. */
export interface SnapTarget {
  targetId: string
  edge: SnapEdge
  /** Anchor pair [draggedAnchor, targetAnchor] that produced this snap. */
  anchors: AnchorPair
  /** Snapped top-left for the dragged widget so its anchor meets the target's. */
  x: number
  y: number
}

export type SnapDropResult =
  | { kind: 'join'; slot: ConstellationSlot }
  | { kind: 'form'; slot: ConstellationSlot; withId: string }
  | { kind: 'full-slots' }
  | { kind: 'none' }

export type SnapCommitResult =
  | { kind: 'join'; slot: ConstellationSlot }
  | { kind: 'form'; slot: ConstellationSlot; withId: string }
  | { kind: 'rollback' }

const ALL_SLOTS: ConstellationSlot[] = ['1','2','3','4','5','6','7','8','9']

// A flush snap touches the target edge-to-edge (corner) so the placed rect overlaps the
// target by ~0 on at least one axis. We allow a few px of two-axis overlap for rounding;
// beyond that the placement covers the target's interior — an occlusion, not a snap.
const OCCLUSION_TOLERANCE = 1

export function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)))
  const dy = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)))
  return Math.hypot(dx, dy)
}

/**
 * True when `placed` overlaps `target`'s interior on BOTH axes beyond the rounding
 * tolerance — i.e. it stacks on top of the target rather than sitting flush against an
 * edge or corner. Same-side anchor pairs (e.g. top-left↔top-left) produce exactly this
 * occlusion, the same one the domain model excludes the center anchor for (anchors.ts).
 */
function placementOccludes(placed: Rect, target: Rect): boolean {
  const ox = Math.min(placed.x + placed.width, target.x + target.width) - Math.max(placed.x, target.x)
  const oy = Math.min(placed.y + placed.height, target.y + target.height) - Math.max(placed.y, target.y)
  return Math.min(ox, oy) > OCCLUSION_TOLERANCE
}

/** Top-left for a widget of `size` placed flush against `edge` of `source`.
 *  Horizontal edges top-align; vertical edges left-align — matching resolveSnapTarget. */
export function flushPosition(
  source: Rect,
  edge: SnapEdge,
  size: { width: number; height: number },
): { x: number; y: number } {
  switch (edge) {
    case 'right':  return { x: source.x + source.width + SNAP_GAP, y: source.y }
    case 'left':   return { x: source.x - size.width - SNAP_GAP, y: source.y }
    case 'bottom': return { x: source.x, y: source.y + source.height + SNAP_GAP }
    case 'top':    return { x: source.x, y: source.y - size.height - SNAP_GAP }
  }
}

/**
 * Find the single nearest widget within snap range and where the dragged widget should sit
 * flush against it. Picks the side the drag is approaching from (dominant axis of center offset);
 * side-by-side placement top-aligns, stacked placement left-aligns, so widgets form tidy rows/columns.
 */
export function resolveSnapTarget(
  draggedId: string,
  draggedRect: Rect,
  allWidgets: SnapWidget[],
  snapDistance: number,
): SnapTarget | null {
  let nearest: SnapWidget | null = null
  let best = Infinity
  for (const w of allWidgets) {
    if (w.id === draggedId) continue
    const d = rectDistance(draggedRect, w)
    if (d <= snapDistance && d < best) {
      best = d
      nearest = w
    }
  }
  if (!nearest) return null

  // Pick the nearest (dragged-anchor, target-anchor) pair WHOSE placement does not occlude
  // the target. Both use DEFAULT_ANCHORS here; per-widget custom anchors can be threaded in
  // later via an overload — defaults cover every host widget. The unconstrained nearest pair
  // is a same-side pair when the drag overlaps the target (rectDistance is 0 for overlapping
  // rects), which stacks the dragged widget exactly on top — an occlusion, not a snap. We skip
  // those and take the nearest pair that yields a flush/edge-adjacent placement instead.
  let bestPair: AnchorPair | null = null
  let bestPos: { x: number; y: number } | null = null
  let bestDist = Infinity
  for (const da of DEFAULT_ANCHORS) {
    const dp = anchorPoint(draggedRect, da)
    for (const ta of DEFAULT_ANCHORS) {
      const tp = anchorPoint(nearest, ta)
      const d = Math.hypot(dp.x - tp.x, dp.y - tp.y)
      if (d >= bestDist) continue
      const pos = anchorPosition(nearest, ta, da, draggedRect)
      const placed = { x: pos.x, y: pos.y, width: draggedRect.width, height: draggedRect.height }
      if (placementOccludes(placed, nearest)) continue
      bestDist = d
      bestPair = [da.name, ta.name]
      bestPos = pos
    }
  }
  // Every overlap admits at least one flush (non-occluding) placement, so this is effectively
  // unreachable — but if no non-occluding pair exists, don't force an occlusion: report no snap.
  if (!bestPair || !bestPos) return null

  // Derive `edge` FROM the winning placement (not the pre-snap center offset) so the preview
  // chrome highlights the side the widget actually snaps to. For a corner-to-corner adjacency
  // the dominant axis of the placed-vs-target center offset breaks the tie.
  const dx = (bestPos.x + draggedRect.width / 2) - (nearest.x + nearest.width / 2)
  const dy = (bestPos.y + draggedRect.height / 2) - (nearest.y + nearest.height / 2)
  const edge: SnapEdge = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top')

  // Push the dragged widget off the target edge by SNAP_GAP so the pair settles
  // with a small gutter (room for the constellation link), rather than flush.
  let { x, y } = bestPos
  if (edge === 'right') x += SNAP_GAP
  else if (edge === 'left') x -= SNAP_GAP
  else if (edge === 'bottom') y += SNAP_GAP
  else y -= SNAP_GAP

  return { targetId: nearest.id, edge, anchors: bestPair, x, y }
}

/**
 * Re-resolve a preview target against the current layout state. Returns null when the original
 * preview target no longer exists, is no longer within snap range, or is no longer the active
 * snap target for the dragged widget.
 */
export function revalidateSnapTarget(
  draggedId: string,
  preview: SnapTarget | null,
  draggedRect: Rect,
  allWidgets: SnapWidget[],
  snapDistance: number,
): SnapTarget | null {
  if (!preview) return null
  const current = resolveSnapTarget(draggedId, draggedRect, allWidgets, snapDistance)
  if (!current || current.targetId !== preview.targetId) return null
  return current
}

/**
 * Decide the constellation action for a known snap target: join its slot if it has one,
 * otherwise form a new constellation with it in the next free slot (or report full).
 */
export function snapMembership(
  targetId: string,
  slotByNode: Map<string, ConstellationSlot>,
  occupiedSlots: Set<ConstellationSlot>,
): SnapDropResult {
  const slot = slotByNode.get(targetId)
  if (slot) return { kind: 'join', slot }
  const freeSlot = ALL_SLOTS.find(s => !occupiedSlots.has(s))
  if (!freeSlot) return { kind: 'full-slots' }
  return { kind: 'form', slot: freeSlot, withId: targetId }
}

/**
 * Decide whether a revalidated snap preview should commit into a constellation
 * or restore the widget to its last unsnapped drag position.
 */
export function resolveSnapCommit(
  preview: SnapTarget | null,
  slotByNode: Map<string, ConstellationSlot>,
  occupiedSlots: Set<ConstellationSlot>,
): SnapCommitResult {
  if (!preview) return { kind: 'rollback' }
  const membership = snapMembership(preview.targetId, slotByNode, occupiedSlots)
  if (membership.kind === 'join' || membership.kind === 'form') return membership
  return { kind: 'rollback' }
}
