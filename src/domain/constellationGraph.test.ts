import { describe, it, expect } from 'vitest'
import {
  emptyGraph, addSnap, removeSnap, snapNeighbors,
  addMember, removeMember, slotsForNode, nodesInSlot,
  planBreak,
} from './constellationGraph'
import { nextFreeSlot } from '../hooks/useConstellationGraph'

describe('constellationGraph', () => {
  it('emptyGraph carries the spaceId and no edges', () => {
    const g = emptyGraph('space-1')
    expect(g.spaceId).toBe('space-1')
    expect(g.snapped).toEqual([])
    expect(g.members).toEqual([])
  })

  it('addSnap stores an undirected pair canonically and is idempotent', () => {
    let g = emptyGraph('s')
    g = addSnap(g, 'b', 'a')
    g = addSnap(g, 'a', 'b') // reverse + duplicate
    expect(g.snapped).toEqual([['a', 'b']])
    expect(snapNeighbors(g, 'a')).toEqual(['b'])
    expect(snapNeighbors(g, 'b')).toEqual(['a'])
  })

  it('removeSnap drops the pair in either order', () => {
    let g = addSnap(emptyGraph('s'), 'a', 'b')
    g = removeSnap(g, 'b', 'a')
    expect(g.snapped).toEqual([])
    expect(snapNeighbors(g, 'a')).toEqual([])
  })

  it('member edges drive slot derivation', () => {
    let g = emptyGraph('s')
    g = addMember(g, 'a', '1')
    g = addMember(g, 'b', '1')
    g = addMember(g, 'a', '1') // idempotent
    expect(slotsForNode(g, 'a')).toEqual(['1'])
    expect(nodesInSlot(g, '1').sort()).toEqual(['a', 'b'])
    g = removeMember(g, 'a', '1')
    expect(slotsForNode(g, 'a')).toEqual([])
    expect(nodesInSlot(g, '1')).toEqual(['b'])
  })

  it('planBreak: cut that does not disconnect changes nothing', () => {
    let g = emptyGraph('s')
    g = addSnap(g, 'a', 'b'); g = addSnap(g, 'b', 'c'); g = addSnap(g, 'a', 'c')
    for (const id of ['a', 'b', 'c']) g = addMember(g, id, '1')
    expect(planBreak(g, 'a', 'b', '1')).toEqual({ removeFromSlot: [], newGroup: [] })
  })

  it('planBreak: splits into larger keep + smaller leaver group (>=2 forms new group)', () => {
    let g = emptyGraph('s')
    g = addSnap(g, 'a', 'b'); g = addSnap(g, 'b', 'c')
    g = addSnap(g, 'c', 'd'); g = addSnap(g, 'd', 'e')
    for (const id of ['a', 'b', 'c', 'd', 'e']) g = addMember(g, id, '1')
    const plan = planBreak(g, 'c', 'd', '1')
    expect(plan.removeFromSlot.sort()).toEqual(['d', 'e'])
    expect(plan.newGroup.sort()).toEqual(['d', 'e'])
  })

  it('planBreak: stranded singleton leaves with no new group', () => {
    let g = addSnap(emptyGraph('s'), 'a', 'b')
    g = addMember(g, 'a', '1'); g = addMember(g, 'b', '1')
    const plan = planBreak(g, 'a', 'b', '1')
    expect(plan.removeFromSlot.sort()).toEqual(['a', 'b'])
    expect(plan.newGroup).toEqual([])
  })

  it('planBreak: liveIds prunes stale membership so the slot is actually freed', () => {
    // 'c' was deleted but its membership/snap edges were never pruned from the graph.
    let g = emptyGraph('s')
    g = addSnap(g, 'a', 'b'); g = addSnap(g, 'b', 'c')
    for (const id of ['a', 'b', 'c']) g = addMember(g, id, '1')
    // Without liveIds the stale 'c' inflates the keep side; with liveIds only the
    // two visible widgets are considered, so breaking a–b frees both — and the
    // stale 'c' is pruned too so slot '1' doesn't stay silently occupied.
    const plan = planBreak(g, 'a', 'b', '1', new Set(['a', 'b']))
    expect(plan.removeFromSlot.sort()).toEqual(['a', 'b', 'c'])
    expect(plan.newGroup).toEqual([])

    // Apply the break the way InfiniteCanvas does and assert the slot is freed.
    let next = removeSnap(g, 'a', 'b')
    for (const id of plan.removeFromSlot) next = removeMember(next, id, '1')
    expect(nodesInSlot(next, '1')).toEqual([])
    expect(nextFreeSlot(next)).toBe('1')
  })
})
