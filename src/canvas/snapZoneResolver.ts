import type { ConstellationSlot } from '../hooks/useConstellations'
import type { Rect } from './constellationCohesion'

export interface SnapWidget extends Rect {
  id: string
}

export interface SnapDropInput {
  draggedId: string
  draggedRect: Rect
  allWidgets: SnapWidget[]
  slotByNode: Map<string, ConstellationSlot>
  occupiedSlots: Set<ConstellationSlot>
  snapDistance: number
}

export type SnapDropResult =
  | { kind: 'join'; slot: ConstellationSlot }
  | { kind: 'form'; slot: ConstellationSlot; withId: string }
  | { kind: 'full-slots' }
  | { kind: 'none' }

const ALL_SLOTS: ConstellationSlot[] = ['1','2','3','4','5','6','7','8','9']

export function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)))
  const dy = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)))
  return Math.hypot(dx, dy)
}

export function resolveSnapDrop(input: SnapDropInput): SnapDropResult {
  const { draggedId, draggedRect, allWidgets, slotByNode, occupiedSlots, snapDistance } = input

  const nearby = allWidgets.filter(w =>
    w.id !== draggedId && rectDistance(draggedRect, w) <= snapDistance,
  )

  // 1. Join wins: any nearby widget already in a constellation
  for (const w of nearby) {
    const slot = slotByNode.get(w.id)
    if (slot) return { kind: 'join', slot }
  }

  // 2. Form-new: nearest ungrouped neighbor + next free slot
  if (nearby.length > 0) {
    const freeSlot = ALL_SLOTS.find(s => !occupiedSlots.has(s))
    if (!freeSlot) return { kind: 'full-slots' }
    const ungrouped = nearby
      .filter(w => !slotByNode.has(w.id))
      .sort((a, b) => rectDistance(draggedRect, a) - rectDistance(draggedRect, b))
    if (ungrouped.length === 0) return { kind: 'none' }
    const nearest = ungrouped[0]
    if (!nearest) return { kind: 'none' }
    return { kind: 'form', slot: freeSlot, withId: nearest.id }
  }

  return { kind: 'none' }
}
