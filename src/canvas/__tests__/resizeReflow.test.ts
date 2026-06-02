import { describe, it, expect } from 'vitest'
import { reflowOnResize, type ReflowMember } from '../resizeReflow'

// Resized widget starts at (0,0) 100×100 → right edge x=100, bottom edge y=100.
const start = { x: 0, y: 0, width: 100, height: 100 }

// Members carry their size so reflow can reason about real edge seams, not just corners.
const M = (id: string, x: number, y: number, width = 100, height = 100): ReflowMember =>
  ({ id, x, y, width, height })

describe('reflowOnResize', () => {
  it('returns no moves when size is unchanged', () => {
    const out = reflowOnResize({ start, final: { width: 100, height: 100 }, members: [M('R', 100, 0)] })
    expect(out.size).toBe(0)
  })

  it('pushes a flush right neighbor outward when growing wider', () => {
    const out = reflowOnResize({ start, final: { width: 140, height: 100 }, members: [M('R', 100, 0)] })
    expect(out.get('R')).toEqual({ x: 140, y: 0 }) // +40 width
  })

  it('pulls a flush right neighbor back in when shrinking', () => {
    const out = reflowOnResize({ start, final: { width: 70, height: 100 }, members: [M('R', 100, 0)] })
    expect(out.get('R')).toEqual({ x: 70, y: 0 }) // -30 width
  })

  it('pushes a below neighbor down when growing taller', () => {
    const out = reflowOnResize({ start, final: { width: 100, height: 130 }, members: [M('B', 0, 100)] })
    expect(out.get('B')).toEqual({ x: 0, y: 130 })
  })

  it('does not move members to the left of / above the resized widget', () => {
    const out = reflowOnResize({
      start,
      final: { width: 140, height: 140 },
      members: [M('LEFT', -100, 0), M('ABOVE', 0, -100)],
    })
    expect(out.size).toBe(0)
  })

  it('preserves the relative layout of a row of members (all shift equally)', () => {
    // Two members flush to the right: R1 at x=100 (80 wide), R2 at x=180.
    const out = reflowOnResize({
      start,
      final: { width: 130, height: 100 },
      members: [M('R1', 100, 0, 80, 100), M('R2', 180, 0)],
    })
    expect(out.get('R1')).toEqual({ x: 130, y: 0 }) // +30
    expect(out.get('R2')).toEqual({ x: 210, y: 0 }) // +30 — spacing preserved
  })

  it('shifts a 2×2 grid corner member by both deltas via its edge neighbors', () => {
    // R(resized) top-left, B right of R, C below R, D bottom-right. D is edge-flush to
    // both B (below it) and C (right of it), so a corner resize carries D by both deltas.
    const out = reflowOnResize({
      start,
      final: { width: 120, height: 150 },
      members: [M('B', 100, 0), M('C', 0, 100), M('D', 100, 100)],
    })
    expect(out.get('B')).toEqual({ x: 120, y: 0 })   // right neighbor: +dw only
    expect(out.get('C')).toEqual({ x: 0, y: 150 })    // below neighbor: +dh only
    expect(out.get('D')).toEqual({ x: 120, y: 150 })  // corner: +dw and +dh
  })

  it('does NOT drag an L-shape member that is only snapped to a lower neighbor', () => {
    // R(resized) top-left, C directly below R, D to the right of C (NOT touching R's
    // right edge — they meet only at a corner point). Widening R must not shift D, or
    // the global-threshold bug reappears: D would tear away from C, opening a gap.
    const out = reflowOnResize({
      start,
      final: { width: 140, height: 100 }, // width only
      members: [M('C', 0, 100), M('D', 100, 100)],
    })
    expect(out.has('D')).toBe(false)
    expect(out.has('C')).toBe(false) // C is below, unaffected by a width change
    expect(out.size).toBe(0)
  })

  it('grows the L-shape downward correctly: bottom column follows, right-of-column follows', () => {
    // Same L-shape, but now grow R's bottom edge. C (below R) shifts down; D (right of C)
    // shifts down with it to keep the C–D seam.
    const out = reflowOnResize({
      start,
      final: { width: 100, height: 160 }, // height only, +60
      members: [M('C', 0, 100), M('D', 100, 100)],
    })
    expect(out.get('C')).toEqual({ x: 0, y: 160 })
    expect(out.get('D')).toEqual({ x: 100, y: 160 })
  })
})
