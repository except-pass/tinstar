import { describe, it, expect } from 'vitest'
import { emptyGraph, addMember } from '../domain/constellationGraph'
import { composeAddWidgetMembership } from './addWidgetMembership'

describe('composeAddWidgetMembership anchors', () => {
  it('persists the anchor pair on the created snap edge', () => {
    const g0 = addMember(emptyGraph('s'), 'src', '1')
    const g = composeAddWidgetMembership(g0, 'src', 'new', ['top-left', 'top-right'])
    const edge = g.snapped.find(e => e.nodes.includes('src') && e.nodes.includes('new'))!
    expect(edge.anchors).toBeDefined()
  })
})
