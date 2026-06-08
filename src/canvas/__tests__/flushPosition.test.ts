import { describe, it, expect } from 'vitest'
import { flushPosition } from '../snapZoneResolver'

const src = { x: 100, y: 100, width: 200, height: 150 }
const size = { width: 80, height: 60 }

describe('flushPosition', () => {
  it('right: flush against right edge, top-aligned', () => {
    expect(flushPosition(src, 'right', size)).toEqual({ x: 300, y: 100 })
  })
  it('left: flush against left edge, top-aligned', () => {
    expect(flushPosition(src, 'left', size)).toEqual({ x: 20, y: 100 })
  })
  it('bottom: flush below, left-aligned', () => {
    expect(flushPosition(src, 'bottom', size)).toEqual({ x: 100, y: 250 })
  })
  it('top: flush above, left-aligned', () => {
    expect(flushPosition(src, 'top', size)).toEqual({ x: 100, y: 40 })
  })
})
