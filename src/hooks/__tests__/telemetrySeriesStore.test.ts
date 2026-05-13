import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  subscribeSeries,
  pushTickForTests,
  _resetSeriesStoreForTests,
  _getSeriesForTests,
} from '../telemetrySeriesStore'

const FAKE_BACKFILL = {
  startedAt: '2026-05-13T18:00:00.000Z',
  endedAt:   '2026-05-13T18:05:00.000Z',
  stepSec: 5,
  series: {
    cost:   [[100, 0.1], [105, 0.2], [110, 0.3]] as [number, number | null][],
    tokens: [[100, 1000], [105, 1100], [110, 1200]] as [number, number | null][],
    cache:  [[100, 0.9], [105, 0.91], [110, 0.92]] as [number, number | null][],
    duty:   [[100, 0.5], [105, 0.51], [110, 0.52]] as [number, number | null][],
  },
}

describe('telemetrySeriesStore', () => {
  beforeEach(() => {
    _resetSeriesStoreForTests()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => FAKE_BACKFILL,
    })))
  })

  it('calls backfill exactly once per session', async () => {
    const sub1 = subscribeSeries('sess-a', () => {})
    const sub2 = subscribeSeries('sess-a', () => {})
    // Let the backfill promise settle
    await new Promise(r => setTimeout(r, 0))
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    sub1(); sub2()
  })

  it('delivers backfilled series to the listener', async () => {
    const cb = vi.fn()
    subscribeSeries('sess-a', cb)
    await new Promise(r => setTimeout(r, 0))
    expect(cb).toHaveBeenCalled()
    const last = cb.mock.calls.at(-1)![0]
    expect(last.cost).toEqual([0.1, 0.2, 0.3])
    expect(last.tokens).toEqual([1000, 1100, 1200])
  })

  it('appends snapshot tick values to the tail', async () => {
    const cb = vi.fn()
    subscribeSeries('sess-a', cb)
    await new Promise(r => setTimeout(r, 0))
    pushTickForTests('sess-a', {
      tsSec: 115,
      cost: 0.4, tokens: 1300, cache: 0.93, duty: 0.53,
    })
    const last = cb.mock.calls.at(-1)![0]
    expect(last.cost).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(last.tokens).toEqual([1000, 1100, 1200, 1300])
  })

  it('caps the ring buffer length at 320 (5min + headroom)', async () => {
    subscribeSeries('sess-a', () => {})
    await new Promise(r => setTimeout(r, 0))
    for (let i = 0; i < 400; i++) {
      pushTickForTests('sess-a', { tsSec: 1000 + i, cost: i, tokens: i, cache: 0.5, duty: 0.5 })
    }
    const stored = _getSeriesForTests('sess-a')!
    expect(stored.cost.length).toBeLessThanOrEqual(320)
    expect(stored.cost.at(-1)).toBe(399)
  })

  it('drops session cache on last unsubscribe', async () => {
    const unsub = subscribeSeries('sess-a', () => {})
    await new Promise(r => setTimeout(r, 0))
    expect(_getSeriesForTests('sess-a')).not.toBeNull()
    unsub()
    expect(_getSeriesForTests('sess-a')).toBeNull()
  })
})
