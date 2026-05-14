import type { HudSnapshot, ModelBreakdown } from './types.js'

/** Trailing window for the duty-cycle gauge. Read as "how many of the last N minutes was the agent busy". */
const DUTY_CYCLE_WINDOW_MINUTES = 5

interface PromResult {
  metric: Record<string, string>
  value: [number, string]
}
interface PromResponse {
  status: 'success' | 'error'
  data?: { resultType: string; result: PromResult[] }
  error?: string
}

export interface HudQueryOpts {
  userEmail: string
  tzOffsetMinutes?: number   // minutes west of UTC; only required for the today-window query path
  sessionId?: string
}

export class TelemetryQuery {
  private lastSnapshot: HudSnapshot | null = null
  private lastSnapshotAt = 0
  constructor(private readonly baseUrl: string) {}

  async todayHud(opts: HudQueryOpts): Promise<HudSnapshot> {
    try {
      const snap = await this.queryHud(opts)
      this.lastSnapshot = snap
      this.lastSnapshotAt = Date.now()
      return snap
    } catch (err) {
      if (this.lastSnapshot) {
        return { ...this.lastSnapshot, staleSeconds: Math.round((Date.now() - this.lastSnapshotAt) / 1000) }
      }
      throw err
    }
  }

  /**
   * Returns Claude Code conversation session_ids that have emitted tokens in
   * the last 30 seconds. Cheap: single PromQL aggregation, measured ~0.7ms
   * against a local Prometheus with ~60 token-metric series.
   */
  async burningSessions(opts: { userEmail: string }): Promise<string[]> {
    const base = opts.userEmail ? `{user_email="${opts.userEmail}"}` : ''
    const filter = this.mergeFilter(base, 'type=~"input|output"')
    const query = `sum by (session_id) (rate(claude_code_token_usage_tokens_total${filter}[30s])) > 0`
    const vec = await this.instantVec(query)
    const out: string[] = []
    for (const r of vec) {
      const sid = r.metric.session_id
      if (sid) out.push(sid)
    }
    return out
  }

