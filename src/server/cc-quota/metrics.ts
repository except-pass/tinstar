import type { Metric } from '../types'
import type { RawUsage, UsageBucket } from './types'

export interface MetricSink {
  pushMetric(m: Metric): void
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

const CYCLE_MS: Record<'5h' | '7d', number> = {
  '5h': FIVE_HOUR_MS,
  '7d': SEVEN_DAY_MS,
}

const BUCKETS: Array<['five_hour' | 'seven_day', '5h' | '7d']> = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
]

function timeInCycleRatio(bucket: UsageBucket, nowMs: number, cycleMs: number): number {
  const resetMs = Date.parse(bucket.resets_at)
  const remainingMs = resetMs - nowMs
  const ratio = 1 - remainingMs / cycleMs
  // clamp to [0, 1] — resets slightly in the past can produce >1 briefly
  return Math.max(0, Math.min(1, ratio))
}

export function emitCcQuotaMetrics(sink: MetricSink, data: RawUsage, nowMs: number = Date.now()): void {
  const ts = new Date(nowMs).toISOString()

  for (const [field, window] of BUCKETS) {
    const bucket = data[field]
    if (!bucket) continue

    const usedRatio = bucket.utilization / 100
    sink.pushMetric({ name: 'cc_quota_used_ratio', type: 'gauge', value: usedRatio, labels: { window }, timestamp: ts })
    sink.pushMetric({ name: 'cc_quota_resets_at_seconds', type: 'gauge', value: Date.parse(bucket.resets_at) / 1000, labels: { window }, timestamp: ts })

    const tic = timeInCycleRatio(bucket, nowMs, CYCLE_MS[window])
    sink.pushMetric({ name: 'cc_quota_time_in_cycle_ratio', type: 'gauge', value: tic, labels: { window }, timestamp: ts })
    sink.pushMetric({ name: 'cc_quota_deficit_ratio', type: 'gauge', value: usedRatio - tic, labels: { window }, timestamp: ts })
  }
}

export function emitIngestCounter(sink: MetricSink, result: 'ok' | 'error', nowMs: number = Date.now()): void {
  sink.pushMetric({
    name: 'cc_quota_ingest_total',
    type: 'counter',
    value: 1,
    labels: { result },
    timestamp: new Date(nowMs).toISOString(),
  })
}
