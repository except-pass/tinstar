import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventBridge } from '../eventBridge'

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  withCredentials: boolean
  readyState: number = 1
  listeners = new Map<string, ((ev: { data?: string }) => void)[]>()
  closed = false

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url
    this.withCredentials = !!init?.withCredentials
    MockEventSource.instances.push(this)
  }
  addEventListener(name: string, fn: (ev: { data?: string }) => void) {
    const arr = this.listeners.get(name) ?? []
    arr.push(fn)
    this.listeners.set(name, arr)
  }
  removeEventListener(name: string, fn: (ev: { data?: string }) => void) {
    const arr = this.listeners.get(name) ?? []
    this.listeners.set(name, arr.filter(f => f !== fn))
  }
  close() { this.closed = true }
  /** Simulate the server pushing a named SSE event. */
  emit(name: string, data: unknown) {
    const arr = this.listeners.get(name) ?? []
    for (const fn of arr) fn({ data: JSON.stringify(data) })
  }
  /** Simulate a transport-level error. */
  triggerError() {
    const arr = this.listeners.get('error') ?? []
    for (const fn of arr) fn({ data: undefined })
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

  it('opens a single EventSource for all subscribers (with credentials)', () => {
    const b = new EventBridge('/api/events')
    b.subscribe('snapshot', () => {})
    b.subscribe('nats_traffic', () => {})
    expect(MockEventSource.instances.length).toBe(1)
    expect(MockEventSource.instances[0]!.url).toBe('/api/events')
    expect(MockEventSource.instances[0]!.withCredentials).toBe(true)
  })

  it('routes named SSE events to matching subscribers by exact channel', () => {
    const b = new EventBridge('/api/events')
    const snapshotHandler = vi.fn()
    const natsHandler = vi.fn()
    b.subscribe('snapshot', snapshotHandler)
    b.subscribe('nats_traffic', natsHandler)
    const es = MockEventSource.instances[0]!
    es.emit('snapshot', { sessions: [] })
    expect(snapshotHandler).toHaveBeenCalledWith({ sessions: [] })
    expect(natsHandler).not.toHaveBeenCalled()
  })

  it('JSON parse failure logs warn but does not break other channels', () => {
    const b = new EventBridge('/api/events')
    const handler = vi.fn()
    b.subscribe('snapshot', handler)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Deliberately bypass JSON.stringify to inject bad data
    const es = MockEventSource.instances[0]!
    const listeners = es.listeners.get('snapshot') ?? []
    for (const fn of listeners) fn({ data: '{ not json' })
    expect(handler).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0][0]).toContain('malformed JSON')
    warn.mockRestore()
  })

  it('handler throwing does not break other handlers', () => {
    const b = new EventBridge('/api/events')
    const ok = vi.fn()
    b.subscribe('snapshot', () => { throw new Error('boom') })
    b.subscribe('snapshot', ok)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const es = MockEventSource.instances[0]!
    es.emit('snapshot', {})
    expect(ok).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('dispose removes the subscriber; closes ES on last unsubscribe', () => {
    const b = new EventBridge('/api/events')
    const d1 = b.subscribe('snapshot', () => {})
    const d2 = b.subscribe('snapshot', () => {})
    const es = MockEventSource.instances[0]!
    expect(es.closed).toBe(false)
    d1.dispose()
    expect(es.closed).toBe(false)
    d2.dispose()
    expect(es.closed).toBe(true)
  })

  it('logs an error on EventSource transport failure', () => {
    const b = new EventBridge('/api/events')
    b.subscribe('snapshot', () => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const es = MockEventSource.instances[0]!
    es.triggerError()
    expect(errSpy).toHaveBeenCalled()
    expect(errSpy.mock.calls[0][0]).toContain('EventSource error')
    errSpy.mockRestore()
  })

  it('disposing the last subscriber for a channel removes the EventSource listener', () => {
    const b = new EventBridge('/api/events')
    const d1 = b.subscribe('snapshot', () => {})
    const d2 = b.subscribe('snapshot', () => {})
    const es = MockEventSource.instances[0]!
    expect(es.listeners.get('snapshot')!.length).toBe(1)
    d1.dispose()
    expect(es.listeners.get('snapshot')!.length).toBe(1)  // still 1 — same per-channel listener
    d2.dispose()
    expect(es.listeners.get('snapshot') ?? []).toEqual([])  // listener removed after last subscriber
  })
})
