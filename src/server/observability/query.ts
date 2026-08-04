import type { HudSnapshot, ModelBreakdown } from './types.js'
import type { ProviderHistoricalTelemetry } from '../../domain/provider-capabilities.js'

/** Trailing window for the duty-cycle gauge. Read as "how many of the last N minutes was the agent busy". */
const DUTY_CYCLE_WINDOW_MINUTES = 5

/**
 * Cap a windowed `increase()` value at a ceiling it cannot legitimately exceed.
 * Guards against increase()/rate() over-extrapolating when a counter churns
 * (many short-lived series + restarts/resets), which can otherwise report wildly
 * inflated totals. Returns `value` unchanged when there's no usable ceiling, so
 * a missing ceiling never blanks out a real reading.
 */
function clampToCeiling(value: number | null, ceiling: number | null): number | null {
  if (value === null || !isFinite(value)) return value
  if (ceiling === null || !isFinite(ceiling)) return value
  return Math.min(value, ceiling)
}

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

export interface UnifiedSessionTelemetryIdentity {
  providerId: string
  sessionIds: string[]
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

  /** One provider-neutral fleet snapshot; provider-specific names stop here. */
  async unifiedTodayHud(opts: HudQueryOpts): Promise<HudSnapshot> {
    const windowSec = this.secondsSinceLocalMidnight(opts.tzOffsetMinutes)
    const [claude, native] = await Promise.all([
      this.todayHud(opts),
      this.queryCanonicalProviderHud({ windowSec }),
    ])
    return combineHudSnapshots(claude, native)
  }

  /** One provider-neutral session snapshot selected by the managed session identity. */
  async unifiedSessionHud(
    identity: UnifiedSessionTelemetryIdentity,
    opts: HudQueryOpts,
  ): Promise<HudSnapshot> {
    if (identity.providerId === 'claude') {
      const conversationId = identity.sessionIds.find(id => id !== identity.sessionIds[0])
        ?? identity.sessionIds.at(-1)
      if (!conversationId) return emptyReadyHud()
      return this.todayHud({ ...opts, sessionId: conversationId })
    }
    return this.queryCanonicalProviderHud({
      providerId: identity.providerId,
      sessionIds: identity.sessionIds,
      windowSec: this.secondsSinceLocalMidnight(opts.tzOffsetMinutes),
    })
  }

  /** Provider-neutral session history used by the one shared chart set. */
  async unifiedSessionSeries(opts: {
    identity: UnifiedSessionTelemetryIdentity
    userEmail: string
    endSec: number
    windowSec: number
    stepSec: number
  }): Promise<import('./types.js').HudSeries> {
    if (opts.identity.providerId === 'claude') {
      const conversationId = opts.identity.sessionIds.find(id => id !== opts.identity.sessionIds[0])
        ?? opts.identity.sessionIds.at(-1)
      if (!conversationId) return emptyHudSeries(opts)
      return this.sessionSeries({
        sessionId: conversationId,
        userEmail: opts.userEmail,
        endSec: opts.endSec,
        windowSec: opts.windowSec,
        stepSec: opts.stepSec,
      })
    }
    const startSec = opts.endSec - opts.windowSec
    const identity = canonicalIdentityFilter(opts.identity)
    const tokens = `max(tinstar_provider_session_token_usage_total{${identity},token="total"})`
    const duty = `sum(rate(tinstar_provider_session_active_time_seconds_total{${identity}}[1m]))`
    const [tokenSeries, dutySeries] = await Promise.all([
      this.queryRange(tokens, startSec, opts.endSec, opts.stepSec),
      this.queryRange(duty, startSec, opts.endSec, opts.stepSec),
    ])
    const firstTs = tokenSeries[0]?.[0] ?? dutySeries[0]?.[0] ?? startSec
    const lastTs = tokenSeries.at(-1)?.[0] ?? dutySeries.at(-1)?.[0] ?? opts.endSec
    return {
      startedAt: new Date(firstTs * 1_000).toISOString(),
      endedAt: new Date(lastTs * 1_000).toISOString(),
      stepSec: opts.stepSec,
      series: { cost: [], tokens: tokenSeries, cache: [], duty: dutySeries },
    }
  }

