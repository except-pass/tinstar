import { describe, it, expect } from 'vitest'
import {
  emptyPinSet, addPin, updatePin, removePin, removePinsForNode,
  pinsForNode, isPinSet, addReply, resolvePin, reopenPin, mergePreservingReplies, threadMessages,
  type Pin, type PinSet,
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

// ---------------------------------------------------------------------------
// Replies, resolve/reopen, threadMessages, mergePreservingReplies
// ---------------------------------------------------------------------------

describe('replies', () => {
  it('addReply appends a reply to the matching pin', () => {
    const set: PinSet = { spaceId: 's', pins: [pin({ createdAt: 100 })], rev: 1 }
    const next = addReply(set, 'pin-1', { id: 'r1', author: 'agent', text: 'yo', createdAt: 200 })
    expect(next.pins[0]!.replies).toEqual([{ id: 'r1', author: 'agent', text: 'yo', createdAt: 200 }])
    expect(next).not.toBe(set) // immutable
  })

  it('addReply preserves existing replies (append order)', () => {
    const set: PinSet = { spaceId: 's', pins: [pin({ replies: [{ id: 'r1', author: 'user', text: 'a', createdAt: 1 }] })], rev: 1 }
    const next = addReply(set, 'pin-1', { id: 'r2', author: 'agent', text: 'b', createdAt: 2 })
    expect(next.pins[0]!.replies!.map(r => r.id)).toEqual(['r1', 'r2'])
  })

  it('addReply is a no-op for an unknown id', () => {
    const set: PinSet = { spaceId: 's', pins: [pin()], rev: 1 }
    expect(addReply(set, 'nope', { id: 'r1', author: 'agent', text: 'x', createdAt: 2 })).toBe(set)
  })

  it('resolvePin sets resolvedAt on the matching pin', () => {
    const set: PinSet = { spaceId: 's', pins: [pin()], rev: 1 }
    const resolved = resolvePin(set, 'pin-1', 999)
    expect(resolved.pins[0]!.resolvedAt).toBe(999)
  })

  it('reopenPin removes resolvedAt from the matching pin', () => {
    const set: PinSet = { spaceId: 's', pins: [pin({ resolvedAt: 999 })], rev: 1 }
    const reopened = reopenPin(set, 'pin-1')
    expect(reopened.pins[0]!.resolvedAt).toBeUndefined()
    expect('resolvedAt' in reopened.pins[0]!).toBe(false)
  })

  it('resolvePin / reopenPin return the same ref for an unknown id', () => {
    const set: PinSet = { spaceId: 's', pins: [pin()], rev: 1 }
    expect(resolvePin(set, 'nope', 5)).toBe(set)
    expect(reopenPin(set, 'nope')).toBe(set)
  })

  it('threadMessages prepends the comment as the first user message', () => {
    const p = pin({ comment: 'root', createdAt: 100, replies: [{ id: 'r1', author: 'agent', text: 'ans', createdAt: 200 }] })
    expect(threadMessages(p)).toEqual([
      { id: 'pin-1-root', author: 'user', text: 'root', createdAt: 100 },
      { id: 'r1', author: 'agent', text: 'ans', createdAt: 200 },
    ])
  })

  it('threadMessages returns just the root message when there are no replies', () => {
    const p = pin({ comment: 'solo', createdAt: 7 })
    expect(threadMessages(p)).toEqual([{ id: `${p.id}-root`, author: 'user', text: 'solo', createdAt: 7 }])
  })
})

describe('mergePreservingReplies', () => {
  it('keeps server replies even when the client payload has stale/empty ones', () => {
    const existing: PinSet = { spaceId: 's', pins: [pin({ replies: [{ id: 'r1', author: 'agent', text: 'fresh', createdAt: 5 }] })], rev: 2 }
    const incoming: PinSet = { spaceId: 's', pins: [pin({ comment: 'edited', replies: [] })], rev: 3 }
    const merged = mergePreservingReplies(incoming, existing)
    expect(merged.pins[0]!.comment).toBe('edited')                 // geometry/comment from client
    expect(merged.pins[0]!.replies).toEqual(existing.pins[0]!.replies) // replies from server
    expect(merged.rev).toBe(3)
  })

  it('drops client-supplied replies for a pin the server has never seen', () => {
    const incoming: PinSet = { spaceId: 's', pins: [pin({ id: 'new', replies: [{ id: 'x', author: 'user', text: 'nope', createdAt: 1 }] })], rev: 1 }
    const merged = mergePreservingReplies(incoming, undefined)
    expect(merged.pins[0]!.replies).toBeUndefined()
  })

  it('does not inherit client replies for an existing pin that has none server-side', () => {
    const existing: PinSet = { spaceId: 's', pins: [pin()], rev: 2 } // pin() has no replies
    const incoming: PinSet = { spaceId: 's', pins: [pin({ replies: [{ id: 'x', author: 'user', text: 'nope', createdAt: 1 }] })], rev: 3 }
    const merged = mergePreservingReplies(incoming, existing)
    expect('replies' in merged.pins[0]!).toBe(false)
  })
})
