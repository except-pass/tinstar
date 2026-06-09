import { describe, it, expect } from 'vitest'
import { clusterize, clusterGroups } from '../clusterize'
import { emptyGraph, addSnap } from '../../domain/constellationGraph'

const L = (id: string, x: number) => ({ id, x, y: 0, width: 100, height: 100 })

describe('clusterize', () => {
  it('groups snapped widgets into one block; singletons stand alone', () => {
    const g = addSnap(emptyGraph('s'), 'a', 'b', ['top-right', 'top-left'])
    const blocks = clusterize([L('a', 0), L('b', 100), L('c', 500)], g)
    const sizes = blocks.map(b => b.members.length).sort()
    expect(sizes).toEqual([1, 2])
    const big = blocks.find(b => b.members.length === 2)!
    expect(big.bbox).toEqual({ x: 0, y: 0, width: 200, height: 100 })
  })
})

describe('clusterGroups', () => {
  it('returns id-arrays for clusters of size >= 2 only (singletons excluded)', () => {
    const g = addSnap(emptyGraph('s'), 'a', 'b', ['top-right', 'top-left'])
    const groups = clusterGroups([L('a', 0), L('b', 100), L('c', 500)], g)
    expect(groups).toEqual([['a', 'b']])
  })
})
