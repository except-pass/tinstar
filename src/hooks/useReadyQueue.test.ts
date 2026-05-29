import { describe, it, expect } from 'vitest'
import { orderByHierarchy } from './useReadyQueue'

describe('orderByHierarchy', () => {
  it('reorders names to match hierarchy (top-to-bottom) order', () => {
    const hierarchy = ['alpha', 'bravo', 'charlie', 'delta']
    const ready = ['delta', 'alpha', 'charlie']
    expect(orderByHierarchy(ready, hierarchy)).toEqual(['alpha', 'charlie', 'delta'])
  })

  it('keeps names not in the hierarchy at the end, in original order', () => {
    const hierarchy = ['alpha', 'bravo']
    const ready = ['ghost2', 'bravo', 'ghost1', 'alpha']
    expect(orderByHierarchy(ready, hierarchy)).toEqual(['alpha', 'bravo', 'ghost2', 'ghost1'])
  })

  it('returns a new array and does not mutate the input', () => {
    const ready = ['b', 'a']
    const result = orderByHierarchy(ready, ['a', 'b'])
    expect(ready).toEqual(['b', 'a'])
    expect(result).not.toBe(ready)
  })

  it('handles an empty hierarchy by preserving input order', () => {
    expect(orderByHierarchy(['c', 'a', 'b'], [])).toEqual(['c', 'a', 'b'])
  })

  it('handles an empty name list', () => {
    expect(orderByHierarchy([], ['a', 'b'])).toEqual([])
  })

  it('uses the first occurrence rank when hierarchy has duplicates', () => {
    const hierarchy = ['a', 'b', 'a']
    expect(orderByHierarchy(['b', 'a'], hierarchy)).toEqual(['a', 'b'])
  })
})
