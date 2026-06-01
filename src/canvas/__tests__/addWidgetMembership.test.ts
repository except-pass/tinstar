import { describe, it, expect } from 'vitest'
import { addWidgetMembership } from '../addWidgetMembership'

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
  it('snaps visually but assigns no slot when slots are full', () => {
    const r = addWidgetMembership({ sourceSlot: null, freeSlot: null, sourceId: 'A', newId: 'B' })
    expect(r).toEqual({ assigns: [], snap: { a: 'A', b: 'B' } })
  })
})
