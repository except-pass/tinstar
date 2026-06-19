import { describe, it, expect } from 'vitest'
import { planDropSnap } from '../dropLayout'
import { emptyGraph, addMember, slotsForNode, snapNeighbors, type ConstellationSlot } from '../../domain/constellationGraph'
import type { SnapWidget } from '../snapZoneResolver'

const SNAP_DISTANCE = 60
// A run workspace sitting at the origin; the dropped file lands just off its right edge.
const RUN: SnapWidget = { id: 'run-1', x: 0, y: 0, width: 400, height: 300 }
const NEAR_DROP = { x: 430, y: 0, width: 640, height: 480 } // 30px right of run → within range
const FAR_DROP = { x: 2000, y: 2000, width: 640, height: 480 } // nowhere near anything

function slotByNodeOf(store: Record<string, string[]>): Map<string, ConstellationSlot> {
  const m = new Map<string, ConstellationSlot>()
  for (const [slot, ids] of Object.entries(store)) for (const id of ids) if (!m.has(id)) m.set(id, slot as ConstellationSlot)
  return m
}

describe('planDropSnap', () => {
  it('drops free (no membership) when nothing is within snap range', () => {
    const graph = emptyGraph('space-1')
    const plan = planDropSnap('editor-x', FAR_DROP, [RUN], SNAP_DISTANCE, graph, new Map(), new Set())
    expect(plan.snapped).toBe(false)
    expect(plan.graph).toBe(graph) // unchanged
    expect(plan.layout).toEqual(FAR_DROP) // lands exactly where dropped
  })

  it('forms a new constellation with the run when dropped near an ungrouped run', () => {
    const graph = emptyGraph('space-1')
    const plan = planDropSnap('editor-x', NEAR_DROP, [RUN], SNAP_DISTANCE, graph, new Map(), new Set())
    expect(plan.snapped).toBe(true)
    // both the run and the new editor share one slot
    const editorSlots = slotsForNode(plan.graph, 'editor-x')
    expect(editorSlots).toHaveLength(1)
    expect(slotsForNode(plan.graph, 'run-1')).toEqual(editorSlots)
    // and a snap edge ties them together (carrying anchors, not a bare legacy tuple)
    expect(snapNeighbors(plan.graph, 'editor-x')).toContain('run-1')
    // placed flush, not at the raw drop point, size preserved
    expect(plan.layout.width).toBe(640)
    expect(plan.layout.height).toBe(480)
    expect(plan.layout.x).not.toBe(NEAR_DROP.x)
  })

  it('stays free at the drop point when a target is in range but every slot is full', () => {
    // The subtle rollback branch: resolveSnapTarget finds RUN within range, but all 9
    // slots are occupied so the newcomer can't join — it must NOT snap geometry to a
    // widget it won't be grouped with. Lands at the raw drop point, no membership.
    let graph = emptyGraph('space-1')
    const allSlots = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as ConstellationSlot[]
    for (const s of allSlots) graph = addMember(graph, `filler-${s}`, s)
    const plan = planDropSnap('editor-x', NEAR_DROP, [RUN], SNAP_DISTANCE, graph, new Map(), new Set(allSlots))
    expect(plan.snapped).toBe(false)
    expect(plan.graph).toBe(graph) // unchanged
    expect(plan.layout).toEqual(NEAR_DROP) // raw drop point, not flush
  })

  it("joins the run's existing slot when the run is already grouped", () => {
    const graph = addMember(emptyGraph('space-1'), 'run-1', '3')
    const store = { '3': ['run-1'] }
    const plan = planDropSnap('editor-x', NEAR_DROP, [RUN], SNAP_DISTANCE, graph, slotByNodeOf(store), new Set(['3'] as ConstellationSlot[]))
    expect(plan.snapped).toBe(true)
    expect(slotsForNode(plan.graph, 'editor-x')).toEqual(['3'])
    expect(snapNeighbors(plan.graph, 'editor-x')).toContain('run-1')
  })
})
