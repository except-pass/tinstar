import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventBridge } from '../eventBridge'
import { _resetServerEventsForTests } from '../../../hooks/useServerEvents'

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  withCredentials: boolean
  readyState: number = 1
  listeners = new Map<string, ((ev: { data?: string }) => void)[]>()
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null

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
  emit(name: string, data: unknown) {
    const arr = this.listeners.get(name) ?? []
    for (const fn of arr) fn({ data: JSON.stringify(data) })
  }
}

describe('EventBridge (delegates to singleton SSE)', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    ;(globalThis as Record<string, unknown>).EventSource = MockEventSource
    _resetServerEventsForTests()
  })
  afterEach(() => {
    _resetServerEventsForTests()
    delete (globalThis as Record<string, unknown>).EventSource
  })

  it('opens exactly one EventSource shared across all subscribers', () => {
    const b = new EventBridge()
    b.subscribe('snapshot', () => {})
    b.subscribe('nats_traffic', () => {})
    expect(MockEventSource.instances.length).toBe(1)
    expect(MockEventSource.instances[0]!.withCredentials).toBe(true)
  })

  it('routes named SSE events to matching subscribers by exact channel', () => {
    const b = new EventBridge()
    const aHandler = vi.fn()
    const bHandler = vi.fn()
    b.subscribe('plugin:a', aHandler)
    b.subscribe('plugin:b', bHandler)
    const es = MockEventSource.instances[0]!
    es.emit('plugin:a', { hello: 'world' })
    expect(aHandler).toHaveBeenCalledWith({ hello: 'world' })
    expect(bHandler).not.toHaveBeenCalled()
  })

  // Use a plugin-only channel ('plugin:test') that the singleton doesn't
  // already listen to, so the only listener on the mock EventSource is the
  // one subscribeToChannel attached. Channels the singleton handles natively
  // (snapshot/nats_traffic/etc.) would mix the singleton's built-in handler
  // with the channel binding's, contaminating these structural assertions.

  it('JSON parse failure logs warn but does not break other channels', () => {
    const b = new EventBridge()
    const handler = vi.fn()
    b.subscribe('plugin:test', handler)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const es = MockEventSource.instances[0]!
    const listeners = es.listeners.get('plugin:test') ?? []
    for (const fn of listeners) fn({ data: '{ not json' })
    expect(handler).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('malformed')
    warn.mockRestore()
  })

  it('handler throwing does not break other handlers', () => {
    const b = new EventBridge()
    const ok = vi.fn()
    b.subscribe('plugin:test', () => { throw new Error('boom') })
    b.subscribe('plugin:test', ok)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const es = MockEventSource.instances[0]!
    es.emit('plugin:test', {})
    expect(ok).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('dispose removes the subscriber; closes singleton ES when refCount hits 0', () => {
    const b = new EventBridge()
    const d1 = b.subscribe('plugin:test', () => {})
    const d2 = b.subscribe('plugin:test', () => {})
    const es = MockEventSource.instances[0]!
    expect(es.closed).toBe(false)
    d1.dispose()
    expect(es.closed).toBe(false)
    d2.dispose()
    expect(es.closed).toBe(true)
  })

  it('disposing the last subscriber for a channel removes the EventSource listener', () => {
    const b = new EventBridge()
    const d1 = b.subscribe('plugin:test', () => {})
    const d2 = b.subscribe('plugin:test', () => {})
    const es = MockEventSource.instances[0]!
    expect(es.listeners.get('plugin:test')!.length).toBe(1)
    d1.dispose()
    expect(es.listeners.get('plugin:test')!.length).toBe(1)  // still 1 — same per-channel listener
    d2.dispose()
    expect(es.listeners.get('plugin:test') ?? []).toEqual([])  // listener removed after last subscriber
  })
})
