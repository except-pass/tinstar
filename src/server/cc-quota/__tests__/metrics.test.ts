import { describe, it, expect, beforeEach } from 'vitest'
import { emitCcQuotaMetrics, emitIngestCounter } from '../metrics'
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
    five_hour: { utilization: 67, resets_at: '2026-04-23T11:49:00.000Z' },
    seven_day: { utilization: 89, resets_at: '2026-04-23T20:00:00.000Z' },
    ...overrides,
  }
}

describe('emitCcQuotaMetrics', () => {
  let exp: StubExporter
  beforeEach(() => { exp = new StubExporter() })

  it('emits the full set of gauges for 5h and 7d', () => {
    emitCcQuotaMetrics(exp, makeSample(), fixedNow)
    const names = exp.pushed.map(m => `${m.name}:${m.labels.window ?? ''}`)
    expect(names).toEqual(expect.arrayContaining([
      'cc_quota_used_ratio:5h',
      'cc_quota_used_ratio:7d',
      'cc_quota_resets_at_seconds:5h',
      'cc_quota_resets_at_seconds:7d',
      'cc_quota_time_in_cycle_ratio:5h',
      'cc_quota_time_in_cycle_ratio:7d',
      'cc_quota_deficit_ratio:5h',
      'cc_quota_deficit_ratio:7d',
    ]))
  })

  it('computes time_in_cycle and deficit correctly for 5h', () => {
    emitCcQuotaMetrics(exp, makeSample(), fixedNow)
    const tic = exp.pushed.find(m => m.name === 'cc_quota_time_in_cycle_ratio' && m.labels.window === '5h')!
    // now = 08:36; reset = 11:49 → 3h13m remaining / 5h = 0.643; time_in_cycle = 0.357
    expect(tic.value).toBeCloseTo(0.357, 2)
    const deficit = exp.pushed.find(m => m.name === 'cc_quota_deficit_ratio' && m.labels.window === '5h')!
    // used 0.67 - tic 0.357 = 0.313
    expect(deficit.value).toBeCloseTo(0.313, 2)
  })

  it('skips a bucket when null', () => {
    emitCcQuotaMetrics(exp, makeSample({ seven_day: null }), fixedNow)
    expect(exp.pushed.some(m => m.labels.window === '7d')).toBe(false)
    expect(exp.pushed.some(m => m.labels.window === '5h')).toBe(true)
  })

  it('emits nothing when both buckets are null', () => {
    emitCcQuotaMetrics(exp, { five_hour: null, seven_day: null }, fixedNow)
    expect(exp.pushed).toHaveLength(0)
  })
})

describe('emitIngestCounter', () => {
  it('pushes result=ok', () => {
    const exp = new StubExporter()
    emitIngestCounter(exp, 'ok', fixedNow)
    expect(exp.pushed).toHaveLength(1)
    expect(exp.pushed[0]).toMatchObject({ name: 'cc_quota_ingest_total', type: 'counter', value: 1, labels: { result: 'ok' } })
  })

  it('pushes result=error', () => {
    const exp = new StubExporter()
    emitIngestCounter(exp, 'error', fixedNow)
    expect(exp.pushed[0]!.labels.result).toBe('error')
  })
})
