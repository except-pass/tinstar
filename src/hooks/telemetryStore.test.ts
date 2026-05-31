import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HudSnapshot } from '../server/observability/types'

// Mock apiClient before importing the store (the store reads apiFetch at
// module top-level via a static import, so we must vi.mock first).
const fetchMock = vi.fn<(path: string) => Promise<Response>>()
vi.mock('../apiClient', () => ({
  apiFetch: (path: string) => fetchMock(path),
}))

import {
  subscribe,
  _resetTelemetryStoreForTests,
  _tickForTests,
  _activeNamesForTests,
} from './telemetryStore'

function makeSnap(name: string, costTotal: number): HudSnapshot {
  return {
    window: 'today',
    state: 'ready',
    cost: { total: costTotal, byModel: { foo: costTotal } },
    tokens: { total: 1000 },
    rate: { perMin: 10, perHour: 600 },
    cacheHitPct: 0.5,
    dutyCycle: { value: 1, windowMinutes: 5 },
    progress: { name },
  } as unknown as HudSnapshot
}

function makeFetchResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  fetchMock.mockReset()
  _resetTelemetryStoreForTests()
})

afterEach(() => {
  _resetTelemetryStoreForTests()
})

describe('telemetryStore', () => {
  it('subscribe registers a name as active; unsubscribe removes it', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ alpha: makeSnap('alpha', 1) }))
    const listener = vi.fn()
    const unsub = subscribe('alpha', listener)
    expect(_activeNamesForTests()).toEqual(['alpha'])
    unsub()
    expect(_activeNamesForTests()).toEqual([])
  })

  it('multiple subscribers for the same name share one slot (ref counted)', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ alpha: makeSnap('alpha', 1) }))
    const a = vi.fn()
    const b = vi.fn()
    const ua = subscribe('alpha', a)
    const ub = subscribe('alpha', b)
    expect(_activeNamesForTests()).toEqual(['alpha'])
    ua()
    expect(_activeNamesForTests()).toEqual(['alpha']) // still active
    ub()
    expect(_activeNamesForTests()).toEqual([])
  })

  it('issues a single batched fetch for multiple distinct subscriptions per tick', async () => {
    fetchMock.mockResolvedValue(
      makeFetchResponse({
        alpha: makeSnap('alpha', 1),
        beta: makeSnap('beta', 2),
        gamma: makeSnap('gamma', 3),
      }),
    )
    const a = vi.fn()
    const b = vi.fn()
    const g = vi.fn()
    subscribe('alpha', a)
    subscribe('beta', b)
    subscribe('gamma', g)

    // Each subscribe() kicks a tick(). They coalesce into the same in-flight
    // promise — but `activeNames` is captured at the start of that promise's
    // first call. So the first fetch may include just 'alpha' (the others
    // hadn't been added yet to the listener map). Drain it, then fire ONE
    // more tick that will see all three in activeNames.
    await _tickForTests()
    await _tickForTests()

    // Critically: at most one fetch per tick — never N=3 parallel fetches.
    // The whole point of this store is to collapse N requests into 1.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2)
    // And the most-recent fetch URL should include all three names (one batch).
    const lastCallPath = fetchMock.mock.calls.at(-1)?.[0] ?? ''
    expect(lastCallPath).toContain('alpha')
    expect(lastCallPath).toContain('beta')
    expect(lastCallPath).toContain('gamma')
    expect(a).toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
    expect(g).toHaveBeenCalled()
  })

  it('does not duplicate an in-flight request when tick() is called again', async () => {
    let resolveFetch!: (v: Response) => void   // assigned synchronously in the executor below
    const pending = new Promise<Response>((res) => { resolveFetch = res })
    fetchMock.mockReturnValue(pending)

    subscribe('alpha', vi.fn())

    // Fire several ticks while the first is still in flight.
    const t1 = _tickForTests()
    const t2 = _tickForTests()
    const t3 = _tickForTests()

    // None should have triggered an additional fetch beyond the first.
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Resolve and let everything settle.
    resolveFetch(makeFetchResponse({ alpha: makeSnap('alpha', 1) }))
    await Promise.all([t1, t2, t3])

    // After settling, in-flight cleared; a fresh tick should fire a new fetch.
    fetchMock.mockResolvedValue(makeFetchResponse({ alpha: makeSnap('alpha', 2) }))
    await _tickForTests()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not fetch when there are no active subscribers', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({}))
    await _tickForTests()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('replays cached snapshot synchronously to a new subscriber', async () => {
    fetchMock.mockResolvedValue(makeFetchResponse({ alpha: makeSnap('alpha', 7) }))
    const first = vi.fn()
    subscribe('alpha', first)
    await _tickForTests()
    expect(first).toHaveBeenCalled()

    // New subscriber should receive the cached value immediately, before any
    // new tick fires.
    const second = vi.fn()
    subscribe('alpha', second)
    expect(second).toHaveBeenCalled()
  })
})
