import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { nextFreeSlot, applyAssign, applyRemove, useConstellationGraph } from '../useConstellationGraph'
import {
  emptyGraph, slotsForNode, nodesInSlot, planBreak,
  removeSnap, removeMember, addMember, type ConstellationGraph,
} from '../../domain/constellationGraph'

const h = vi.hoisted(() => ({
  serverState: { constellationGraphs: [] as ConstellationGraph[] },
  puts: [] as ConstellationGraph[],
}))

vi.mock('../useServerEvents', () => ({
  useServerEvents: () => ({ state: h.serverState }),
}))

vi.mock('../../apiClient', () => ({
  apiFetch: (_path: string, init: RequestInit) => {
    h.puts.push(JSON.parse(init.body as string))
    return Promise.resolve({ ok: true } as Response)
  },
}))

describe('useConstellationGraph reducers', () => {
  it('nextFreeSlot returns the lowest unoccupied slot', () => {
    let g = emptyGraph('s')
    g = applyAssign(g, '1', 'a')
    expect(nextFreeSlot(g)).toBe('2')
  })
  it('nextFreeSlot returns null when all nine slots are occupied', () => {
    let g = emptyGraph('s')
    for (const s of ['1','2','3','4','5','6','7','8','9'] as const) g = applyAssign(g, s, `w-${s}`)
    expect(nextFreeSlot(g)).toBeNull()
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

// Regression: back-to-back mutations against the same render snapshot must
// compose, not clobber. Each mutator builds on the prior optimistic value and
// the final PUT carries the merged graph (no lost updates).
describe('useConstellationGraph composition', () => {
  beforeEach(() => {
    h.serverState = { constellationGraphs: [] }
    h.puts.length = 0
  })

  it('double-assign (form flow) persists both members, not just the last', () => {
    const { result } = renderHook(() => useConstellationGraph('s'))
    act(() => {
      result.current.assign('1', 'a')
      result.current.assign('1', 'b')
    })
    expect(result.current.nodesInSlot('1').sort()).toEqual(['a', 'b'])
    expect(h.puts.at(-1)!.members.map(m => m.widget).sort()).toEqual(['a', 'b'])
  })

  it('dissolve loop removes every member, leaving the slot empty', () => {
    h.serverState = {
      constellationGraphs: [{ spaceId: 's', snapped: [], members: [
        { widget: 'a', slot: '1' }, { widget: 'b', slot: '1' }, { widget: 'c', slot: '1' },
      ] }],
    }
    const { result } = renderHook(() => useConstellationGraph('s'))
    const ids = result.current.nodesInSlot('1').slice()
    act(() => {
      for (const id of ids) result.current.remove('1', id)
    })
    expect(result.current.nodesInSlot('1')).toEqual([])
    expect(h.puts.at(-1)!.members).toEqual([])
  })

  it('break flow splits along a seam and composes a following mutation', () => {
    // a-b-c-d chained in slot 1; break the b-c seam → {a,b} keep, {c,d} regroup.
    h.serverState = {
      constellationGraphs: [{
        spaceId: 's',
        snapped: [['a', 'b'], ['b', 'c'], ['c', 'd']],
        members: ['a', 'b', 'c', 'd'].map(w => ({ widget: w, slot: '1' as const })),
      }],
    }
    const { result } = renderHook(() => useConstellationGraph('s'))
    act(() => {
      const g = result.current.graph
      const plan = planBreak(g, 'b', 'c', '1')
      let next = removeSnap(g, 'b', 'c')
      for (const id of plan.removeFromSlot) next = removeMember(next, id, '1')
      const free = nextFreeSlot(next)
      if (plan.newGroup.length > 0 && free) for (const id of plan.newGroup) next = addMember(next, id, free)
      result.current.applyGraph(next)
    })
    expect(result.current.nodesInSlot('1').sort()).toEqual(['a', 'b'])
    expect(result.current.nodesInSlot('2').sort()).toEqual(['c', 'd'])
    // A mutation right after the break composes off the broken graph, not the
    // stale server snapshot.
    act(() => { result.current.remove('1', 'a') })
    expect(result.current.nodesInSlot('1')).toEqual([])
    expect(h.puts.at(-1)!.members.map(m => m.widget).sort()).toEqual(['c', 'd'])
  })
})
