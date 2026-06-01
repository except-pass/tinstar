export interface ReflowRect { x: number; y: number; width: number; height: number }
export interface ReflowMember { id: string; x: number; y: number }

export interface ResizeReflowInput {
  /** The resized widget's geometry at resize-START (top-left is fixed; only size changes). */
  start: ReflowRect
  /** The resized widget's size at resize-END. */
  final: { width: number; height: number }
  /** Co-members of the same constellation, EXCLUDING the resized widget, at their resize-START positions. */
  members: ReflowMember[]
}

/**
 * Re-snap a constellation after one of its widgets is resized from the bottom-right corner.
 *
 * The resized widget's top-left is fixed, so only its right/bottom edges move. Members whose
 * left edge sits at-or-beyond the widget's start right edge shift by Δwidth; members at-or-below
 * its start bottom edge shift by Δheight (corner members get both). Because the start layout is
 * flush, applying the net delta yields a flush layout again — any overlap/gap created mid-resize
 * is discarded. Works symmetrically for growing (push out) and shrinking (pull in).
 *
 * Returns only the members that move (new absolute positions); pure, no side effects.
 */
export function reflowOnResize(input: ResizeReflowInput): Map<string, { x: number; y: number }> {
  const { start, final, members } = input
  const dw = final.width - start.width
  const dh = final.height - start.height
  const out = new Map<string, { x: number; y: number }>()
  if (dw === 0 && dh === 0) return out

  const right = start.x + start.width
  const bottom = start.y + start.height
  for (const m of members) {
    let nx = m.x
    let ny = m.y
    let moved = false
    if (dw !== 0 && m.x >= right) { nx = m.x + dw; moved = true }
    if (dh !== 0 && m.y >= bottom) { ny = m.y + dh; moved = true }
    if (moved) out.set(m.id, { x: nx, y: ny })
  }
  return out
}
