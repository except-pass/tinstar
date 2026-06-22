import { describe, it, expect } from 'vitest'
import { flushPosition } from '../snapZoneResolver'
import { SNAP_GAP } from '../snapConstants'

const src = { x: 100, y: 100, width: 200, height: 150 }
const size = { width: 80, height: 60 }

// flushPosition leaves a SNAP_GAP gutter on the snapped axis (room for the
// constellation link); the cross-axis stays edge-aligned.
describe('flushPosition', () => {
  it('right: gutter past right edge, top-aligned', () => {
    expect(flushPosition(src, 'right', size)).toEqual({ x: 300 + SNAP_GAP, y: 100 })
  })
  it('left: gutter before left edge, top-aligned', () => {
    expect(flushPosition(src, 'left', size)).toEqual({ x: 20 - SNAP_GAP, y: 100 })
  })
  it('bottom: gutter below, left-aligned', () => {
    expect(flushPosition(src, 'bottom', size)).toEqual({ x: 100, y: 250 + SNAP_GAP })
  })
  it('top: gutter above, left-aligned', () => {
    expect(flushPosition(src, 'top', size)).toEqual({ x: 100, y: 40 - SNAP_GAP })
  })
})
