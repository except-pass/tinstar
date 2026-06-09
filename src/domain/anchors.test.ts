import { describe, it, expect } from 'vitest'
import { DEFAULT_ANCHORS, anchorByName, validateAnchors, type Anchor } from './anchors'

describe('DEFAULT_ANCHORS', () => {
  it('has the 8 corner + edge-midpoint anchors, no center', () => {
    const names = DEFAULT_ANCHORS.map(a => a.name).sort()
    expect(names).toEqual([
      'bottom-center', 'bottom-left', 'bottom-right',
      'middle-left', 'middle-right',
      'top-center', 'top-left', 'top-right',
    ])
    expect(names).not.toContain('center')
  })
  it('uses fractional coords in [0,1]', () => {
    for (const a of DEFAULT_ANCHORS) {
      expect(a.x).toBeGreaterThanOrEqual(0); expect(a.x).toBeLessThanOrEqual(1)
      expect(a.y).toBeGreaterThanOrEqual(0); expect(a.y).toBeLessThanOrEqual(1)
    }
    expect(anchorByName(DEFAULT_ANCHORS, 'top-right')).toEqual({ name: 'top-right', x: 1, y: 0 })
    expect(anchorByName(DEFAULT_ANCHORS, 'middle-right')).toEqual({ name: 'middle-right', x: 1, y: 0.5 })
  })
})

describe('anchorByName', () => {
  it('returns undefined for an unknown name', () => {
    expect(anchorByName(DEFAULT_ANCHORS, 'center')).toBeUndefined()
  })
})

describe('validateAnchors', () => {
  it('accepts a valid custom set', () => {
    const set: Anchor[] = [{ name: 'a', x: 0, y: 0 }, { name: 'b', x: 1, y: 1 }]
    expect(validateAnchors(set)).toBeNull()
  })
  it('rejects out-of-range coords, empty names, and duplicates', () => {
    expect(validateAnchors([{ name: 'a', x: 2, y: 0 }])).toMatch(/in \[0,1\]/)
    expect(validateAnchors([{ name: '', x: 0, y: 0 }])).toMatch(/non-empty/)
    expect(validateAnchors([{ name: 'a', x: 0, y: 0 }, { name: 'a', x: 1, y: 1 }])).toMatch(/duplicate/)
  })
})
