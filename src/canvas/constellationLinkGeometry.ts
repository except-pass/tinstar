// src/canvas/constellationLinkGeometry.ts
// Pure geometry for drawing the "constellation link" between two snapped widgets:
// the two endpoints (where a star sits on each widget) and the line between them.
import { DEFAULT_ANCHORS, anchorByName, type AnchorPair } from '../domain/anchors'
import { anchorPoint } from './anchors'
import type { Point, Rect } from './constellationCohesion'
import type { ConstellationGraph } from '../domain/constellationGraph'

/** Point of a named default anchor on `rect`, or null when the name is unknown
 *  (e.g. a plugin's custom anchor we don't have the fractions for here). */
function defaultAnchorPoint(rect: Rect, name: string): Point | null {
  const a = anchorByName(DEFAULT_ANCHORS, name)
  return a ? anchorPoint(rect, a) : null
}

/** Midpoints of the two edges that face each other across the gap between a and b.
 *  Used as a fallback when an edge has no stored anchor pair (legacy snaps). */
export function facingAnchorPoints(a: Rect, b: Rect): { a: Point; b: Point } {
  const acx = a.x + a.width / 2, acy = a.y + a.height / 2
  const bcx = b.x + b.width / 2, bcy = b.y + b.height / 2
  const dx = bcx - acx, dy = bcy - acy
  if (Math.abs(dx) >= Math.abs(dy)) {
    // Side by side: right-of-a ↔ left-of-b (or mirror).
    return dx >= 0
      ? { a: { x: a.x + a.width, y: acy }, b: { x: b.x, y: bcy } }
      : { a: { x: a.x, y: acy }, b: { x: b.x + b.width, y: bcy } }
  }
  // Stacked: bottom-of-a ↔ top-of-b (or mirror).
  return dy >= 0
    ? { a: { x: acx, y: a.y + a.height }, b: { x: bcx, y: b.y } }
    : { a: { x: acx, y: a.y }, b: { x: bcx, y: b.y + b.height } }
}

/** Where the two stars sit. Uses the stored anchor pair when both names resolve,
 *  else falls back to the facing-edge midpoints so legacy/custom edges still draw. */
export function linkEndpoints(
  a: Rect,
  b: Rect,
  anchors?: AnchorPair,
): { a: Point; b: Point } {
  if (anchors) {
    const pa = defaultAnchorPoint(a, anchors[0])
    const pb = defaultAnchorPoint(b, anchors[1])
    if (pa && pb) return { a: pa, b: pb }
  }
  return facingAnchorPoints(a, b)
}

export interface ConstellationLink {
  /** Stable key for this edge (canon-ordered node ids). */
  id: string
  aId: string
  bId: string
  /** Star position on each widget. */
  a: Point
  b: Point
  /** Whether this link's constellation is currently focused (brighter chrome). */
  active: boolean
}

/**
 * Build a render descriptor per snapped edge whose both widgets have a live rect.
 * `isActive(aId, bId)` decides the brighter "focused" treatment (e.g. the slot is
 * hotkey-active or a member is selected). Pure — no React, no DOM.
 */
export function buildConstellationLinks(
  graph: ConstellationGraph,
  rectById: Map<string, Rect>,
  isActive: (aId: string, bId: string) => boolean,
): ConstellationLink[] {
  const out: ConstellationLink[] = []
  for (const edge of graph.snapped) {
    const [aId, bId] = edge.nodes
    const a = rectById.get(aId)
    const b = rectById.get(bId)
    if (!a || !b) continue
    const ends = linkEndpoints(a, b, edge.anchors)
    out.push({ id: `${aId}__${bId}`, aId, bId, a: ends.a, b: ends.b, active: isActive(aId, bId) })
  }
  return out
}
