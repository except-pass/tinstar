import { describe, expect, it } from 'vitest'
import { masonryRowSpan, slateColumnCount } from '../slateMasonry'

describe('slateColumnCount', () => {
  it('reflows from one to two to three columns as the Slate widens', () => {
    expect(slateColumnCount()).toBe(1)
    expect(slateColumnCount(419)).toBe(1)
    expect(slateColumnCount(420)).toBe(2)
    expect(slateColumnCount(699)).toBe(2)
    expect(slateColumnCount(700)).toBe(3)
    expect(slateColumnCount(900)).toBe(3)
  })
})

describe('masonryRowSpan', () => {
  it('reserves enough tiny rows for the measured card and its trailing gap', () => {
    expect(masonryRowSpan(0)).toBe(1)
    expect(masonryRowSpan(1)).toBe(1)
    expect(masonryRowSpan(82)).toBe(10)
    expect(masonryRowSpan(83)).toBe(11)
  })

  it('contains invalid measurements instead of leaking an invalid grid span', () => {
    expect(masonryRowSpan(Number.NaN)).toBe(1)
    expect(masonryRowSpan(Number.POSITIVE_INFINITY)).toBe(1)
    expect(masonryRowSpan(-20)).toBe(1)
  })
})
