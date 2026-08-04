import { ZodError } from 'zod'
import type {
  ProviderSessionContext,
  ProviderSessionUsage,
  ProviderTokenUsage,
} from '../../domain/provider-capabilities'
import { ProviderCurrentObservationStores } from '../providers/observation-stores'
import {
  CLAUDE_ACCOUNT_REF,
  CLAUDE_PROVIDER_ID,
  CLAUDE_STATUSLINE_SOURCE,
} from '../providers/claude-observation-sources'
import { emitCcQuotaMetrics, emitIngestCounter, type MetricSink } from './metrics'
import type { CcQuotaSnapshot, IngestError, RawUsage, SessionContextSnapshot, UsageBucket } from './types'

export interface CcQuotaServiceOptions {
  /** OTel sink. Defaults to a no-op so tests don't have to wire it. */
  sink?: MetricSink
  /** Injected clock for tests. */
  now?: () => number
  /** Shared provider-neutral state; defaults to service-owned stores. */
  observationStores?: ProviderCurrentObservationStores
  /** Quiet statusline snapshots become stale after this interval. */
  observationStaleAfterMs?: number
}

const NOOP_SINK: MetricSink = { pushMetric: () => {} }
const DEFAULT_OBSERVATION_STALE_AFTER_MS = 5 * 60 * 1_000

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
  private readonly observationStaleAfterMs: number
  private lastObservationAtMs = 0

  readonly observationStores: ProviderCurrentObservationStores

  private cached: CcQuotaSnapshot = { fetchedAt: new Date(0).toISOString(), data: null, error: null }
  private sessionContexts = new Map<string, SessionContextSnapshot>()

  constructor(opts: CcQuotaServiceOptions = {}) {
    this.sink = opts.sink ?? NOOP_SINK
    this.now = opts.now ?? Date.now
    this.observationStaleAfterMs = opts.observationStaleAfterMs
      ?? DEFAULT_OBSERVATION_STALE_AFTER_MS
    this.observationStores = opts.observationStores
      ?? new ProviderCurrentObservationStores({ now: this.now })
    if (!this.observationStores.quotas.get(CLAUDE_PROVIDER_ID, CLAUDE_ACCOUNT_REF)) {
      this.setQuotaUnavailable(
        'not-observed',
        null,
        new Date(this.nextObservationTime()).toISOString(),
      )
    }
  }

  getSnapshot(): CcQuotaSnapshot {
    return this.cached
  }

  getSessionContext(sessionId: string): SessionContextSnapshot | null {
    return this.sessionContexts.get(sessionId) ?? null
  }

  /** Accept a statusline payload. Returns the resulting snapshot. */
  ingest(payload: unknown): CcQuotaSnapshot {
    const nowMs = this.nextObservationTime()
    const checkedAt = new Date(nowMs).toISOString()
    const ctx = extractSessionContext(payload)
    if (ctx) {
      this.sessionContexts.set(ctx.sessionId, { ...ctx.snap, fetchedAt: checkedAt })
      this.setSessionContextObservation(ctx.sessionId, ctx.snap, checkedAt)
    }
    const usage = extractSessionUsage(payload)
    if (usage) this.setSessionUsageObservation(usage.sessionId, usage.value, checkedAt)
    const parsed = normalizeStatuslinePayload(payload)

    if (parsed.kind === 'error') {
      emitIngestCounter(this.sink, 'error', nowMs)
      this.cached = { fetchedAt: checkedAt, data: this.cached.data, error: parsed.error }
      const previous = this.observationStores.quotas.get(
        CLAUDE_PROVIDER_ID,
        CLAUDE_ACCOUNT_REF,
      )
      this.setQuotaUnavailable(
        'source-error',
        previous?.freshness.observedAt ?? null,
        checkedAt,
        parsed.error.message,
      )
      return this.cached
    }

    if (parsed.kind === 'no_rate_limits') {
      // Pre-first-API-call session. Don't flip the error or touch metrics.
      return this.cached
    }

    emitCcQuotaMetrics(this.sink, parsed.data, nowMs)
    emitIngestCounter(this.sink, 'ok', nowMs)
    this.cached = { fetchedAt: checkedAt, data: parsed.data, error: null }
    this.setQuotaObservation(parsed.data, checkedAt)
    return this.cached
  }

  private setSessionUsageObservation(
    sessionId: string,
    value: ProviderSessionUsage,
    observedAt: string,
  ): void {
    try {
      this.observationStores.sessions.setUsage({
        kind: 'session-usage',
        providerId: CLAUDE_PROVIDER_ID,
        scope: { kind: 'session', sessionId },
        source: CLAUDE_STATUSLINE_SOURCE,
        freshness: {
          state: 'fresh',
          observedAt,
          checkedAt: observedAt,
          staleAfterMs: this.observationStaleAfterMs,
        },
        availability: { state: 'available', value },
      })
    } catch (error) {
      if (!(error instanceof ZodError)) throw error
      // Keep malformed native fields away from the shared contract without
      // changing the historical statusline ingest response.
    }
  }

  private setSessionContextObservation(
    sessionId: string,
    legacy: Omit<SessionContextSnapshot, 'fetchedAt'>,
    observedAt: string,
  ): void {
    const value: ProviderSessionContext = {
      usedPercent: legacy.usedPercentage,
      windowTokens: legacy.windowSize,
    }
    try {
      this.observationStores.sessions.setContext({
        kind: 'session-context',
        providerId: CLAUDE_PROVIDER_ID,
        scope: { kind: 'session', sessionId },
        source: CLAUDE_STATUSLINE_SOURCE,
        freshness: {
          state: 'fresh',
          observedAt,
          checkedAt: observedAt,
          staleAfterMs: this.observationStaleAfterMs,
        },
        availability: { state: 'available', value },
      })
    } catch (error) {
      if (!(error instanceof ZodError)) throw error
      // Legacy statusline consumers historically accept any numeric values.
      // A malformed native reading must not make that compatibility API throw.
      const previous = this.observationStores.sessions.getContext(
        CLAUDE_PROVIDER_ID,
        sessionId,
      )
      this.observationStores.sessions.setContext({
        kind: 'session-context',
        providerId: CLAUDE_PROVIDER_ID,
        scope: { kind: 'session', sessionId },
        source: CLAUDE_STATUSLINE_SOURCE,
        freshness: {
          state: 'unknown',
          observedAt: previous?.freshness.observedAt ?? null,
          checkedAt: observedAt,
        },
        availability: {
          state: 'unavailable',
          reason: 'source-error',
          message: 'Claude context values failed shared-wire validation',
        },
      })
    }
  }

  private setQuotaObservation(data: RawUsage, observedAt: string): void {
    const windows = [
      data.five_hour
        ? {
            id: 'five-hour',
            label: 'Five-hour window',
            windowMinutes: 300,
            usedPercent: data.five_hour.utilization,
            resetsAt: data.five_hour.resets_at,
          }
        : null,
      data.seven_day
        ? {
            id: 'seven-day',
            label: 'Seven-day window',
            windowMinutes: 7 * 24 * 60,
            usedPercent: data.seven_day.utilization,
            resetsAt: data.seven_day.resets_at,
          }
        : null,
    ].filter(window => window !== null)

    try {
      this.observationStores.quotas.set({
        kind: 'provider-quota',
        providerId: CLAUDE_PROVIDER_ID,
        scope: { kind: 'provider', accountRef: CLAUDE_ACCOUNT_REF },
        source: CLAUDE_STATUSLINE_SOURCE,
        freshness: {
          state: 'fresh',
          observedAt,
          checkedAt: observedAt,
          staleAfterMs: this.observationStaleAfterMs,
        },
        availability: { state: 'available', value: { windows } },
      })
    } catch (error) {
      if (!(error instanceof ZodError)) throw error
      const previous = this.observationStores.quotas.get(
        CLAUDE_PROVIDER_ID,
        CLAUDE_ACCOUNT_REF,
      )
      this.setQuotaUnavailable(
        'source-error',
        previous?.freshness.observedAt ?? null,
        observedAt,
        'Claude quota values failed shared-wire validation',
      )
    }
  }

  private setQuotaUnavailable(
    reason: 'not-observed' | 'source-error',
    observedAt: string | null,
    checkedAt: string,
    message?: string,
  ): void {
    this.observationStores.quotas.set({
      kind: 'provider-quota',
      providerId: CLAUDE_PROVIDER_ID,
      scope: { kind: 'provider', accountRef: CLAUDE_ACCOUNT_REF },
      source: CLAUDE_STATUSLINE_SOURCE,
      freshness: { state: 'unknown', observedAt, checkedAt },
      availability: { state: 'unavailable', reason, ...(message ? { message } : {}) },
    })
  }

  private nextObservationTime(): number {
    const next = Math.max(this.now(), this.lastObservationAtMs)
    this.lastObservationAtMs = next
    return next
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

function extractSessionContext(payload: unknown): { sessionId: string; snap: Omit<SessionContextSnapshot, 'fetchedAt'> } | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { session_id?: unknown; context_window?: unknown }
  if (typeof p.session_id !== 'string' || p.session_id.trim().length === 0) return null
  if (!p.context_window || typeof p.context_window !== 'object') return null
  const cw = p.context_window as { used_percentage?: unknown; context_window_size?: unknown }
  if (typeof cw.used_percentage !== 'number' || typeof cw.context_window_size !== 'number') return null
  return {
    sessionId: p.session_id,
    snap: { usedPercentage: cw.used_percentage, windowSize: cw.context_window_size },
  }
}

