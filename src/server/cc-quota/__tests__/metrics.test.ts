import { describe, it, expect, beforeEach } from 'vitest'
import { emitCcQuotaMetrics, emitFetchCounter } from '../metrics'
import type { Metric } from '../../types'
import type { RawUsage } from '../types'

class StubExporter {
  pushed: Metric[] = []
  pushMetric(m: Metric) { this.pushed.push(m) }
}

const now = '2026-04-23T08:36:00.000Z'
const fixedNow = Date.parse(now)

function makeSample(overrides: Partial<RawUsage> = {}): RawUsage {
  return {
    five_hour:        { utilization: 67, resets_at: '2026-04-23T11:49:00.000Z' },
    seven_day:        { utilization: 89, resets_at: '2026-04-23T20:00:00.000Z' },
    seven_day_opus:   null,
    seven_day_sonnet: { utilization: 2, resets_at: '2026-04-23T21:00:00.000Z' },
    extra_usage:      { is_enabled: true, used_credits: 8148, currency: 'USD' },
    ...overrides,
  }
}

describe('emitCcQuotaMetrics', () => {
  let exp: StubExporter
  beforeEach(() => { exp = new StubExporter() })

  it('emits used_ratio and resets_at_seconds for each non-null bucket', () => {
    emitCcQuotaMetrics(exp, makeSample(), fixedNow)
    const names = exp.pushed.map(m => `${m.name}:${m.labels.window ?? ''}`)
    expect(names).toEqual(expect.arrayContaining([
      'cc_quota_used_ratio:5h',
      'cc_quota_used_ratio:7d',
      'cc_quota_used_ratio:7d_sonnet',
      'cc_quota_resets_at_seconds:5h',
      'cc_quota_resets_at_seconds:7d',
      'cc_quota_resets_at_seconds:7d_sonnet',
    ]))
    expect(names).not.toContain('cc_quota_used_ratio:7d_opus')
  })

  it('emits time_in_cycle and deficit for 5h and 7d only', () => {
    emitCcQuotaMetrics(exp, makeSample(), fixedNow)
    const fiveHourTime = exp.pushed.find(m => m.name === 'cc_quota_time_in_cycle_ratio' && m.labels.window === '5h')!
    // now = 08:36; reset = 11:49 → 3h13m away / 5h = ~0.643; time_in_cycle = 1 - 0.643 = ~0.357
    expect(fiveHourTime.value).toBeCloseTo(0.357, 2)
    const fiveHourDeficit = exp.pushed.find(m => m.name === 'cc_quota_deficit_ratio' && m.labels.window === '5h')!
    // used 67% = 0.67; deficit = 0.67 - 0.357 = ~0.313
    expect(fiveHourDeficit.value).toBeCloseTo(0.313, 2)
  })

  it('emits extra_usage gauges when present', () => {
    emitCcQuotaMetrics(exp, makeSample(), fixedNow)
    const enabled = exp.pushed.find(m => m.name === 'cc_extra_usage_enabled')!
    expect(enabled.value).toBe(1)
    const credits = exp.pushed.find(m => m.name === 'cc_extra_usage_credits_usd')!
    expect(credits.value).toBe(8148)
  })

  it('omits cc_extra_usage_credits_usd when used_credits is null', () => {
    emitCcQuotaMetrics(exp, makeSample({ extra_usage: { is_enabled: false, used_credits: null, currency: 'USD' } }), fixedNow)
    expect(exp.pushed.find(m => m.name === 'cc_extra_usage_credits_usd')).toBeUndefined()
    expect(exp.pushed.find(m => m.name === 'cc_extra_usage_enabled')!.value).toBe(0)
  })

  it('omits extra_usage gauges entirely when extra_usage is null', () => {
    emitCcQuotaMetrics(exp, makeSample({ extra_usage: null }), fixedNow)
    expect(exp.pushed.find(m => m.name.startsWith('cc_extra_usage_'))).toBeUndefined()
  })
})

describe('emitFetchCounter', () => {
  it('pushes result=ok', () => {
    const exp = new StubExporter()
    emitFetchCounter(exp, 'ok', fixedNow)
    expect(exp.pushed).toHaveLength(1)
    expect(exp.pushed[0]).toMatchObject({ name: 'cc_quota_fetch_total', type: 'counter', value: 1, labels: { result: 'ok' } })
  })
  it('pushes result=error', () => {
    const exp = new StubExporter()
    emitFetchCounter(exp, 'error', fixedNow)
    expect(exp.pushed[0].labels.result).toBe('error')
  })
})
