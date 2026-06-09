// src/canvas/anchors.ts
// Anchor geometry: anchor canvas-positions, anchor-to-anchor placement, and
// nearest-pair resolution for drag-to-snap.
import type { Anchor, AnchorPair } from '../domain/anchors'
import type { Point, Rect } from './constellationCohesion'

/** Canvas coordinate of `a` on a widget laid out at `rect`. */
export function anchorPoint(rect: Rect, a: Anchor): Point {
  return { x: rect.x + a.x * rect.width, y: rect.y + a.y * rect.height }
}

/** Top-left for a widget of `size` so that `sourceAnchor` (on the new widget)
 *  coincides with `targetAnchor`'s point on `target`. */
export function anchorPosition(
  target: Rect,
  targetAnchor: Anchor,
  sourceAnchor: Anchor,
  size: { width: number; height: number },
): Point {
  const p = anchorPoint(target, targetAnchor)
  return { x: p.x - sourceAnchor.x * size.width, y: p.y - sourceAnchor.y * size.height }
}

/** The closest (dragged-anchor, target-anchor) pair by canvas distance. */
export function nearestAnchorPair(
  dragged: Rect,
  draggedAnchors: Anchor[],
  target: Rect,
  targetAnchors: Anchor[],
): { pair: AnchorPair; distance: number } {
  let best = Infinity
  let pair: AnchorPair = [draggedAnchors[0]!.name, targetAnchors[0]!.name]
  for (const da of draggedAnchors) {
    const dp = anchorPoint(dragged, da)
    for (const ta of targetAnchors) {
      const tp = anchorPoint(target, ta)
      const d = Math.hypot(dp.x - tp.x, dp.y - tp.y)
      if (d < best) { best = d; pair = [da.name, ta.name] }
    }
  }
  return { pair, distance: best }
}
