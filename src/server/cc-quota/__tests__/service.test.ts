import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CcQuotaService } from '../service'
import type { MetricSink } from '../metrics'
import type { Metric } from '../../types'
import type { RawUsage } from '../types'
import { CcQuotaFetchError } from '../types'

const sample: RawUsage = {
  five_hour: { utilization: 40, resets_at: '2026-04-23T13:00:00.000Z' },
  seven_day: null, seven_day_opus: null, seven_day_sonnet: null,
  extra_usage: null,
}

class StubSink implements MetricSink {
  pushed: Metric[] = []
  pushMetric(m: Metric) { this.pushed.push(m) }
}

describe('CcQuotaService', () => {
  let sink: StubSink
  let fetcher: ReturnType<typeof vi.fn>
  let now: number

  beforeEach(() => {
    sink = new StubSink()
    fetcher = vi.fn<[], Promise<RawUsage>>()
    now = Date.parse('2026-04-23T10:00:00.000Z')
  })

  it('fetches, caches, and emits metrics on success', async () => {
    fetcher.mockResolvedValueOnce(sample)
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })

    const snap = await svc.getSnapshot()
    expect(snap.data).toEqual(sample)
    expect(snap.error).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(sink.pushed.find(m => m.name === 'cc_quota_used_ratio')).toBeTruthy()
    expect(sink.pushed.find(m => m.name === 'cc_quota_fetch_total' && m.labels.result === 'ok')).toBeTruthy()
  })

  it('returns cached snapshot within the 5s cooldown when not forced', async () => {
    fetcher.mockResolvedValueOnce(sample)
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })
    await svc.getSnapshot()

    now += 2000 // 2s later
    const snap = await svc.getSnapshot()
    expect(snap.data).toEqual(sample)
    expect(fetcher).toHaveBeenCalledTimes(1) // no new fetch
  })

  it('re-fetches when cooldown expires', async () => {
    fetcher.mockResolvedValueOnce(sample).mockResolvedValueOnce(sample)
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })
    await svc.getSnapshot()

    now += 6000 // past cooldown
    await svc.getSnapshot()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('force=true still respects cooldown (prevents thrash)', async () => {
    fetcher.mockResolvedValueOnce(sample)
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })
    await svc.getSnapshot()

    now += 1000
    await svc.getSnapshot({ force: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('preserves last good data on error and sets error code', async () => {
    fetcher.mockResolvedValueOnce(sample)
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })
    await svc.getSnapshot()

    now += 10000
    fetcher.mockRejectedValueOnce(new CcQuotaFetchError({ code: 'expired_token', message: 'stale' }))
    const snap = await svc.getSnapshot()
    expect(snap.data).toEqual(sample)
    expect(snap.error?.code).toBe('expired_token')
    expect(sink.pushed.filter(m => m.name === 'cc_quota_fetch_total' && m.labels.result === 'error')).toHaveLength(1)
  })

  it('returns error snapshot with null data when the very first fetch fails', async () => {
    fetcher.mockRejectedValueOnce(new CcQuotaFetchError({ code: 'no_creds', message: 'missing' }))
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })
    const snap = await svc.getSnapshot()
    expect(snap.data).toBeNull()
    expect(snap.error?.code).toBe('no_creds')
  })
})
