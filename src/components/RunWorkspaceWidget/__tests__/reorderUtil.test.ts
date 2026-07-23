import { describe, it, expect } from 'vitest'
import { moveItem } from '../reorderUtil'

// The reorder affordance is chevrons, not drag, precisely so the interesting part
// is this index math — testable directly instead of through a pointer simulation
// that doesn't survive the canvas transform.
describe('moveItem (S6 U2)', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves an item up and down in the middle of the list', () => {
    expect(moveItem(ids, 2, 1)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveItem(ids, 1, 2)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveItem(ids, 0, 3)).toEqual(['b', 'c', 'd', 'a'])
    expect(moveItem(ids, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('is a no-op past either end (what makes the end chevrons harmless)', () => {
    expect(moveItem(ids, 0, -1)).toEqual(ids)
    expect(moveItem(ids, 3, 4)).toEqual(ids)
    expect(moveItem(ids, -1, 0)).toEqual(ids)
    expect(moveItem(ids, 9, 0)).toEqual(ids)
    expect(moveItem(ids, 1, 1)).toEqual(ids)
    expect(moveItem([], 0, 1)).toEqual([])
  })

  it('never mutates its input', () => {
    const original = [...ids]
    moveItem(ids, 0, 3)
    expect(ids).toEqual(original)
  })

  it('handles a single-item list', () => {
    expect(moveItem(['only'], 0, 1)).toEqual(['only'])
    expect(moveItem(['only'], 0, -1)).toEqual(['only'])
  })
})