  /** Provider-neutral fleet history used to restore charts after a page reload. */
  async unifiedFleetSeries(opts: {
    userEmail: string
    endSec: number
    windowSec: number
    stepSec: number
  }): Promise<import('./types.js').HudSeries> {
    const { userEmail, endSec, windowSec, stepSec } = opts
    const startSec = endSec - windowSec
    const filter = this.buildLabelFilter({ userEmail })
    const tokenMetric = 'claude_code_token_usage_tokens_total'
    const ioFilter = this.mergeFilter(filter, 'type=~"input|output"')
    const cacheReadFilter = this.mergeFilter(filter, 'type="cacheRead"')
    const inputFilter = this.mergeFilter(filter, 'type="input"')
    const cliActiveFilter = this.mergeFilter(filter, 'type="cli"')

    const cacheReadRate = `sum(rate(${tokenMetric}${cacheReadFilter}[1m]))`
    const inputRate = `sum(rate(${tokenMetric}${inputFilter}[1m]))`
    const queries = {
      cost: `sum(claude_code_cost_usage_USD_total${filter})`,
      claudeTokens: `sum(${tokenMetric}${ioFilter})`,
      nativeTokens: 'sum(tinstar_provider_session_token_usage_total{token="total"})',
      cache: `${cacheReadRate} / (${cacheReadRate} + ${inputRate})`,
      claudeDuty: `sum(rate(claude_code_active_time_seconds_total${cliActiveFilter}[1m]))`,
      nativeDuty: 'sum(rate(tinstar_provider_session_active_time_seconds_total[1m]))',
    }
    const [cost, claudeTokens, nativeTokens, cache, claudeDuty, nativeDuty] = await Promise.all([
      this.queryRange(queries.cost, startSec, endSec, stepSec),
      this.queryRange(queries.claudeTokens, startSec, endSec, stepSec),
      this.queryRange(queries.nativeTokens, startSec, endSec, stepSec),
      this.queryRange(queries.cache, startSec, endSec, stepSec),
      this.queryRange(queries.claudeDuty, startSec, endSec, stepSec),
      this.queryRange(queries.nativeDuty, startSec, endSec, stepSec),
    ])
    const tokens = addSeries(claudeTokens, nativeTokens)
    const duty = addSeries(claudeDuty, nativeDuty)
    const hasNativeTelemetry = seriesHasKnownValue(nativeTokens)
      || seriesHasKnownValue(nativeDuty)
    const unifiedCost = hasNativeTelemetry ? [] : cost
    const unifiedCache = hasNativeTelemetry ? [] : cache
    const firstTs = firstSeriesTimestamp([unifiedCost, tokens, unifiedCache, duty]) ?? startSec
    const lastTs = lastSeriesTimestamp([unifiedCost, tokens, unifiedCache, duty]) ?? endSec
    return {
      startedAt: new Date(firstTs * 1_000).toISOString(),
      endedAt: new Date(lastTs * 1_000).toISOString(),
      stepSec,
      series: { cost: unifiedCost, tokens, cache: unifiedCache, duty },
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
    const costMetric = `claude_code_cost_usage_USD_total${filter}`
    // `increase()` / `max_over_time()` over the day window can report nonsense:
    // a flapping stack and WAL replay can write a single poisoned counter sample
    // (we saw one session spike to $113M while its real value was $35), and
    // increase() also over-extrapolates across the dozens of resets that churn
    // produces. Both functions read those bad historical samples, so neither is
    // a safe number. The CURRENT cumulative total — sum() of the live counter
    // values — is spike-robust (a transient bad sample isn't the current value)
    // and is a sound upper bound: you can't have spent more in the window than
    // the counters currently total. Clamp each windowed value to it. In the
    // healthy case windowed <= current, so the clamp is a no-op.
    const tokensCeilQuery = isSession
      ? tokensQuery
      : `sum(${tokenMetric}${tokenFilter})`
    const [costWindow, costCeil, costByModelWin, costByModelCeil, tokensWindow, tokensCeil, rateMin, rateHour, cacheHit, dutyCycle] = await Promise.all([
      this.instant(`sum(increase(${costMetric}[${windowSec}s]))`),
      this.instant(`sum(${costMetric})`),
      this.instantVec(`sum by (model) (increase(${costMetric}[${windowSec}s]))`),
      this.instantVec(`sum by (model) (${costMetric})`),
      this.instant(tokensQuery),
      this.instant(tokensCeilQuery),
      this.instant(`sum(rate(${tokenMetric}${tokenFilter}[1m])) * 60`),
      this.instant(`sum(rate(${tokenMetric}${tokenFilter}[1h])) * 3600`),
      this.instant(`${cacheReadQuery} / (${cacheReadQuery} + ${inputQuery})`),
      // Duty cycle: rate of agent-active seconds over the trailing window equals
      // "agent-busy seconds per wall-clock second" = busy-fraction. Summed across
      // sessions it naturally exceeds 1 when hands run concurrently.
      this.instant(`sum(rate(claude_code_active_time_seconds_total${cliActiveFilter}[${DUTY_CYCLE_WINDOW_MINUTES}m]))`),
    ])

    const costTotal = clampToCeiling(costWindow, costCeil)
    const tokensTotal = clampToCeiling(tokensWindow, tokensCeil)

    const ceilByModel: Record<string, number> = {}
    for (const r of costByModelCeil) ceilByModel[r.metric.model ?? 'unknown'] = Number(r.value[1])
    const byModel: ModelBreakdown = {}
    for (const r of costByModelWin) {
      const model = r.metric.model ?? 'unknown'
      byModel[model] = clampToCeiling(Number(r.value[1]), ceilByModel[model] ?? null) ?? 0
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

  private async queryCanonicalProviderHud(opts: {
    providerId?: string
    sessionIds?: string[]
    windowSec: number
  }): Promise<HudSnapshot> {
    const identity = canonicalIdentityFilter({
      providerId: opts.providerId,
      sessionIds: opts.sessionIds ?? [],
    })
    const suffix = identity ? `{${identity},token="total"}` : '{token="total"}'
    const activeSuffix = identity ? `{${identity}}` : ''
    const sessionScoped = (opts.sessionIds?.length ?? 0) > 0
    const tokenQuery = sessionScoped
      ? `max(tinstar_provider_session_token_usage_total${suffix})`
      : `sum(increase(tinstar_provider_session_token_usage_total${suffix}[${opts.windowSec}s]))`
    const [tokens, perMin, perHour, duty] = await Promise.all([
      this.instant(tokenQuery),
      this.instant(`sum(rate(tinstar_provider_session_token_usage_total${suffix}[1m])) * 60`),
      this.instant(`sum(rate(tinstar_provider_session_token_usage_total${suffix}[1h])) * 3600`),
      this.instant(`sum(rate(tinstar_provider_session_active_time_seconds_total${activeSuffix}[${DUTY_CYCLE_WINDOW_MINUTES}m]))`),
    ])
    return {
      ...emptyReadyHud(),
      tokens: { total: tokens === null ? null : Math.floor(tokens) },
      rate: { perMin, perHour },
      dutyCycle: { value: finiteOrNull(duty), windowMinutes: DUTY_CYCLE_WINDOW_MINUTES },
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
    const first = vec[0]
    if (!first) return null
    return Number(first.value[1])
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

  /**
   * Provider-neutral history emitted by native provider observation adapters.
   * Missing metrics stay absent/empty; consumers must render them unavailable,
   * never coerce them to zero or borrow another provider's vocabulary.
   */
  async providerSessionSeries(opts: {
    providerId: string
    sessionId: string
    endSec: number
    windowSec: number
    stepSec: number
  }): Promise<ProviderHistoricalTelemetry> {
    const { providerId, sessionId, endSec, windowSec, stepSec } = opts
    const startSec = endSec - windowSec
    const identity = `provider="${promLabelValue(providerId)}",session="${promLabelValue(sessionId)}"`
    const tokens = 'tinstar_provider_session_tokens'
    // The same cumulative session total can be re-emitted under a new model
    // label after a model switch. max() selects the monotonic session total;
    // sum() would double-count the duplicated cumulative value across models.
    const tokenQuery = (token: 'total' | 'input' | 'output') => (
      `max(${tokens}{${identity},aggregation="cumulative",token="${token}"})`
    )
    const [total, input, output] = await Promise.all([
      this.queryRange(tokenQuery('total'), startSec, endSec, stepSec),
      this.queryRange(tokenQuery('input'), startSec, endSec, stepSec),
      this.queryRange(tokenQuery('output'), startSec, endSec, stepSec),
    ])
    const cumulativeTotal = combineProviderTokenSeries(total, input, output)

    return {
      series: [
        providerTelemetrySeries('tokens', 'tokens', cumulativeTotal),
      ],
    }
  }
}

/**
 * Prefer a provider's explicit cumulative total. When its native event only
 * carries input and/or output counters, derive the shared total pointwise.
 * Missing counters remain missing; they are never mistaken for observed zero.
 */
function combineProviderTokenSeries(
  total: [number, number | null][],
  input: [number, number | null][],
  output: [number, number | null][],
): [number, number | null][] {
  const byTimestamp = new Map<number, {
    total?: number | null
    input?: number | null
    output?: number | null
  }>()
  for (const [timestamp, value] of total) {
    byTimestamp.set(timestamp, { ...byTimestamp.get(timestamp), total: value })
  }
  for (const [timestamp, value] of input) {
    byTimestamp.set(timestamp, { ...byTimestamp.get(timestamp), input: value })
  }
  for (const [timestamp, value] of output) {
    byTimestamp.set(timestamp, { ...byTimestamp.get(timestamp), output: value })
  }
  return [...byTimestamp.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timestamp, values]) => {
      if (values.total != null) return [timestamp, values.total]
      const hasComponent = values.input != null || values.output != null
      return [
        timestamp,
        hasComponent ? (values.input ?? 0) + (values.output ?? 0) : null,
      ]
    })
}

function providerTelemetrySeries(
  metric: string,
  unit: string,
  values: [number, number | null][],
): ProviderHistoricalTelemetry['series'][number] {
  return {
    metric,
    unit,
    points: values.map(([timestamp, value]) => ({
      at: new Date(timestamp * 1_000).toISOString(),
      value,
    })),
  }
}

function canonicalIdentityFilter(identity: {
  providerId?: string
  sessionIds: string[]
}): string {
  const labels: string[] = []
  if (identity.providerId) labels.push(`provider="${promLabelValue(identity.providerId)}"`)
  const ids = [...new Set(identity.sessionIds.filter(Boolean))]
  if (ids.length === 1) {
    labels.push(`session="${promLabelValue(ids[0]!)}"`)
  } else if (ids.length > 1) {
    labels.push(`session=~"${ids.map(promRegexValue).join('|')}"`)
  }
  return labels.join(',')
}

function promRegexValue(value: string): string {
  return promLabelValue(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
}

function addSeries(
  left: [number, number | null][],
  right: [number, number | null][],
): [number, number | null][] {
  const values = new Map<number, [number | null, number | null]>()
  for (const [timestamp, value] of left) {
    values.set(timestamp, [value, values.get(timestamp)?.[1] ?? null])
  }
  for (const [timestamp, value] of right) {
    values.set(timestamp, [values.get(timestamp)?.[0] ?? null, value])
  }
  return [...values.entries()]
    .sort(([leftTimestamp], [rightTimestamp]) => leftTimestamp - rightTimestamp)
    .map(([timestamp, [leftValue, rightValue]]) => [
      timestamp,
      addKnown(leftValue, rightValue),
    ])
}

function firstSeriesTimestamp(series: [number, number | null][][]): number | null {
  let first: number | null = null
  for (const values of series) {
    const timestamp = values[0]?.[0]
    if (timestamp !== undefined && (first === null || timestamp < first)) first = timestamp
  }
  return first
}

function lastSeriesTimestamp(series: [number, number | null][][]): number | null {
  let last: number | null = null
  for (const values of series) {
    const timestamp = values.at(-1)?.[0]
    if (timestamp !== undefined && (last === null || timestamp > last)) last = timestamp
  }
  return last
}

function seriesHasKnownValue(series: [number, number | null][]): boolean {
  return series.some(([, value]) => value !== null)
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null
}

function addKnown(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return left + right
}

function combineHudSnapshots(claude: HudSnapshot, native: HudSnapshot): HudSnapshot {
  const hasNativeTelemetry = native.tokens.total !== null
    || native.rate.perMin !== null
    || native.rate.perHour !== null
    || native.dutyCycle.value !== null
  return {
    ...claude,
    // Codex subscription sessions expose usage but not billable USD. A partial
    // Claude-only sum would look like a complete fleet total, so keep it unknown.
    cost: hasNativeTelemetry ? { total: null, byModel: {} } : claude.cost,
    tokens: { total: addKnown(claude.tokens.total, native.tokens.total) },
    rate: {
      perMin: addKnown(claude.rate.perMin, native.rate.perMin),
      perHour: addKnown(claude.rate.perHour, native.rate.perHour),
    },
    dutyCycle: {
      value: addKnown(claude.dutyCycle.value, native.dutyCycle.value),
      windowMinutes: DUTY_CYCLE_WINDOW_MINUTES,
    },
    cacheHitPct: hasNativeTelemetry ? null : claude.cacheHitPct,
  }
}

function emptyReadyHud(): HudSnapshot {
  return {
    window: 'today',
    state: 'ready',
    cost: { total: null, byModel: {} },
    tokens: { total: null },
    rate: { perMin: null, perHour: null },
    cacheHitPct: null,
    dutyCycle: { value: null, windowMinutes: DUTY_CYCLE_WINDOW_MINUTES },
  }
}

function emptyHudSeries(opts: {
  endSec: number
  windowSec: number
  stepSec: number
}): import('./types.js').HudSeries {
  return {
    startedAt: new Date((opts.endSec - opts.windowSec) * 1_000).toISOString(),
    endedAt: new Date(opts.endSec * 1_000).toISOString(),
    stepSec: opts.stepSec,
    series: { cost: [], tokens: [], cache: [], duty: [] },
  }
}

function promLabelValue(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"')
}