function extractSessionUsage(
  payload: unknown,
): { sessionId: string; value: ProviderSessionUsage } | null {
  if (!payload || typeof payload !== 'object') return null
  const candidate = payload as {
    session_id?: unknown
    model?: unknown
    context_window?: unknown
  }
  if (
    typeof candidate.session_id !== 'string'
    || candidate.session_id.trim().length === 0
  ) return null
  if (!candidate.context_window || typeof candidate.context_window !== 'object') return null
  const context = candidate.context_window as {
    total_input_tokens?: unknown
    total_output_tokens?: unknown
    current_usage?: unknown
  }
  const cumulativeTokens = tokenUsage({
    input: context.total_input_tokens,
    output: context.total_output_tokens,
  })
  const current = context.current_usage && typeof context.current_usage === 'object'
    ? context.current_usage as {
        input_tokens?: unknown
        output_tokens?: unknown
        cache_read_input_tokens?: unknown
        cache_creation_input_tokens?: unknown
      }
    : null
  const latestTurnTokens = current
    ? tokenUsage({
        input: current.input_tokens,
        output: current.output_tokens,
        cacheRead: current.cache_read_input_tokens,
        cacheWrite: current.cache_creation_input_tokens,
      })
    : undefined
  if (!cumulativeTokens && !latestTurnTokens) return null

  const model = providerModelId(candidate.model)
  const modelField = model ? { model } : {}
  let value: ProviderSessionUsage
  if (cumulativeTokens) {
    value = {
      ...modelField,
      cumulativeTokens,
      ...(latestTurnTokens ? { latestTurnTokens } : {}),
    }
  } else if (latestTurnTokens) {
    value = { ...modelField, latestTurnTokens }
  } else {
    return null
  }
  return { sessionId: candidate.session_id, value }
}

function providerModelId(model: unknown): string | undefined {
  if (typeof model === 'string' && model.trim()) return model
  if (!model || typeof model !== 'object') return undefined
  const id = (model as { id?: unknown }).id
  return typeof id === 'string' && id.trim() ? id : undefined
}

function tokenUsage(
  counters: Partial<Record<keyof ProviderTokenUsage, unknown>>,
): ProviderTokenUsage | undefined {
  const usage: Partial<Record<keyof ProviderTokenUsage, number>> = {}
  for (const [name, raw] of Object.entries(counters) as Array<[
    keyof ProviderTokenUsage,
    unknown,
  ]>) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) usage[name] = raw
  }
  return Object.keys(usage).length > 0 ? usage as ProviderTokenUsage : undefined
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
