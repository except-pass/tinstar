import type { ConstellationSlot } from '../hooks/useConstellations'
import type { Rect } from './constellationCohesion'
import { rectDistance } from './snapZoneResolver'
import type { SnapWidget } from './snapZoneResolver'

interface DragState {
  id: string
  rect: Rect
}

interface Props {
  dragging: DragState | null
  widgets: SnapWidget[]
  slotByNode: Map<string, ConstellationSlot>
  occupiedSlots: Set<ConstellationSlot>
  snapDistance: number
}

const HALO_PAD = 12

export function SnapZoneOverlay({ dragging, widgets, slotByNode, occupiedSlots, snapDistance }: Props) {
  if (!dragging) return null

  const noFreeSlot = occupiedSlots.size >= 9

  const nearby = widgets.filter(w =>
    w.id !== dragging.id && rectDistance(dragging.rect, w) <= snapDistance,
  )

  return (
    <>
      {nearby.map(w => {
        const isMember = slotByNode.has(w.id)
        const tone = isMember
          ? 'border-primary/70 bg-primary/10'
          : noFreeSlot
            ? 'border-red-400/70 bg-red-400/10'
            : 'border-primary/70 bg-primary/10'
        return (
          <div
            key={w.id}
            data-testid={`snap-halo-${w.id}`}
            className={`pointer-events-none absolute border-2 rounded-md ${tone}`}
            style={{
              left: w.x - HALO_PAD,
              top: w.y - HALO_PAD,
              width: w.width + HALO_PAD * 2,
              height: w.height + HALO_PAD * 2,
            }}
          />
        )
      })}
    </>
  )
}
