import { describe, it, expect, beforeEach } from 'vitest'
import { CcQuotaService } from '../service'
import type { MetricSink } from '../metrics'
import type { Metric } from '../../types'
import { ProviderCurrentObservationStores } from '../../providers/observation-stores'

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

  it('starts the shared Claude quota observation as supported but not observed', () => {
    const svc = new CcQuotaService({ sink, now: () => now })

    expect(svc.observationStores.quotas.get('claude', 'default')).toMatchObject({
      kind: 'provider-quota',
      providerId: 'claude',
      scope: { kind: 'provider', accountRef: 'default' },
      source: { id: 'statusline' },
      freshness: { state: 'unknown', observedAt: null },
      availability: { state: 'unavailable', reason: 'not-observed' },
    })
  })

  it('projects one statusline push into provider-neutral usage, context, and quota', () => {
    const svc = new CcQuotaService({ sink, now: () => now })
    const legacy = svc.ingest(samplePayload({
      model: { id: 'claude-sonnet-4-5', display_name: 'Sonnet 4.5' },
      context_window: {
        total_input_tokens: 120,
        total_output_tokens: 30,
        context_window_size: 200_000,
        used_percentage: 42,
        current_usage: {
          input_tokens: 5,
          output_tokens: 2,
          cache_read_input_tokens: 11,
          cache_creation_input_tokens: 3,
        },
      },
    }))

    expect(legacy.data?.five_hour?.utilization).toBe(40)
    expect(svc.getSessionContext('abc-123')).toEqual({
      usedPercentage: 42,
      windowSize: 200_000,
      fetchedAt: '2026-04-23T10:00:00.000Z',
    })
    expect(svc.observationStores.sessions.getUsage('claude', 'abc-123')).toMatchObject({
      providerId: 'claude',
      source: { id: 'statusline' },
      freshness: { state: 'fresh', observedAt: '2026-04-23T10:00:00.000Z' },
      availability: {
        state: 'available',
        value: {
          model: 'claude-sonnet-4-5',
          cumulativeTokens: { input: 120, output: 30 },
          latestTurnTokens: { input: 5, output: 2, cacheRead: 11, cacheWrite: 3 },
        },
      },
    })
    expect(svc.observationStores.sessions.getContext('claude', 'abc-123')).toMatchObject({
      providerId: 'claude',
      source: { id: 'statusline' },
      availability: {
        state: 'available',
        value: { usedPercent: 42, windowTokens: 200_000 },
      },
    })
    expect(svc.observationStores.quotas.get('claude', 'default')).toMatchObject({
      providerId: 'claude',
      source: { id: 'statusline' },
      availability: {
        state: 'available',
        value: {
          windows: [
            { id: 'five-hour', windowMinutes: 300, usedPercent: 40 },
            { id: 'seven-day', windowMinutes: 10_080, usedPercent: 12 },
          ],
        },
      },
    })
  })

  it('updates only the Claude account partition in an injected shared store', () => {
    const observationStores = new ProviderCurrentObservationStores({ now: () => now })
    observationStores.quotas.set({
      kind: 'provider-quota',
      providerId: 'forge',
      scope: { kind: 'provider', accountRef: 'default' },
      source: { id: 'forge-native', label: 'Forge native quota' },
      freshness: {
        state: 'fresh',
        observedAt: '2026-04-23T09:59:00.000Z',
        checkedAt: '2026-04-23T09:59:00.000Z',
      },
      availability: {
        state: 'available',
        value: {
          windows: [{
            id: 'five-hour',
            label: 'Forge primary',
            windowMinutes: 60,
            usedPercent: 99,
          }],
        },
      },
    })
    const svc = new CcQuotaService({ sink, now: () => now, observationStores })

    svc.ingest(samplePayload())

    expect(observationStores.quotas.list()).toHaveLength(2)
    expect(observationStores.quotas.get('forge', 'default'))
      .toMatchObject({ availability: { value: { windows: [{ usedPercent: 99 }] } } })
    const claude = observationStores.quotas.get('claude', 'default')
    expect(claude?.availability.state).toBe('available')
    if (claude?.availability.state === 'available') {
      expect(claude.availability.value.windows[0]?.usedPercent).toBe(40)
    }
  })

  it('marks the shared quota source unavailable after a malformed push while preserving legacy data', () => {
    const svc = new CcQuotaService({ sink, now: () => now })
    svc.ingest(samplePayload())
    const legacyGood = svc.getSnapshot().data
    now += 10_000

    const legacyError = svc.ingest({ rate_limits: 'wrong' })

    expect(legacyError.data).toEqual(legacyGood)
    expect(svc.observationStores.quotas.get('claude', 'default')).toMatchObject({
      source: { id: 'statusline' },
      freshness: {
        state: 'unknown',
        observedAt: '2026-04-23T10:00:00.000Z',
        checkedAt: '2026-04-23T10:00:10.000Z',
      },
      availability: {
        state: 'unavailable',
        reason: 'source-error',
      },
    })
  })

  it('ignores blank session identities without throwing from shared projection', () => {
    const svc = new CcQuotaService({ sink, now: () => now })

    expect(() => svc.ingest(samplePayload({
      session_id: '   ',
      context_window: {
        context_window_size: 200_000,
        used_percentage: 42,
      },
    }))).not.toThrow()
    expect(svc.getSessionContext('   ')).toBeNull()
    expect(svc.observationStores.sessions.listContext()).toEqual([])
  })

  it('preserves last valid observation times when shared validation rejects new values', () => {
    const svc = new CcQuotaService({ sink, now: () => now })
    svc.ingest(samplePayload({
      context_window: {
        context_window_size: 200_000,
        used_percentage: 42,
      },
    }))
    now += 10_000

    expect(() => svc.ingest(samplePayload({
      context_window: {
        context_window_size: 200_000,
        used_percentage: 101,
      },
      rate_limits: {
        five_hour: { used_percentage: 101, resets_at: 1776981600 },
      },
    }))).not.toThrow()

    expect(svc.observationStores.sessions.getContext('claude', 'abc-123'))
      .toMatchObject({
        freshness: {
          state: 'unknown',
          observedAt: '2026-04-23T10:00:00.000Z',
          checkedAt: '2026-04-23T10:00:10.000Z',
        },
        availability: { state: 'unavailable', reason: 'source-error' },
      })
    expect(svc.observationStores.quotas.get('claude', 'default'))
      .toMatchObject({
        freshness: {
          state: 'unknown',
          observedAt: '2026-04-23T10:00:00.000Z',
          checkedAt: '2026-04-23T10:00:10.000Z',
        },
        availability: { state: 'unavailable', reason: 'source-error' },
      })
  })
})
