import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventBus } from '../event-bus'
import type { BusEvent } from '../types'

const makeEvent = (type: BusEvent['type'] = 'session.created'): BusEvent =>
  ({
    type,
    timestamp: '2026-01-01T00:00:00Z',
    payload: { sessionId: 's1', initiativeId: 'i1', epicId: 'e1', taskId: 't1', worktreeId: 'w1' },
  }) as BusEvent

describe('EventBus', () => {
  let bus: EventBus

  beforeEach(() => {
    bus = new EventBus()
  })

  it('on + emit delivers typed events', () => {
    const handler = vi.fn()
    bus.on('session.created', handler)
    const event = makeEvent('session.created')
    bus.emit(event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('onAny receives every event type', () => {
    const handler = vi.fn()
    bus.onAny(handler)
    const e1 = makeEvent('session.created')
    const e2 = makeEvent('session.deleted')
    bus.emit(e1)
    bus.emit(e2)
    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledWith(e1)
    expect(handler).toHaveBeenCalledWith(e2)
  })

  it('off unregisters a typed handler', () => {
    const handler = vi.fn()
    bus.on('session.created', handler)
    bus.off('session.created', handler)
    bus.emit(makeEvent('session.created'))
    expect(handler).not.toHaveBeenCalled()
  })

  it('offAny unregisters the wildcard handler', () => {
    const handler = vi.fn()
    bus.onAny(handler)
    bus.offAny(handler)
    bus.emit(makeEvent())
    expect(handler).not.toHaveBeenCalled()
  })

  it('removeAllListeners clears every handler', () => {
    const typed = vi.fn()
    const wild = vi.fn()
    bus.on('session.created', typed)
    bus.onAny(wild)
    bus.removeAllListeners()
    bus.emit(makeEvent('session.created'))
    expect(typed).not.toHaveBeenCalled()
    expect(wild).not.toHaveBeenCalled()
  })
})
