import { describe, it, expect } from 'vitest'
import { anchorPoint, anchorPosition, nearestAnchorPair } from './anchors'
import { DEFAULT_ANCHORS, anchorByName } from '../domain/anchors'

const A = (name: string) => anchorByName(DEFAULT_ANCHORS, name)!
const target = { x: 100, y: 100, width: 200, height: 100 }

describe('anchorPoint', () => {
  it('maps fractional anchor to canvas coords', () => {
    expect(anchorPoint(target, A('top-left'))).toEqual({ x: 100, y: 100 })
    expect(anchorPoint(target, A('bottom-right'))).toEqual({ x: 300, y: 200 })
    expect(anchorPoint(target, A('middle-right'))).toEqual({ x: 300, y: 150 })
  })
})

describe('anchorPosition', () => {
  it('places source so its anchor coincides with the target anchor point', () => {
    const size = { width: 80, height: 100 }
    const pos = anchorPosition(target, A('top-left'), A('top-right'), size)
    expect(pos).toEqual({ x: 100 - 80, y: 100 })
  })
  it('center-aligns via edge-midpoint pairs (middle-right → middle-left)', () => {
    const size = { width: 80, height: 60 }
    const pos = anchorPosition(target, A('middle-right'), A('middle-left'), size)
    expect(pos).toEqual({ x: 300, y: 150 - 30 })
  })
})

describe('nearestAnchorPair', () => {
  it('picks the closest [draggedAnchor, targetAnchor] pair', () => {
    const dragged = { x: 305, y: 100, width: 200, height: 100 }
    const { pair } = nearestAnchorPair(dragged, DEFAULT_ANCHORS, target, DEFAULT_ANCHORS)
    expect(pair[0]).toMatch(/-left$|^middle-left$/)
    expect(pair[1]).toMatch(/-right$|^middle-right$/)
  })
})
