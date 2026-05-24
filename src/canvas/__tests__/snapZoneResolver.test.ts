import { describe, it, expect } from 'vitest'
import { resolveSnapDrop } from '../snapZoneResolver'

const W = (id: string, x: number, y: number, w = 100, h = 100) =>
  ({ id, x, y, width: w, height: h })

const SNAP_DISTANCE = 60

describe('resolveSnapDrop', () => {
  it('returns join when dropped inside a member halo', () => {
    const result = resolveSnapDrop({
      draggedId: 'd',
      draggedRect: { x: 0, y: 0, width: 100, height: 100 },
      allWidgets: [
        W('d', 0, 0),
        W('m', 30, 30),
      ],
      slotByNode: new Map([['m', '3']]),
      occupiedSlots: new Set(['3']),
      snapDistance: SNAP_DISTANCE,
    })
    expect(result).toEqual({ kind: 'join', slot: '3' })
  })

  it('returns form-new with next free slot when two ungrouped overlap', () => {
    const result = resolveSnapDrop({
      draggedId: 'd',
      draggedRect: { x: 0, y: 0, width: 100, height: 100 },
      allWidgets: [
        W('d', 0, 0),
        W('u', 50, 50),
      ],
      slotByNode: new Map(),
      occupiedSlots: new Set(['1', '2']),
      snapDistance: SNAP_DISTANCE,
    })
    expect(result).toEqual({ kind: 'form', slot: '3', withId: 'u' })
  })

  it('returns full-slots when no free slot remains for a new constellation', () => {
    const result = resolveSnapDrop({
      draggedId: 'd',
      draggedRect: { x: 0, y: 0, width: 100, height: 100 },
      allWidgets: [
        W('d', 0, 0),
        W('u', 50, 50),
      ],
      slotByNode: new Map(),
      occupiedSlots: new Set(['1','2','3','4','5','6','7','8','9']),
      snapDistance: SNAP_DISTANCE,
    })
    expect(result).toEqual({ kind: 'full-slots' })
  })

  it('returns none when no other widget is within snap distance', () => {
    const result = resolveSnapDrop({
      draggedId: 'd',
      draggedRect: { x: 0, y: 0, width: 100, height: 100 },
      allWidgets: [
        W('d', 0, 0),
        W('far', 1000, 1000),
      ],
      slotByNode: new Map(),
      occupiedSlots: new Set(),
      snapDistance: SNAP_DISTANCE,
    })
    expect(result).toEqual({ kind: 'none' })
  })

  it('join wins over form when both are eligible', () => {
    const result = resolveSnapDrop({
      draggedId: 'd',
      draggedRect: { x: 0, y: 0, width: 100, height: 100 },
      allWidgets: [
        W('d', 0, 0),
        W('m', 30, 30),
        W('u', 60, 60),
      ],
      slotByNode: new Map([['m', '5']]),
      occupiedSlots: new Set(['5']),
      snapDistance: SNAP_DISTANCE,
    })
    expect(result).toEqual({ kind: 'join', slot: '5' })
  })
})
