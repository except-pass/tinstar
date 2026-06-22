import { describe, it, expect } from 'vitest'
import { planAttach } from '../attachPlan'
import { emptyGraph, addMember } from '../../../domain/constellationGraph'

const target = { x: 100, y: 100, width: 200, height: 100 }
const size = { width: 80, height: 100 }

describe('planAttach', () => {
  it('positions the new widget so its anchor coincides with the target anchor', () => {
    // target.top-left meets new.top-right → new flush-left of target, top-aligned
    const { position } = planAttach(emptyGraph('s'), target, { to: 't', targetAnchor: 'top-left', newAnchor: 'top-right' }, 'w', size)
    expect(position).toEqual({ x: 100 - 80, y: 100 })
  })
  it('forms a new slot (target + new) when target is unslotted, with the anchor pair on the edge', () => {
    const { graph } = planAttach(emptyGraph('s'), target, { to: 't', targetAnchor: 'top-left', newAnchor: 'top-right' }, 'w', size)
    expect(graph.members.map(m => m.widget).sort()).toEqual(['t', 'w'])
    const edge = graph.snapped.find(e => e.nodes.includes('t') && e.nodes.includes('w'))!
    expect(edge.anchors).toBeDefined()
    // both members share one slot
    expect(new Set(graph.members.map(m => m.slot)).size).toBe(1)
  })
  it('joins the target existing slot instead of forming a new one', () => {
    const g0 = addMember(addMember(emptyGraph('s'), 't', '3'), 'other', '3')
    const { graph } = planAttach(g0, target, { to: 't', targetAnchor: 'top-right', newAnchor: 'top-left' }, 'w', size)
    expect(graph.members.find(m => m.widget === 'w')!.slot).toBe('3')
  })
  it('returns the graph unchanged when all 9 slots are occupied and target is unslotted', () => {
    let g = emptyGraph('s')
    // occupy all 9 slots with 2 members each
    for (const s of ['1','2','3','4','5','6','7','8','9']) g = addMember(addMember(g, `a${s}`, s as any), `b${s}`, s as any)
    const { graph, position } = planAttach(g, target, { to: 't', targetAnchor: 'top-left', newAnchor: 'top-right' }, 'w', size)
    expect(graph).toBe(g)            // unchanged ref
    expect(position).toEqual({ x: 20, y: 100 })  // position still computed
  })
})
