import type { ConstellationSlot } from '../hooks/useConstellations'
import type { Rect } from './constellationCohesion'

export interface SnapWidget extends Rect {
  id: string
}

export type SnapEdge = 'left' | 'right' | 'top' | 'bottom'

/** The single widget a drag would snap against, plus the flush top-left position for the dragged widget. */
export interface SnapTarget {
  targetId: string
  edge: SnapEdge
  /** Snapped top-left for the dragged widget: flush against `edge`, aligned on the perpendicular axis. */
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

  const dx = (draggedRect.x + draggedRect.width / 2) - (nearest.x + nearest.width / 2)
  const dy = (draggedRect.y + draggedRect.height / 2) - (nearest.y + nearest.height / 2)

  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal placement, top-aligned.
    const edge: SnapEdge = dx >= 0 ? 'right' : 'left'
    const x = edge === 'right'
      ? nearest.x + nearest.width + SNAP_GAP
      : nearest.x - draggedRect.width - SNAP_GAP
    return { targetId: nearest.id, edge, x, y: nearest.y }
  }
  // Vertical placement, left-aligned.
  const edge: SnapEdge = dy >= 0 ? 'bottom' : 'top'
  const y = edge === 'bottom'
    ? nearest.y + nearest.height + SNAP_GAP
    : nearest.y - draggedRect.height - SNAP_GAP
  return { targetId: nearest.id, edge, x: nearest.x, y }
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
