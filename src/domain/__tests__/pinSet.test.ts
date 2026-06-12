import { describe, it, expect } from 'vitest'
import {
  emptyPinSet, addPin, updatePin, removePin, removePinsForNode,
  pinsForNode, isPinSet, type Pin,
} from '../pinSet'

const pin = (over: Partial<Pin> = {}): Pin => ({
  id: 'pin-1', nodeId: 'browser-a', nx: 0.5, ny: 0.5,
  comment: 'hi', createdAt: 1, ...over,
})

describe('pinSet', () => {
  it('emptyPinSet seeds the spaceId and rev 0', () => {
    expect(emptyPinSet('space-1')).toEqual({ spaceId: 'space-1', pins: [], rev: 0 })
  })

  it('addPin appends', () => {
    const s = addPin(emptyPinSet('space-1'), pin())
    expect(s.pins).toHaveLength(1)
    expect(s.pins[0]!.id).toBe('pin-1')
  })

  it('updatePin replaces matching id, leaves others', () => {
    const s = addPin(addPin(emptyPinSet('s'), pin()), pin({ id: 'pin-2' }))
    const next = updatePin(s, 'pin-2', p => ({ ...p, comment: 'edited', sentAt: 9 }))
    expect(next.pins.find(p => p.id === 'pin-2')).toMatchObject({ comment: 'edited', sentAt: 9 })
    expect(next.pins.find(p => p.id === 'pin-1')!.comment).toBe('hi')
  })

  it('updatePin on a missing id is a no-op (same array contents)', () => {
    const s = addPin(emptyPinSet('s'), pin())
    const next = updatePin(s, 'nope', p => ({ ...p, comment: 'x' }))
    expect(next).toBe(s)
  })

  it('removePin drops by id', () => {
    const s = addPin(emptyPinSet('s'), pin())
    expect(removePin(s, 'pin-1').pins).toHaveLength(0)
  })

  it('removePin no-op returns the same reference', () => {
    const s = addPin(emptyPinSet('s'), pin())
    expect(removePin(s, 'missing')).toBe(s)
  })

  it('removePinsForNode drops every pin on that node', () => {
    let s = addPin(emptyPinSet('s'), pin())
    s = addPin(s, pin({ id: 'pin-2', nodeId: 'browser-a' }))
    s = addPin(s, pin({ id: 'pin-3', nodeId: 'run-x' }))
    const next = removePinsForNode(s, 'browser-a')
    expect(next.pins.map(p => p.id)).toEqual(['pin-3'])
  })

  it('pinsForNode filters by nodeId', () => {
    let s = addPin(emptyPinSet('s'), pin())
    s = addPin(s, pin({ id: 'pin-3', nodeId: 'run-x' }))
    expect(pinsForNode(s, 'browser-a').map(p => p.id)).toEqual(['pin-1'])
  })

  it('isPinSet validates shape', () => {
    expect(isPinSet({ spaceId: 's', pins: [] })).toBe(true)
    expect(isPinSet({ spaceId: 's', pins: [pin()] })).toBe(true)
    expect(isPinSet({ spaceId: 's' })).toBe(false)
    expect(isPinSet({ pins: [] })).toBe(false)
    expect(isPinSet({ spaceId: 's', pins: [{ id: 'x' }] })).toBe(false)
    expect(isPinSet(null)).toBe(false)
  })

  it('isPinSet rejects an unsafe rev', () => {
    expect(isPinSet({ spaceId: 's', pins: [], rev: 1.5 })).toBe(false)
    expect(isPinSet({ spaceId: 's', pins: [], rev: -1 })).toBe(false)
    expect(isPinSet({ spaceId: 's', pins: [], rev: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
    expect(isPinSet({ spaceId: 's', pins: [], rev: 3 })).toBe(true)
    expect(isPinSet({ spaceId: 's', pins: [] })).toBe(true) // undefined rev still ok
  })

  it('mutators do not mutate their input', () => {
    const s = addPin(emptyPinSet('s'), pin())
    const snapshot = JSON.parse(JSON.stringify(s))
    addPin(s, pin({ id: 'pin-2' }))
    updatePin(s, 'pin-1', p => ({ ...p, comment: 'x' }))
    removePin(s, 'pin-1')
    removePinsForNode(s, 'browser-a')
    expect(s).toEqual(snapshot)
  })
})