  private secondsSinceLocalMidnight(tzOffsetMinutes: number | undefined): number {
    const offset = tzOffsetMinutes ?? 0
    const now = new Date()
    const local = new Date(now.getTime() - offset * 60_000)
    const midnight = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()))
    const midnightActual = new Date(midnight.getTime() + offset * 60_000)
    return Math.max(1, Math.floor((now.getTime() - midnightActual.getTime()) / 1000))
  }

  private async queryHud(opts: HudQueryOpts): Promise<HudSnapshot> {
    const windowSec = this.secondsSinceLocalMidnight(opts.tzOffsetMinutes)
    const filter = this.buildLabelFilter(opts)
    const isSession = !!opts.sessionId

    const tokenMetric = 'claude_code_token_usage_tokens_total'
    const tokenFilter = this.mergeFilter(filter, 'type=~"input|output"')
    const cacheReadFilter = this.mergeFilter(filter, 'type="cacheRead"')
    const inputFilter = this.mergeFilter(filter, 'type="input"')

    // Per-session: raw counter (stable cumulative total, no extrapolation jitter).
    // Global today: increase() over today window (sums deltas across all sessions).
    const tokensQuery = isSession
      ? `sum(${tokenMetric}${tokenFilter})`
      : `sum(increase(${tokenMetric}${tokenFilter}[${windowSec}s]))`
    const cacheReadQuery = isSession
      ? `sum(${tokenMetric}${cacheReadFilter})`
      : `sum(increase(${tokenMetric}${cacheReadFilter}[${windowSec}s]))`
    const inputQuery = isSession
      ? `sum(${tokenMetric}${inputFilter})`
      : `sum(increase(${tokenMetric}${inputFilter}[${windowSec}s]))`

    const cliActiveFilter = this.mergeFilter(filter, 'type="cli"')
    const [costTotal, costByModel, tokensTotal, rateMin, rateHour, cacheHit, dutyCycle] = await Promise.all([
      this.instant(`sum(increase(claude_code_cost_usage_USD_total${filter}[${windowSec}s]))`),
      this.instantVec(`sum by (model) (increase(claude_code_cost_usage_USD_total${filter}[${windowSec}s]))`),
      this.instant(tokensQuery),
      this.instant(`sum(rate(${tokenMetric}${tokenFilter}[1m])) * 60`),
      this.instant(`sum(rate(${tokenMetric}${tokenFilter}[1h])) * 3600`),
      this.instant(`${cacheReadQuery} / (${cacheReadQuery} + ${inputQuery})`),
      // Duty cycle: rate of agent-active seconds over the trailing window equals
      // "agent-busy seconds per wall-clock second" = busy-fraction. Summed across
      // sessions it naturally exceeds 1 when hands run concurrently.
      this.instant(`sum(rate(claude_code_active_time_seconds_total${cliActiveFilter}[${DUTY_CYCLE_WINDOW_MINUTES}m]))`),
    ])

    const byModel: ModelBreakdown = {}
    for (const r of costByModel) {
      const model = r.metric.model ?? 'unknown'
      byModel[model] = Number(r.value[1])
    }

    const cacheHitPct = (cacheHit !== null && isFinite(cacheHit)) ? cacheHit : null
    const dutyValue = (dutyCycle !== null && isFinite(dutyCycle)) ? dutyCycle : null
    return {
      window: 'today',
      state: 'ready',
      cost: { total: costTotal, byModel },
      tokens: { total: tokensTotal !== null ? Math.floor(tokensTotal) : null },
      rate: { perMin: rateMin, perHour: rateHour },
      cacheHitPct,
      dutyCycle: { value: dutyValue, windowMinutes: DUTY_CYCLE_WINDOW_MINUTES },
    }
  }

  private buildLabelFilter(opts: HudQueryOpts): string {
    const parts: string[] = []
    if (opts.userEmail) parts.push(`user_email="${opts.userEmail}"`)
    if (opts.sessionId) parts.push(`session_id="${opts.sessionId}"`)
    return parts.length ? `{${parts.join(',')}}` : ''
  }

  private mergeFilter(existing: string, extra: string): string {
    if (!existing) return `{${extra}}`
    return existing.replace(/}$/, `,${extra}}`)
  }

  private async instant(query: string): Promise<number | null> {
    const vec = await this.instantVec(query)
    if (vec.length === 0) return null
    return Number(vec[0].value[1])
  }

  private async instantVec(query: string): Promise<PromResult[]> {
    const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`prom query failed: ${res.status}`)
    const json = (await res.json()) as PromResponse
    if (json.status !== 'success' || !json.data) throw new Error(`prom query error: ${json.error ?? 'unknown'}`)
    return json.data.result
  }

  /**
   * Range query. Returns oldest→newest `[unixSec, number | null]` samples.
   * `null` is emitted for `NaN`/missing values so callers can render gaps.
   */
  async queryRange(
    query: string,
    startSec: number,
    endSec: number,
    stepSec: number,
  ): Promise<[number, number | null][]> {
    const params = new URLSearchParams({
      query,
      start: String(startSec),
      end: String(endSec),
      step: String(stepSec),
    })
    const url = `${this.baseUrl}/api/v1/query_range?${params}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`prom query_range failed: ${res.status}`)
    const json = (await res.json()) as {
      status: string
      error?: string
      data?: { resultType: string; result: { metric: Record<string, string>; values: [number, string][] }[] }
    }
    if (json.status !== 'success' || !json.data) {
      throw new Error(`prom query_range error: ${json.error ?? 'unknown'}`)
    }
    const first = json.data.result[0]
    if (!first) return []
    return first.values.map(([ts, v]) => {
      const n = Number(v)
      return [ts, isFinite(n) ? n : null] as [number, number | null]
    })
  }

  /**
   * Returns 5-minute (or `windowSec`) sparkline series for one session.
   * - cost   = cumulative dollars (monotonically non-decreasing)
   * - tokens = cumulative input+output tokens (monotonically non-decreasing)
   * - cache  = cache-read fraction over a trailing 1m sub-window (0..1)
   * - duty   = busy-fraction over a trailing 1m sub-window (0..1 per session)
   *
   * NOTE on duty: the snapshot uses a 5-minute trailing window, but for a 5-min
   * sparkline we evaluate over a trailing 1m so the sparkline shows motion. This
   * means the rightmost sample will not equal the snapshot's dutyCycle value —
   * by design. The headline number in the UI comes from the snapshot.
   */
  async sessionSeries(opts: {
    sessionId: string
    userEmail: string
    endSec: number    // unix seconds; defaults caller-side
    windowSec: number // typically 300
    stepSec: number   // typically 5
  }): Promise<import('./types.js').HudSeries> {
    const { sessionId, userEmail, endSec, windowSec, stepSec } = opts
    const startSec = endSec - windowSec

    const filter = this.buildLabelFilter({ userEmail, sessionId })
    const tokenMetric = 'claude_code_token_usage_tokens_total'
    const ioFilter        = this.mergeFilter(filter, 'type=~"input|output"')
    const cacheReadFilter = this.mergeFilter(filter, 'type="cacheRead"')
    const inputFilter     = this.mergeFilter(filter, 'type="input"')
    const cliActiveFilter = this.mergeFilter(filter, 'type="cli"')

    const costQ   = `sum(claude_code_cost_usage_USD_total${filter})`
    const tokQ    = `sum(${tokenMetric}${ioFilter})`
    const cacheReadRate = `sum(rate(${tokenMetric}${cacheReadFilter}[1m]))`
    const inputRate     = `sum(rate(${tokenMetric}${inputFilter}[1m]))`
    // 0/0 yields NaN → queryRange coerces to null → renders as a gap. Intentional:
    // during idle periods we show no cache-hit value rather than a spurious 0%.
    const cacheQ  = `${cacheReadRate} / (${cacheReadRate} + ${inputRate})`
    const dutyQ   = `sum(rate(claude_code_active_time_seconds_total${cliActiveFilter}[1m]))`

    const [cost, tokens, cache, duty] = await Promise.all([
      this.queryRange(costQ,  startSec, endSec, stepSec),
      this.queryRange(tokQ,   startSec, endSec, stepSec),
      this.queryRange(cacheQ, startSec, endSec, stepSec),
      this.queryRange(dutyQ,  startSec, endSec, stepSec),
    ])

    const firstTs = cost[0]?.[0] ?? tokens[0]?.[0] ?? cache[0]?.[0] ?? duty[0]?.[0] ?? startSec
    const lastTs  = cost.at(-1)?.[0] ?? tokens.at(-1)?.[0] ?? cache.at(-1)?.[0] ?? duty.at(-1)?.[0] ?? endSec

    return {
      startedAt: new Date(firstTs * 1000).toISOString(),
      endedAt:   new Date(lastTs * 1000).toISOString(),
      stepSec,
      series: { cost, tokens, cache, duty },
    }
  }
}
