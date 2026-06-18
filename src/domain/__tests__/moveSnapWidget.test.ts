import { describe, it, expect, vi, beforeEach } from 'vitest'
import { moveSnapWidgetTo } from '../moveSnapWidget'
import { emptyGraph, addMember, addSnap, slotsForNode, snapNeighbors } from '../constellationGraph'
import type { ConstellationGraph } from '../constellationGraph'
import type { WidgetLayout } from '../../hooks/useWidgetLayouts'

const sourceLayout: WidgetLayout = { x: 0, y: 0, width: 400, height: 300 }
const movedLayout: WidgetLayout = { x: 999, y: 999, width: 200, height: 150 }

function makeOps(graph: ConstellationGraph, layouts: Record<string, WidgetLayout | undefined>) {
  let g = graph
  const insertLayout = vi.fn()
  const getLayout = vi.fn((id: string) => layouts[id])
  const updateConstellation = vi.fn((compute: (g: ConstellationGraph) => ConstellationGraph) => { g = compute(g) })
  return { ops: { getLayout, insertLayout, updateConstellation }, graph: () => g }
}

describe('moveSnapWidgetTo', () => {
  beforeEach(() => vi.clearAllMocks())

  it('flushes moved widget to source right edge, detaches old slot+snaps, joins source slot', () => {
    // src in slot '1'; moved in slot '2' snapped to 'other'
    let g = emptyGraph('sp')
    g = addMember(g, 'src', '1')
    g = addMember(g, 'moved', '2')
    g = addMember(g, 'other', '2')
    g = addSnap(g, 'moved', 'other')
    const { ops, graph } = makeOps(g, { src: sourceLayout, moved: movedLayout, other: sourceLayout })

    moveSnapWidgetTo('moved', 'src', 'right', ops)

    // moved keeps its own size, flush-right of src (src.x + src.width + SNAP_GAP)
    expect(ops.insertLayout).toHaveBeenCalledTimes(1)
    const [id, layout] = ops.insertLayout.mock.calls[0]!
    expect(id).toBe('moved')
    expect(layout.width).toBe(200)
    expect(layout.height).toBe(150)
    expect(layout.x).toBeGreaterThan(sourceLayout.width) // moved to the right of src

    const after = graph()
    expect(slotsForNode(after, 'moved')).toEqual(['1'])         // joined src's slot
    expect(snapNeighbors(after, 'moved')).toEqual(['src'])      // old 'other' seam severed, new 'src' seam added
    expect(snapNeighbors(after, 'other')).toEqual([])           // moved removed from old seam
  })

  it('no free slot + unslotted source: still moves, writes no membership/snap', () => {
    // Fill all 9 slots with placeholders; src unslotted.
    let g = emptyGraph('sp')
    for (const s of ['1','2','3','4','5','6','7','8','9'] as const) g = addMember(g, `p${s}`, s)
    const { ops, graph } = makeOps(g, { src: sourceLayout, moved: movedLayout })

    moveSnapWidgetTo('moved', 'src', 'right', ops)

    expect(ops.insertLayout).toHaveBeenCalledTimes(1)
    const after = graph()
    expect(slotsForNode(after, 'moved')).toEqual([])
    expect(snapNeighbors(after, 'moved')).toEqual([])
  })

  it('vanished moved widget (no layout): no-op', () => {
    const { ops } = makeOps(emptyGraph('sp'), { src: sourceLayout, moved: undefined })
    moveSnapWidgetTo('moved', 'src', 'right', ops)
    expect(ops.insertLayout).not.toHaveBeenCalled()
    expect(ops.updateConstellation).not.toHaveBeenCalled()
  })

  it('vanished source widget (no layout): no-op', () => {
    const { ops } = makeOps(emptyGraph('sp'), { src: undefined, moved: movedLayout })
    moveSnapWidgetTo('moved', 'src', 'right', ops)
    expect(ops.insertLayout).not.toHaveBeenCalled()
    expect(ops.updateConstellation).not.toHaveBeenCalled()
  })
})
