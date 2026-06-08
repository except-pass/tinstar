import { describe, it, expect, vi, beforeEach } from 'vitest'
import { relocateWidgetTo } from '../relocateWidget'
import type { WidgetLayout } from '../../hooks/useWidgetLayouts'
import type { ConstellationSlot } from '../constellationGraph'

const baseLayout: WidgetLayout = { x: 10, y: 20, width: 300, height: 200 }

function makeOps(overrides: Partial<{
  layout: WidgetLayout | undefined
  slots: ConstellationSlot[]
}> = {}) {
  const insertLayout = vi.fn()
  const removeFromSlot = vi.fn()
  const getLayout = vi.fn(() => overrides.layout)
  const slotsForNode = vi.fn(() => overrides.slots ?? [])
  return { getLayout, insertLayout, slotsForNode, removeFromSlot }
}

describe('relocateWidgetTo', () => {
  let ops: ReturnType<typeof makeOps>

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('happy path: moves to point preserving size and leaves its single slot', () => {
    ops = makeOps({ layout: baseLayout, slots: ['3'] as ConstellationSlot[] })
    relocateWidgetTo('w1', { x: 500, y: 600 }, ops)

    expect(ops.insertLayout).toHaveBeenCalledTimes(1)
    expect(ops.insertLayout).toHaveBeenCalledWith('w1', { x: 500, y: 600, width: 300, height: 200 })
    expect(ops.removeFromSlot).toHaveBeenCalledTimes(1)
    expect(ops.removeFromSlot).toHaveBeenCalledWith('3', 'w1')
  })

  it('widget in no slot: moves but does not remove from any slot', () => {
    ops = makeOps({ layout: baseLayout, slots: [] })
    relocateWidgetTo('w1', { x: 5, y: 7 }, ops)

    expect(ops.insertLayout).toHaveBeenCalledTimes(1)
    expect(ops.insertLayout).toHaveBeenCalledWith('w1', { x: 5, y: 7, width: 300, height: 200 })
    expect(ops.removeFromSlot).not.toHaveBeenCalled()
  })

  it('widget in multiple slots: removes from each', () => {
    ops = makeOps({ layout: baseLayout, slots: ['1', '4'] as ConstellationSlot[] })
    relocateWidgetTo('w1', { x: 0, y: 0 }, ops)

    expect(ops.removeFromSlot).toHaveBeenCalledTimes(2)
    expect(ops.removeFromSlot).toHaveBeenCalledWith('1', 'w1')
    expect(ops.removeFromSlot).toHaveBeenCalledWith('4', 'w1')
  })

  it('vanished widget (no layout): no-op move and no slot removal', () => {
    ops = makeOps({ layout: undefined, slots: ['3'] as ConstellationSlot[] })
    relocateWidgetTo('w1', { x: 1, y: 2 }, ops)

    expect(ops.insertLayout).not.toHaveBeenCalled()
    expect(ops.removeFromSlot).not.toHaveBeenCalled()
  })
})
