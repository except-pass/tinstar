import { describe, it, expect } from 'vitest'
import { addWidgetMembership, composeAddWidgetMembership } from '../addWidgetMembership'
import { emptyGraph, addMember, slotsForNode } from '../../domain/constellationGraph'

describe('addWidgetMembership', () => {
  it('joins the source slot when the source already has one', () => {
    const r = addWidgetMembership({ sourceSlot: '3', freeSlot: '5', sourceId: 'A', newId: 'B' })
    expect(r).toEqual({ assigns: [{ slot: '3', nodeId: 'B' }], snap: { a: 'A', b: 'B' } })
  })
  it('forms a new constellation in the free slot when source has none', () => {
    const r = addWidgetMembership({ sourceSlot: null, freeSlot: '5', sourceId: 'A', newId: 'B' })
    expect(r).toEqual({
      assigns: [{ slot: '5', nodeId: 'A' }, { slot: '5', nodeId: 'B' }],
      snap: { a: 'A', b: 'B' },
    })
  })
  it('assigns no slot and emits no snap when slots are full (matches drag rollback-on-full)', () => {
    const r = addWidgetMembership({ sourceSlot: null, freeSlot: null, sourceId: 'A', newId: 'B' })
    expect(r).toEqual({ assigns: [] })
    expect(r.snap).toBeUndefined()
  })
})

describe('composeAddWidgetMembership', () => {
  it('joins the newcomer to the source slot when the source is already slotted', () => {
    const g = addMember(emptyGraph('s'), 'A', '3')
    const next = composeAddWidgetMembership(g, 'A', 'B')
    expect(slotsForNode(next, 'B')).toEqual(['3'])
    expect(slotsForNode(next, 'A')).toEqual(['3'])
    expect(next.snapped).toContainEqual({ nodes: ['A', 'B'] })
  })

  it('forms a new constellation in the next free slot when the source is unslotted', () => {
    const next = composeAddWidgetMembership(emptyGraph('s'), 'A', 'B')
    expect(slotsForNode(next, 'A')).toEqual(['1'])
    expect(slotsForNode(next, 'B')).toEqual(['1'])
  })

  it('plans from the passed-in graph, never adding the source to a second slot', () => {
    // Source was unslotted at render time, but got slotted (slot 3) during the
    // async widget-create. Composing from the *current* graph must join slot 3,
    // not form a new constellation that would put the source in two slots.
    const live = addMember(emptyGraph('s'), 'A', '3')
    const next = composeAddWidgetMembership(live, 'A', 'B')
    expect(slotsForNode(next, 'A')).toEqual(['3'])
    expect(slotsForNode(next, 'B')).toEqual(['3'])
  })

  it('does not snap or assign when all nine slots are occupied', () => {
    let g = emptyGraph('s')
    for (const s of ['1','2','3','4','5','6','7','8','9'] as const) g = addMember(g, `x${s}`, s)
    const next = composeAddWidgetMembership(g, 'A', 'B')
    expect(slotsForNode(next, 'A')).toEqual([])
    expect(slotsForNode(next, 'B')).toEqual([])
    expect(next.snapped).toEqual([])
  })
})

describe('composeAddWidgetMembership anchors', () => {
  it('persists the anchor pair on the created snap edge', () => {
    const g0 = addMember(emptyGraph('s'), 'src', '1')
    const g = composeAddWidgetMembership(g0, 'src', 'new', ['top-left', 'top-right'])
    const edge = g.snapped.find(e => e.nodes.includes('src') && e.nodes.includes('new'))!
    // 'new' < 'src' so canon swaps the nodes — the anchor pair must swap with them.
    expect(edge.nodes).toEqual(['new', 'src'])
    expect(edge.anchors).toEqual(['top-right', 'top-left'])
  })
})
