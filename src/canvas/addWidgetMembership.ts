import {
  addMember, addSnap, nextFreeSlot, slotsForNode as graphSlotsForNode,
  type ConstellationGraph, type ConstellationSlot,
} from '../domain/constellationGraph'
import type { AnchorPair } from '../domain/anchors'

export interface MembershipPlan {
  assigns: Array<{ slot: ConstellationSlot; nodeId: string }>
  /** Snap edge to persist, or undefined when there is no constellation capacity.
   *  A snap edge is only emitted alongside slot membership — never on its own —
   *  to match the drag snap-commit flow, which rolls back (no persisted snap)
   *  when slots are full rather than leaving an unslotted snapped pair behind. */
  snap?: { a: string; b: string; anchors?: AnchorPair }
}

/** Decide constellation membership when adding `newId` next to `sourceId`.
 *  - source already in a slot → newcomer joins it.
 *  - source unslotted but a free slot exists → form a new constellation with both.
 *  - no free slot → no membership and no snap (newcomer stays a free widget),
 *    matching resolveSnapCommit's rollback-on-full semantics. */
export function addWidgetMembership(input: {
  sourceSlot: ConstellationSlot | null
  freeSlot: ConstellationSlot | null
  sourceId: string
  newId: string
  anchors?: AnchorPair
}): MembershipPlan {
  const { sourceSlot, freeSlot, sourceId, newId, anchors } = input
  const snap = { a: sourceId, b: newId, anchors }
  if (sourceSlot) return { assigns: [{ slot: sourceSlot, nodeId: newId }], snap }
  if (freeSlot) {
    return { assigns: [{ slot: freeSlot, nodeId: sourceId }, { slot: freeSlot, nodeId: newId }], snap }
  }
  return { assigns: [] }
}

/** Compute AND apply the membership plan against `g` in one shot, returning the
 *  next graph. Computing sourceSlot/freeSlot from the passed-in graph (rather
 *  than a snapshot captured before an async widget-create) keeps the plan
 *  consistent with current state, and folding every assign + snap into a single
 *  returned graph lets callers persist the whole change as one atomic write
 *  instead of racing separate assign/snap PUTs. */
export function composeAddWidgetMembership(
  g: ConstellationGraph,
  sourceNodeId: string,
  newNodeId: string,
  anchors?: AnchorPair,
): ConstellationGraph {
  const sourceSlot = (graphSlotsForNode(g, sourceNodeId)[0] ?? null) as ConstellationSlot | null
  const plan = addWidgetMembership({ sourceSlot, freeSlot: nextFreeSlot(g), sourceId: sourceNodeId, newId: newNodeId, anchors })
  let next = g
  for (const a of plan.assigns) next = addMember(next, a.nodeId, a.slot)
  if (plan.snap) next = addSnap(next, plan.snap.a, plan.snap.b, plan.snap.anchors)
  return next
}
