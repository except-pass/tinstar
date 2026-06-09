import type { ConstellationSlot } from '../domain/constellationGraph'
import { DEFAULT_ANCHORS, anchorByName, type AnchorPair } from '../domain/anchors'
import { anchorPosition, nearestAnchorPair } from './anchors'
import type { Rect } from './constellationCohesion'

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

// Flush by default — widgets touch when joined. Bump for a gutter between snapped widgets.
const SNAP_GAP = 0

export function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)))
  const dy = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)))
  return Math.hypot(dx, dy)
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

  // Pick the nearest (dragged-anchor, target-anchor) pair. Both use DEFAULT_ANCHORS
  // here; per-widget custom anchors can be threaded in later via an overload —
  // defaults cover every host widget.
  const { pair } = nearestAnchorPair(draggedRect, DEFAULT_ANCHORS, nearest, DEFAULT_ANCHORS)
  const da = anchorByName(DEFAULT_ANCHORS, pair[0])!
  const ta = anchorByName(DEFAULT_ANCHORS, pair[1])!
  const pos = anchorPosition(nearest, ta, da, draggedRect)
  // Derive the legacy `edge` from the dominant center offset (preview chrome still reads it).
  const dx = (draggedRect.x + draggedRect.width / 2) - (nearest.x + nearest.width / 2)
  const dy = (draggedRect.y + draggedRect.height / 2) - (nearest.y + nearest.height / 2)
  const edge: SnapEdge = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top')
  return { targetId: nearest.id, edge, anchors: pair, x: pos.x, y: pos.y }
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
