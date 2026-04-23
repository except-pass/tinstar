import { emitCcQuotaMetrics, emitIngestCounter, type MetricSink } from './metrics'
import type { CcQuotaSnapshot, IngestError, RawUsage, UsageBucket } from './types'

export interface CcQuotaServiceOptions {
  /** OTel sink. Defaults to a no-op so tests don't have to wire it. */
  sink?: MetricSink
  /** Injected clock for tests. */
  now?: () => number
}

const NOOP_SINK: MetricSink = { pushMetric: () => {} }

/**
 * Quota snapshot cache fed by Claude Code statusline pushes.
 *
 * The statusline payload shape (from CC 2.1.118 binary docs):
 *
 *   {
 *     "rate_limits": {
 *       "five_hour": { "used_percentage": 0..100, "resets_at": <unix_seconds> },
 *       "seven_day": { "used_percentage": 0..100, "resets_at": <unix_seconds> }
 *     }
 *   }
 *
 * `rate_limits` may be absent (fresh session before the first API response);
 * that's a soft no-op — we keep the last good snapshot.
 */
export class CcQuotaService {
  private readonly sink: MetricSink
  private readonly now: () => number

  private cached: CcQuotaSnapshot = { fetchedAt: new Date(0).toISOString(), data: null, error: null }

  constructor(opts: CcQuotaServiceOptions = {}) {
    this.sink = opts.sink ?? NOOP_SINK
    this.now = opts.now ?? Date.now
  }

  getSnapshot(): CcQuotaSnapshot {
    return this.cached
  }

  /** Accept a statusline payload. Returns the resulting snapshot. */
  ingest(payload: unknown): CcQuotaSnapshot {
    const nowMs = this.now()
    const parsed = normalizeStatuslinePayload(payload)

    if (parsed.kind === 'error') {
      emitIngestCounter(this.sink, 'error', nowMs)
      this.cached = { fetchedAt: new Date(nowMs).toISOString(), data: this.cached.data, error: parsed.error }
      return this.cached
    }

    if (parsed.kind === 'no_rate_limits') {
      // Pre-first-API-call session. Don't flip the error or touch metrics.
      return this.cached
    }

    emitCcQuotaMetrics(this.sink, parsed.data, nowMs)
    emitIngestCounter(this.sink, 'ok', nowMs)
    this.cached = { fetchedAt: new Date(nowMs).toISOString(), data: parsed.data, error: null }
    return this.cached
  }
}

type NormalizeResult =
  | { kind: 'ok'; data: RawUsage }
  | { kind: 'no_rate_limits' }
  | { kind: 'error'; error: IngestError }

function normalizeStatuslinePayload(payload: unknown): NormalizeResult {
  if (!payload || typeof payload !== 'object') {
    return { kind: 'error', error: { code: 'malformed_json', message: 'payload is not an object' } }
  }

  const rl = (payload as { rate_limits?: unknown }).rate_limits
  if (rl == null) {
    return { kind: 'no_rate_limits' }
  }
  if (typeof rl !== 'object') {
    return { kind: 'error', error: { code: 'malformed_json', message: 'rate_limits is not an object' } }
  }

  const rlObj = rl as { five_hour?: unknown; seven_day?: unknown }
  const five = coerceBucket(rlObj.five_hour)
  const seven = coerceBucket(rlObj.seven_day)

  if (!five && !seven) {
    return { kind: 'error', error: { code: 'missing_rate_limits', message: 'neither five_hour nor seven_day is well-formed' } }
  }

  return { kind: 'ok', data: { five_hour: five, seven_day: seven } }
}

function coerceBucket(raw: unknown): UsageBucket | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { used_percentage?: unknown; resets_at?: unknown }
  const used = obj.used_percentage
  const reset = obj.resets_at
  if (typeof used !== 'number' || typeof reset !== 'number') return null
  return {
    utilization: used,
    resets_at: new Date(reset * 1000).toISOString(),
  }
}
