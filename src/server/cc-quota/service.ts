import { fetchCcQuota } from './fetcher'
import { emitCcQuotaMetrics, emitFetchCounter, type MetricSink } from './metrics'
import { makeFakeCcQuota } from './fast-sim'
import { CcQuotaFetchError, type CcQuotaSnapshot, type RawUsage } from './types'

const COOLDOWN_MS = 5_000

export interface CcQuotaServiceOptions {
  /** Injected so tests can stub network. Defaults to the real endpoint fetcher. */
  fetcher?: () => Promise<RawUsage>
  /** Injected so tests can stub OtlpExporter. */
  sink?: MetricSink
  /** Injected clock for tests. */
  now?: () => number
}

const NOOP_SINK: MetricSink = { pushMetric: () => {} }

export class CcQuotaService {
  private readonly fetcher: () => Promise<RawUsage>
  private readonly sink: MetricSink
  private readonly now: () => number

  private lastAttemptMs = -Infinity
  private cached: CcQuotaSnapshot = { fetchedAt: new Date(0).toISOString(), data: null, error: null }

  constructor(opts: CcQuotaServiceOptions = {}) {
    this.fetcher = opts.fetcher ?? (process.env.TINSTAR_FAST_SIM === '1'
      ? async () => makeFakeCcQuota(Date.now())
      : fetchCcQuota)
    this.sink = opts.sink ?? NOOP_SINK
    this.now = opts.now ?? Date.now
  }

  async getSnapshot(opts: { force?: boolean } = {}): Promise<CcQuotaSnapshot> {
    const nowMs = this.now()
    const sinceAttempt = nowMs - this.lastAttemptMs
    const mustWait = sinceAttempt < COOLDOWN_MS
    // Cooldown applies whether or not the caller set `force`. `force` exists to
    // bypass the client-side 5-minute poll cache; the 5-second server cooldown is
    // a rate-limit safety net that always wins.
    if (mustWait) return this.cached

    this.lastAttemptMs = nowMs
    try {
      const data = await this.fetcher()
      emitCcQuotaMetrics(this.sink, data, nowMs)
      emitFetchCounter(this.sink, 'ok', nowMs)
      this.cached = { fetchedAt: new Date(nowMs).toISOString(), data, error: null }
    } catch (err) {
      emitFetchCounter(this.sink, 'error', nowMs)
      const error = err instanceof CcQuotaFetchError
        ? err.info
        : { code: 'network' as const, message: (err as Error).message }
      this.cached = { fetchedAt: new Date(nowMs).toISOString(), data: this.cached.data, error }
    }
    return this.cached
  }
}
