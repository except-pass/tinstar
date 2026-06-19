import { resolveSnapTarget, resolveSnapCommit, type SnapWidget } from './snapZoneResolver'
import { applyAssign } from '../hooks/useConstellationGraph'
import { addSnap, type ConstellationGraph, type ConstellationSlot } from '../domain/constellationGraph'
import type { Rect } from './constellationCohesion'

export interface DropSnapPlan {
  /** Where the dropped widget should land: flush against the snapped neighbor, or the
   *  raw drop rect when nothing snapped. Width/height come straight from `dropRect`. */
  layout: { x: number; y: number; width: number; height: number }
  /** The graph with membership + a snap edge applied, or the input graph untouched. */
  graph: ConstellationGraph
  /** Whether the widget joined a constellation. */
  snapped: boolean
}

/**
 * Decide where a freshly-dropped widget lands and whether it joins a constellation —
 * the drop-time equivalent of releasing a manual drag. The drop point drives the
 * outcome: snap flush to (and join) the nearest snappable neighbor within
 * `snapDistance`, otherwise leave the widget free at the drop point. Membership is
 * therefore only ever created when the widget actually sits flush — no "member but
 * floating" divergence. Reuses `resolveSnapTarget`/`resolveSnapCommit` so drop and
 * drag-release share one snap brain, and stores the resolved anchor pair on the edge.
 */
export function planDropSnap(
  nodeId: string,
  dropRect: Rect,
  neighbors: SnapWidget[],
  snapDistance: number,
  graph: ConstellationGraph,
  slotByNode: Map<string, ConstellationSlot>,
  occupiedSlots: Set<ConstellationSlot>,
): DropSnapPlan {
  const free: DropSnapPlan = { layout: { ...dropRect }, graph, snapped: false }

  const target = resolveSnapTarget(nodeId, dropRect, neighbors, snapDistance)
  if (!target) return free

  const layout = { x: target.x, y: target.y, width: dropRect.width, height: dropRect.height }
  const commit = resolveSnapCommit(target, slotByNode, occupiedSlots)

  if (commit.kind === 'join') {
    let next = applyAssign(graph, commit.slot, nodeId)
    next = addSnap(next, nodeId, target.targetId, target.anchors)
    return { layout, graph: next, snapped: true }
  }
  if (commit.kind === 'form') {
    let next = applyAssign(graph, commit.slot, nodeId)
    next = applyAssign(next, commit.slot, commit.withId)
    next = addSnap(next, nodeId, commit.withId, target.anchors)
    return { layout, graph: next, snapped: true }
  }
  // rollback (e.g. every slot occupied): can't join, so don't snap geometry to a
  // widget the newcomer won't be grouped with — leave it free at the drop point.
  return free
}
