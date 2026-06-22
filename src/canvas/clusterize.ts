// Group canvas layouts into rigid blocks by snap-edge connectivity. Each block
// is a connected component of `snapped` edges; widgets with no snap edge are
// singleton blocks. Arrange tools treat each block as one rigid unit.
import { boundingBoxOf, type Rect } from './constellationCohesion'
import type { ConstellationGraph } from '../domain/constellationGraph'

export interface ClusterBlock {
  members: Array<Rect & { id: string }>
  bbox: Rect
}

export function clusterize(
  layouts: Array<Rect & { id: string }>,
  graph: ConstellationGraph,
): ClusterBlock[] {
  const byId = new Map(layouts.map(l => [l.id, l]))
  const adj = new Map<string, Set<string>>()
  for (const l of layouts) adj.set(l.id, new Set())
  for (const { nodes: [a, b] } of graph.snapped) {
    if (adj.has(a) && adj.has(b)) { adj.get(a)!.add(b); adj.get(b)!.add(a) }
  }
  const seen = new Set<string>()
  const blocks: ClusterBlock[] = []
  for (const l of layouts) {
    if (seen.has(l.id)) continue
    const members: Array<Rect & { id: string }> = []
    const queue = [l.id]
    seen.add(l.id)
    while (queue.length) {
      const cur = queue.shift()!
      const rect = byId.get(cur)
      if (rect) members.push(rect)
      for (const nb of adj.get(cur) ?? []) if (!seen.has(nb)) { seen.add(nb); queue.push(nb) }
    }
    blocks.push({ members, bbox: boundingBoxOf(members)! })
  }
  return blocks
}

/** Member-id arrays for clusters with >= 2 members (the rigid groups for preserveCohesion). */
export function clusterGroups(
  layouts: Array<Rect & { id: string }>,
  graph: ConstellationGraph,
): string[][] {
  return clusterize(layouts, graph)
    .filter(b => b.members.length >= 2)
    .map(b => b.members.map(m => m.id))
}
