import { flushPosition, EDGE_ANCHORS } from '../canvas/snapZoneResolver'
import type { SnapEdge } from '../canvas/snapZoneResolver'
import { composeAddWidgetMembership } from '../canvas/addWidgetMembership'
import {
  slotsForNode, snapNeighbors, removeMember, removeSnap,
  type ConstellationGraph,
} from './constellationGraph'
import type { WidgetLayout } from '../hooks/useWidgetLayouts'

export interface MoveSnapOps {
  getLayout: (id: string) => WidgetLayout | undefined
  insertLayout: (id: string, layout: WidgetLayout) => void
  updateConstellation: (compute: (g: ConstellationGraph) => ConstellationGraph) => void
}

/** Snap an EXISTING widget (`movedId`) flush into `sourceNodeId`'s `edge`,
 *  joining its constellation. Mirrors relocateWidgetTo's injected-ops style,
 *  but attaches (vs. detaches) and reuses the create path's flush + membership
 *  logic. Single widget moves; its old slot membership and snap seams are
 *  severed first so it leaves clean. If `movedId` was a snap hub, severing its
 *  seams may leave former co-slot members in a slot with no shared edge — this
 *  is intentional; the orchestrator moves only the selected widget and does not
 *  re-plan the vacated slot. */
export function moveSnapWidgetTo(
  movedId: string,
  sourceNodeId: string,
  edge: SnapEdge,
  ops: MoveSnapOps,
): void {
  const source = ops.getLayout(sourceNodeId)
  const moved = ops.getLayout(movedId)
  if (!source || !moved) return                       // vanished mid-menu → no-op

  const pos = flushPosition(source, edge, { width: moved.width, height: moved.height })
  ops.insertLayout(movedId, { x: pos.x, y: pos.y, width: moved.width, height: moved.height })

  ops.updateConstellation((g) => {
    let next = g
    for (const slot of slotsForNode(g, movedId)) next = removeMember(next, movedId, slot)
    for (const nb of snapNeighbors(g, movedId)) next = removeSnap(next, movedId, nb)
    return composeAddWidgetMembership(next, sourceNodeId, movedId, EDGE_ANCHORS[edge])
  })
}
