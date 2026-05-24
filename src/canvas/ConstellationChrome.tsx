import { boundingBoxOf, type Rect } from './constellationCohesion'
import type { ConstellationSlot } from '../hooks/useConstellations'

interface Props {
  slot: ConstellationSlot
  rects: Rect[]
  active: boolean
}

export function ConstellationChrome({ slot, rects, active }: Props) {
  if (rects.length === 0) return null

  const box = boundingBoxOf(rects)
  if (!box) return null

  return (
    <>
      {active && (
        <div
          data-testid={`constellation-outline-${slot}`}
          className="pointer-events-none absolute border-2 border-primary/80 rounded-md"
          style={{
            left: box.x - 8,
            top: box.y - 8,
            width: box.width + 16,
            height: box.height + 16,
          }}
        />
      )}
      {active && (
        <div
          data-testid={`constellation-badge-large-${slot}`}
          className="pointer-events-none absolute bg-primary text-white text-sm font-bold rounded px-2 py-0.5"
          style={{ left: box.x - 8, top: box.y - 28 }}
        >
          {slot}
        </div>
      )}
    </>
  )
}
