import { describe, it, expect } from 'vitest'
import { reflowOnResize } from '../resizeReflow'

// Resized widget starts at (0,0) 100×100 → right edge x=100, bottom edge y=100.
const start = { x: 0, y: 0, width: 100, height: 100 }

describe('reflowOnResize', () => {
  it('returns no moves when size is unchanged', () => {
    const out = reflowOnResize({ start, final: { width: 100, height: 100 }, members: [{ id: 'R', x: 100, y: 0 }] })
    expect(out.size).toBe(0)
  })

  it('pushes a flush right neighbor outward when growing wider', () => {
    const out = reflowOnResize({ start, final: { width: 140, height: 100 }, members: [{ id: 'R', x: 100, y: 0 }] })
    expect(out.get('R')).toEqual({ x: 140, y: 0 }) // +40 width
  })

  it('pulls a flush right neighbor back in when shrinking', () => {
    const out = reflowOnResize({ start, final: { width: 70, height: 100 }, members: [{ id: 'R', x: 100, y: 0 }] })
    expect(out.get('R')).toEqual({ x: 70, y: 0 }) // -30 width
  })

  it('pushes a below neighbor down when growing taller', () => {
    const out = reflowOnResize({ start, final: { width: 100, height: 130 }, members: [{ id: 'B', x: 0, y: 100 }] })
    expect(out.get('B')).toEqual({ x: 0, y: 130 })
  })

  it('shifts a corner (right+below) member by both deltas', () => {
    const out = reflowOnResize({
      start,
      final: { width: 120, height: 150 },
      members: [{ id: 'C', x: 100, y: 100 }],
    })
    expect(out.get('C')).toEqual({ x: 120, y: 150 })
  })

  it('does not move members to the left of / above the resized widget', () => {
    const out = reflowOnResize({
      start,
      final: { width: 140, height: 140 },
      members: [
        { id: 'LEFT', x: -100, y: 0 },  // left of start.x=0 → x < right but also < start.x; not shifted horizontally
        { id: 'ABOVE', x: 0, y: -100 }, // above → not shifted vertically
      ],
    })
    // LEFT: x=-100 < right(100) → no x shift; y=0 < bottom(100) → no y shift → unmoved
    // ABOVE: x=0 < right → no x shift; y=-100 < bottom → no y shift → unmoved
    expect(out.size).toBe(0)
  })

  it('preserves the relative layout of a row of members (all shift equally)', () => {
    // Two members flush to the right: R1 at x=100, R2 at x=180 (R1 is 80 wide).
    const out = reflowOnResize({
      start,
      final: { width: 130, height: 100 },
      members: [{ id: 'R1', x: 100, y: 0 }, { id: 'R2', x: 180, y: 0 }],
    })
    expect(out.get('R1')).toEqual({ x: 130, y: 0 }) // +30
    expect(out.get('R2')).toEqual({ x: 210, y: 0 }) // +30 — spacing preserved
  })
})
