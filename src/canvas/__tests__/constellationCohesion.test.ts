import { describe, it, expect } from 'vitest'
import { centroidOf, boundingBoxOf, applyGroupDrag } from '../constellationCohesion'
import type { Rect } from '../constellationCohesion'

const R = (x: number, y: number, w = 100, h = 100): Rect =>
  ({ x, y, width: w, height: h })

describe('centroidOf', () => {
  it('returns null for empty input', () => {
    expect(centroidOf([])).toBeNull()
  })
  it('returns the center of a single widget', () => {
    expect(centroidOf([R(0, 0, 100, 100)])).toEqual({ x: 50, y: 50 })
  })
  it('averages the centers of multiple widgets', () => {
    expect(centroidOf([R(0, 0), R(200, 100)])).toEqual({ x: 150, y: 100 })
  })
})

describe('boundingBoxOf', () => {
  it('returns null for empty input', () => {
    expect(boundingBoxOf([])).toBeNull()
  })
  it('returns the rect of a single widget', () => {
    expect(boundingBoxOf([R(10, 20, 100, 50)])).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })
  it('returns the union rect of multiple widgets', () => {
    expect(boundingBoxOf([
      R(0, 0, 100, 100),
      R(200, 50, 100, 100),
    ])).toEqual({ x: 0, y: 0, width: 300, height: 150 })
  })
})

describe('applyGroupDrag', () => {
  it('returns a map of memberId → new position', () => {
    const result = applyGroupDrag(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 200, y: 100 },
      ],
      { dx: 10, dy: -5 },
    )
    expect(result.get('a')).toEqual({ x: 10, y: -5 })
    expect(result.get('b')).toEqual({ x: 210, y: 95 })
  })

  it('returns an empty map for no members', () => {
    expect(applyGroupDrag([], { dx: 10, dy: 10 }).size).toBe(0)
  })
})
