import { centroidOf } from './constellationCohesion'
import type { Point, Rect } from './constellationCohesion'
import { clusterize } from './clusterize'
import type { ConstellationGraph } from '../domain/constellationGraph'

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

/** Grid arrange that keeps snap-attached widgets rigid: lays out cluster
 *  bounding boxes on a grid, then shifts each cluster's members by the block
 *  delta. Singletons behave exactly like the old per-widget tidy. */
export function tidyGridClusters(
  layouts: LayoutWithId[],
  graph: ConstellationGraph,
  gap: number,
): Map<string, Point> {
  const blocks = clusterize(layouts, graph)
  const blockRects = blocks.map((b, i) => ({ id: String(i), ...b.bbox }))
  const blockPositions = tidyGrid(blockRects, gap)
  const out = new Map<string, Point>()
  blocks.forEach((b, i) => {
    const np = blockPositions.get(String(i))!
    const dx = np.x - b.bbox.x
    const dy = np.y - b.bbox.y
    for (const m of b.members) out.set(m.id, { x: m.x + dx, y: m.y + dy })
  })
  return out
}
