// src/server/api/attachPlan.ts
// Pure core of the attach-widget operation: computes the new widget's top-left
// position (so the chosen anchors coincide) and the next constellation graph
// (slot join/form + snap edge). Extracted from attachWidget in routes.ts so
// the logic is unit-testable without a ctx/docStore.

import { anchorPosition } from '../../canvas/anchors'
import { DEFAULT_ANCHORS, anchorByName } from '../../domain/anchors'
import type { AnchorPair } from '../../domain/anchors'
import { addMember, addSnap, slotsForNode, type ConstellationGraph, type ConstellationSlot } from '../../domain/constellationGraph'
import type { Rect } from '../../canvas/constellationCohesion'
import type { ParsedAttach } from './anchorAttach'

export interface AttachPlan {
  /** Next graph (membership + snap applied); === input graph when no slot was available. */
  graph: ConstellationGraph
  position: { x: number; y: number }
}

/** Pure: given the current graph, the target's layout, and a parsed attach, compute the
 *  new widget's top-left (so the anchors coincide) and the next graph with the new widget
 *  joined to the target's slot (or a newly-formed slot) plus the snap edge carrying the
 *  anchor pair. When all 9 slots are occupied and the target has none, no membership/snap
 *  is written (graph returned unchanged) but the position is still returned. */
export function planAttach(
  graph: ConstellationGraph,
  targetLayout: Rect,
  attach: ParsedAttach,
  widgetId: string,
  size: { width: number; height: number },
): AttachPlan {
  const ta = anchorByName(DEFAULT_ANCHORS, attach.targetAnchor)!
  const na = anchorByName(DEFAULT_ANCHORS, attach.newAnchor)!
  const position = anchorPosition(targetLayout, ta, na, size)

  const targetSlot = slotsForNode(graph, attach.to)[0] ?? null
  let next = graph
  let slot: ConstellationSlot | null = targetSlot
  if (!slot) {
    const used = new Set(graph.members.map(m => m.slot))
    slot = (['1','2','3','4','5','6','7','8','9'] as ConstellationSlot[]).find(s => !used.has(s)) ?? null
    if (slot) next = addMember(next, attach.to, slot)
  }
  if (slot) {
    next = addMember(next, widgetId, slot)
    const pair: AnchorPair = [attach.targetAnchor, attach.newAnchor]
    next = addSnap(next, attach.to, widgetId, pair)
  }
  return { graph: next, position }
}
