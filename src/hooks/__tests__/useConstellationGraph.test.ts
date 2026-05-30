import { describe, it, expect } from 'vitest'
import { nextFreeSlot, applyAssign, applyRemove } from '../useConstellationGraph'
import { emptyGraph, slotsForNode, nodesInSlot } from '../../domain/constellationGraph'

describe('useConstellationGraph reducers', () => {
  it('nextFreeSlot returns the lowest unoccupied slot', () => {
    let g = emptyGraph('s')
    g = applyAssign(g, '1', 'a')
    expect(nextFreeSlot(g)).toBe('2')
  })
  it('applyAssign adds a member edge', () => {
    const g = applyAssign(emptyGraph('s'), '3', 'pw-x')
    expect(slotsForNode(g, 'pw-x')).toEqual(['3'])
  })
  it('applyRemove drops the member edge and prunes a now-singleton slot', () => {
    let g = emptyGraph('s')
    g = applyAssign(g, '1', 'a'); g = applyAssign(g, '1', 'b')
    g = applyRemove(g, '1', 'a')
    expect(nodesInSlot(g, '1')).toEqual([]) // 'b' alone → slot pruned
  })
})
