import { describe, it, expect } from 'vitest'
import { resolveSnapTarget, revalidateSnapTarget, snapMembership } from '../snapZoneResolver'

const W = (id: string, x: number, y: number, w = 100, h = 100) =>
  ({ id, x, y, width: w, height: h })

const SNAP_DISTANCE = 60

describe('resolveSnapTarget', () => {
  it('returns null when no other widget is within snap distance', () => {
    const result = resolveSnapTarget('d', { x: 0, y: 0, width: 100, height: 100 },
      [W('d', 0, 0), W('far', 1000, 1000)], SNAP_DISTANCE)
    expect(result).toBeNull()
  })

  it('snaps flush to the right edge, top-aligned, when approaching from the right', () => {
    // dragged centered to the right of the target → right edge, y aligned to target.y
    const result = resolveSnapTarget('d', { x: 130, y: 5, width: 100, height: 100 },
      [W('t', 0, 0)], SNAP_DISTANCE)
    expect(result).toEqual({ targetId: 't', edge: 'right', x: 100, y: 0 })
  })

  it('snaps flush to the left edge when approaching from the left', () => {
    const result = resolveSnapTarget('d', { x: -130, y: 5, width: 100, height: 100 },
      [W('t', 0, 0)], SNAP_DISTANCE)
    expect(result).toEqual({ targetId: 't', edge: 'left', x: -100, y: 0 })
  })

  it('snaps flush below, left-aligned, when approaching from below', () => {
    const result = resolveSnapTarget('d', { x: 5, y: 130, width: 100, height: 100 },
      [W('t', 0, 0)], SNAP_DISTANCE)
    expect(result).toEqual({ targetId: 't', edge: 'bottom', x: 0, y: 100 })
  })

  it('picks the nearest neighbor among several in range', () => {
    const result = resolveSnapTarget('d', { x: 120, y: 0, width: 100, height: 100 }, [
      W('near', 0, 0),       // right edge at 100, gap 20
      W('farish', -160, 0),  // right edge at -60, gap 180 (out of range anyway)
    ], SNAP_DISTANCE)
    expect(result?.targetId).toBe('near')
  })
})

describe('snapMembership', () => {
  it('joins the target slot when the target is already in a constellation', () => {
    expect(snapMembership('m', new Map([['m', '3']]), new Set(['3'])))
      .toEqual({ kind: 'join', slot: '3' })
  })

  it('forms a new constellation in the next free slot when the target is ungrouped', () => {
    expect(snapMembership('u', new Map(), new Set(['1', '2'])))
      .toEqual({ kind: 'form', slot: '3', withId: 'u' })
  })

  it('reports full-slots when all 9 slots are taken and the target is ungrouped', () => {
    expect(snapMembership('u', new Map(), new Set(['1','2','3','4','5','6','7','8','9'])))
      .toEqual({ kind: 'full-slots' })
  })
})

describe('revalidateSnapTarget', () => {
  it('keeps a preview when the same target is still the active snap target', () => {
    const preview = { targetId: 't', edge: 'right' as const, x: 100, y: 0 }

    expect(
      revalidateSnapTarget('d', preview, { x: 100, y: 0, width: 100, height: 100 }, [W('t', 0, 0)], SNAP_DISTANCE),
    ).toEqual(preview)
  })

  it('drops a preview when the snapped-against widget no longer exists', () => {
    const preview = { targetId: 't', edge: 'right' as const, x: 100, y: 0 }

    expect(
      revalidateSnapTarget('d', preview, { x: 100, y: 0, width: 100, height: 100 }, [], SNAP_DISTANCE),
    ).toBeNull()
  })

  it('drops a preview when the target is no longer within snap range', () => {
    const preview = { targetId: 't', edge: 'right' as const, x: 100, y: 0 }

    expect(
      revalidateSnapTarget('d', preview, { x: 100, y: 0, width: 100, height: 100 }, [W('t', 500, 0)], SNAP_DISTANCE),
    ).toBeNull()
  })
})
