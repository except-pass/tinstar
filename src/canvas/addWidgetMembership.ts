import type { ConstellationSlot } from '../domain/constellationGraph'

export interface MembershipPlan {
  assigns: Array<{ slot: ConstellationSlot; nodeId: string }>
  /** Snap edge to persist, or undefined when there is no constellation capacity.
   *  A snap edge is only emitted alongside slot membership — never on its own —
   *  to match the drag snap-commit flow, which rolls back (no persisted snap)
   *  when slots are full rather than leaving an unslotted snapped pair behind. */
  snap?: { a: string; b: string }
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
}): MembershipPlan {
  const { sourceSlot, freeSlot, sourceId, newId } = input
  const snap = { a: sourceId, b: newId }
  if (sourceSlot) return { assigns: [{ slot: sourceSlot, nodeId: newId }], snap }
  if (freeSlot) {
    return { assigns: [{ slot: freeSlot, nodeId: sourceId }, { slot: freeSlot, nodeId: newId }], snap }
  }
  return { assigns: [] }
}
