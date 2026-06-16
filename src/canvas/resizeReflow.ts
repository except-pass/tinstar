export interface ReflowRect { x: number; y: number; width: number; height: number }
export interface ReflowMember extends ReflowRect { id: string }

import { ADJACENCY_TOL } from './snapConstants'

export interface ResizeReflowInput {
  /** The resized widget's geometry at resize-START (top-left is fixed; only size changes). */
  start: ReflowRect
  /** The resized widget's size at resize-END. */
  final: { width: number; height: number }
  /** Co-members of the same constellation, EXCLUDING the resized widget, at their resize-START geometry. */
  members: ReflowMember[]
}

// Snapped widgets sit a SNAP_GAP gutter apart (not flush), so contact detection
// must tolerate that gap; ADJACENCY_TOL is sized to exceed it. Shifting members
// by the resize delta preserves whatever gap existed.
const CONTACT_TOL = ADJACENCY_TOL

function overlap1D(aStart: number, aLen: number, bStart: number, bLen: number): number {
  return Math.min(aStart + aLen, bStart + bLen) - Math.max(aStart, bStart)
}

/** a and b share a vertical edge seam (a's right meets b's left or vice versa) with y-overlap. */
function sharesVerticalEdge(a: ReflowRect, b: ReflowRect): boolean {
  if (overlap1D(a.y, a.height, b.y, b.height) <= 0) return false
  const gap = Math.min(Math.abs((a.x + a.width) - b.x), Math.abs((b.x + b.width) - a.x))
  return gap <= CONTACT_TOL
}

/** a and b share a horizontal edge seam (a's bottom meets b's top or vice versa) with x-overlap. */
function sharesHorizontalEdge(a: ReflowRect, b: ReflowRect): boolean {
  if (overlap1D(a.x, a.width, b.x, b.width) <= 0) return false
  const gap = Math.min(Math.abs((a.y + a.height) - b.y), Math.abs((b.y + b.height) - a.y))
  return gap <= CONTACT_TOL
}

function adjacent(a: ReflowRect, b: ReflowRect): boolean {
  return sharesVerticalEdge(a, b) || sharesHorizontalEdge(a, b)
}

/**
 * The members that should shift along `axis` when the resized widget's far edge moves.
 *
 * Adjacency-aware, NOT a global threshold: a member shifts only if it is connected to the
 * resized widget THROUGH the moved edge — i.e. it is in the half-plane beyond that edge AND
 * reachable from the resized widget via a chain of edge seams whose every hop also lies in
 * that half-plane. Seeding starts from the seam on the moved edge itself (vertical edge for
 * width, horizontal edge for height); propagation then follows any edge seam between
 * in-region members, so a shifted member carries its stacked/rowed neighbors with it.
 *
 * This is why widening the top-left widget of an L-shaped constellation does NOT drag a widget
 * that is only snapped to a lower neighbor: that widget isn't reachable from the moved edge
 * without leaving the half-plane, so it stays put and its seam is preserved.
 */
function connectedRegion(start: ReflowRect, members: ReflowMember[], axis: 'x' | 'y'): Set<string> {
  const edge = axis === 'x' ? start.x + start.width : start.y + start.height
  const region = members.filter(m => (axis === 'x' ? m.x : m.y) >= edge - CONTACT_TOL)
  const seedTest = axis === 'x' ? sharesVerticalEdge : sharesHorizontalEdge
  const shifted = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const m of region) {
      if (shifted.has(m.id)) continue
      const reached = seedTest(start, m) || region.some(o => shifted.has(o.id) && adjacent(o, m))
      if (reached) { shifted.add(m.id); changed = true }
    }
  }
  return shifted
}

/**
 * Re-snap a constellation after one of its widgets is resized from the bottom-right corner.
 *
 * The resized widget's top-left is fixed, so only its right/bottom edges move. Members
 * connected to the moved right edge shift by Δwidth; members connected to the moved bottom
 * edge shift by Δheight (corner-grid members get both). Because the start layout is flush,
 * applying the net delta yields a flush layout again — any overlap/gap created mid-resize is
 * discarded. Works symmetrically for growing (push out) and shrinking (pull in).
 *
 * Returns only the members that move (new absolute positions); pure, no side effects.
 */
export function reflowOnResize(input: ResizeReflowInput): Map<string, { x: number; y: number }> {
  const { start, final, members } = input
  const dw = final.width - start.width
  const dh = final.height - start.height
  const out = new Map<string, { x: number; y: number }>()
  if (dw === 0 && dh === 0) return out

  const xShift = dw !== 0 ? connectedRegion(start, members, 'x') : new Set<string>()
  const yShift = dh !== 0 ? connectedRegion(start, members, 'y') : new Set<string>()

  for (const m of members) {
    const sx = xShift.has(m.id)
    const sy = yShift.has(m.id)
    if (!sx && !sy) continue
    out.set(m.id, { x: m.x + (sx ? dw : 0), y: m.y + (sy ? dh : 0) })
  }
  return out
}
