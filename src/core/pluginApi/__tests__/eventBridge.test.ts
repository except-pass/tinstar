import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventBridge } from '../eventBridge'

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  listeners = new Map<string, ((ev: { data: string }) => void)[]>()
  closed = false
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  addEventListener(name: string, fn: (ev: { data: string }) => void) {
    const arr = this.listeners.get(name) ?? []
    arr.push(fn)
    this.listeners.set(name, arr)
  }
  removeEventListener(name: string, fn: (ev: { data: string }) => void) {
    const arr = this.listeners.get(name) ?? []
    this.listeners.set(name, arr.filter(f => f !== fn))
  }
  close() { this.closed = true }
  emit(type: string, data: unknown) {
    const arr = this.listeners.get('message') ?? []
    for (const fn of arr) fn({ data: JSON.stringify({ type, ...((data ?? {}) as object) }) })
  }
}

describe('EventBridge', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    ;(globalThis as Record<string, unknown>).EventSource = MockEventSource
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).EventSource
  })

  it('opens a single EventSource for all subscribers', () => {
    const b = new EventBridge('/s/events')
    b.subscribe('managed_session.*', () => {})
    b.subscribe('nats.*', () => {})
    expect(MockEventSource.instances.length).toBe(1)
  })

  it('routes events to matching subscribers only', () => {
    const b = new EventBridge('/s/events')
    const sessionHandler = vi.fn()
    const natsHandler = vi.fn()
    b.subscribe('managed_session.*', sessionHandler)
    b.subscribe('nats.*', natsHandler)
    const es = MockEventSource.instances[0]!
    es.emit('managed_session.created', { id: 's1' })
    expect(sessionHandler).toHaveBeenCalledTimes(1)
    expect(natsHandler).not.toHaveBeenCalled()
  })

  it('exact-match channel and wildcard both fire for a matching event', () => {
    const b = new EventBridge('/s/events')
    const wildcardHandler = vi.fn()
    const exactHandler = vi.fn()
    b.subscribe('nats.*', wildcardHandler)
    b.subscribe('nats.test-subject', exactHandler)
    const es = MockEventSource.instances[0]!
    es.emit('nats.test-subject', { body: 'x' })
    expect(wildcardHandler).toHaveBeenCalledTimes(1)
    expect(exactHandler).toHaveBeenCalledTimes(1)
  })

  it('dispose() removes the subscriber and closes ES on last unsubscribe', () => {
    const b = new EventBridge('/s/events')
    const d1 = b.subscribe('selection.change', () => {})
    const d2 = b.subscribe('selection.change', () => {})
    const es = MockEventSource.instances[0]!
    expect(es.closed).toBe(false)
    d1.dispose()
    expect(es.closed).toBe(false)
    d2.dispose()
    expect(es.closed).toBe(true)
  })

  it('handler throwing does not break other handlers', () => {
    const b = new EventBridge('/s/events')
    const ok = vi.fn()
    b.subscribe('selection.change', () => { throw new Error('boom') })
    b.subscribe('selection.change', ok)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const es = MockEventSource.instances[0]!
    es.emit('selection.change', {})
    expect(ok).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
