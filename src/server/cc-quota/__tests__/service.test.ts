import { describe, it, expect, beforeEach } from 'vitest'
import { CcQuotaService } from '../service'
import type { MetricSink } from '../metrics'
import type { Metric } from '../../types'

class StubSink implements MetricSink {
  pushed: Metric[] = []
  pushMetric(m: Metric) { this.pushed.push(m) }
}

// Minimal statusline payload — matches CC 2.1.118's wire shape.
function samplePayload(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'abc-123',
    rate_limits: {
      five_hour: { used_percentage: 40, resets_at: 1776981600 }, // 2026-04-23T22:00:00Z
      seven_day: { used_percentage: 12, resets_at: 1777168800 }, // 2026-04-26T02:00:00Z
    },
    ...overrides,
  }
}

describe('CcQuotaService', () => {
  let sink: StubSink
  let now: number
  beforeEach(() => {
    sink = new StubSink()
    now = Date.parse('2026-04-23T10:00:00.000Z')
  })

  it('starts with a null snapshot', () => {
    const svc = new CcQuotaService({ sink, now: () => now })
    const snap = svc.getSnapshot()
    expect(snap.data).toBeNull()
    expect(snap.error).toBeNull()
  })

  it('ingests a well-formed payload, normalizes bucket shape, emits metrics', () => {
    const svc = new CcQuotaService({ sink, now: () => now })
    const snap = svc.ingest(samplePayload())
    expect(snap.data).toEqual({
      five_hour: { utilization: 40, resets_at: '2026-04-23T22:00:00.000Z' },
      seven_day: { utilization: 12, resets_at: '2026-04-26T02:00:00.000Z' },
    })
    expect(snap.error).toBeNull()
    expect(sink.pushed.some(m => m.name === 'cc_quota_used_ratio' && m.labels.window === '5h')).toBe(true)
    expect(sink.pushed.some(m => m.name === 'cc_quota_ingest_total' && m.labels.result === 'ok')).toBe(true)
  })

  it('leaves snapshot unchanged when payload is missing rate_limits (fresh session)', () => {
    const svc = new CcQuotaService({ sink, now: () => now })
    svc.ingest(samplePayload())
    const before = svc.getSnapshot()

    now += 10_000
    svc.ingest({ session_id: 'xyz' }) // no rate_limits
    const after = svc.getSnapshot()

    expect(after.data).toEqual(before.data)
    expect(after.fetchedAt).toBe(before.fetchedAt) // timestamp not bumped either
  })

  it('records an error snapshot and emits error counter on malformed payload', () => {
    const svc = new CcQuotaService({ sink, now: () => now })
    const snap = svc.ingest('not-an-object')
    expect(snap.data).toBeNull()
    expect(snap.error?.code).toBe('malformed_json')
    expect(sink.pushed.some(m => m.name === 'cc_quota_ingest_total' && m.labels.result === 'error')).toBe(true)
  })

  it('preserves last good data when a later payload is malformed', () => {
    const svc = new CcQuotaService({ sink, now: () => now })
    svc.ingest(samplePayload())
    const good = svc.getSnapshot().data

    now += 10_000
    const snap = svc.ingest({ rate_limits: 'wrong' })
    expect(snap.data).toEqual(good) // preserved
    expect(snap.error?.code).toBe('malformed_json')
  })

  it('treats rate_limits with neither bucket as missing_rate_limits error', () => {
    const svc = new CcQuotaService({ sink, now: () => now })
    const snap = svc.ingest({ rate_limits: { five_hour: { used_percentage: 'bad' } } })
    expect(snap.error?.code).toBe('missing_rate_limits')
  })

  it('accepts a payload with only one bucket populated', () => {
    const svc = new CcQuotaService({ sink, now: () => now })
    const snap = svc.ingest({ rate_limits: { five_hour: { used_percentage: 50, resets_at: 1776981600 } } })
    expect(snap.data?.five_hour?.utilization).toBe(50)
    expect(snap.data?.seven_day).toBeNull()
  })
})
