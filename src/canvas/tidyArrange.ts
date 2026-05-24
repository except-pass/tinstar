import { centroidOf } from './constellationCohesion'
import type { Point, Rect } from './constellationCohesion'

type LayoutWithId = Rect & { id: string }

export function tidyGrid(
  layouts: LayoutWithId[],
  gap: number,
): Map<string, Point> {
  const out = new Map<string, Point>()
  if (layouts.length === 0) return out

  const cols = Math.ceil(Math.sqrt(layouts.length))
  const rows = Math.ceil(layouts.length / cols)

  // Uniform cell dimensions = max width / height of any member
  const cellW = Math.max(...layouts.map(l => l.width))
  const cellH = Math.max(...layouts.map(l => l.height))

  const totalW = cols * cellW + (cols - 1) * gap
  const totalH = rows * cellH + (rows - 1) * gap

  const centroid = centroidOf(layouts)!
  const originX = centroid.x - totalW / 2
  const originY = centroid.y - totalH / 2

  layouts.forEach((l, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    out.set(l.id, {
      x: originX + col * (cellW + gap),
      y: originY + row * (cellH + gap),
    })
  })

  return out
}
