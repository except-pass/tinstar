import type { WidgetLayout } from '../hooks/useWidgetLayouts'
import type { ConstellationSlot } from './constellationGraph'

/** Relocate a widget to a canvas point and leave any constellation it's in.
 *  Pure orchestration over injected ops — mirrors handleDrop's coord placement
 *  and handleWidgetDragEnd's drag-out constellation-leave (constellations.remove). */
export function relocateWidgetTo(
  id: string,
  point: { x: number; y: number },
  ops: {
    getLayout: (id: string) => WidgetLayout | undefined
    insertLayout: (id: string, layout: WidgetLayout) => void
    slotsForNode: (id: string) => ConstellationSlot[]
    removeFromSlot: (slot: ConstellationSlot, id: string) => void
  },
): void {
  const cur = ops.getLayout(id)
  if (!cur) return                                   // vanished mid-menu → no-op
  ops.insertLayout(id, { ...cur, x: point.x, y: point.y })
  for (const slot of ops.slotsForNode(id)) ops.removeFromSlot(slot, id)
}
