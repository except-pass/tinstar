import type { ConstellationSlot } from '../domain/constellationGraph'

export interface MembershipPlan {
  assigns: Array<{ slot: ConstellationSlot; nodeId: string }>
  snap: { a: string; b: string }
}

/** Decide constellation membership when adding `newId` next to `sourceId`.
 *  - source already in a slot → newcomer joins it.
 *  - source unslotted but a free slot exists → form a new constellation with both.
 *  - no free slot → snap visually only (no slot assignment). */
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
  return { assigns: [], snap }
}
