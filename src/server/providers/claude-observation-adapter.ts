import type {
  ProviderContextBreakdown,
  ProviderHistoricalTelemetry,
  ProviderObservationKind,
  ProviderObservationRequestFor,
  ProviderObservationSnapshotFor,
  ProviderSource,
} from '../../domain/provider-capabilities'
import type { MetricSink } from '../cc-quota/metrics'
import { CcQuotaService } from '../cc-quota/service'
import type { ContextData } from '../sessions/context-usage'
import type { TelemetryQuery } from '../observability/query'
import type { HudSeries, HudSnapshot } from '../observability/types'
import { defineProviderAdapter, type ProviderAdapter } from './contract'
import { ProviderCurrentObservationStores } from './observation-stores'
import {
  CLAUDE_ACCOUNT_REF,
  CLAUDE_CONTEXT_SOURCE,
  CLAUDE_PROMETHEUS_SOURCE,
  CLAUDE_PROVIDER_ID,
  CLAUDE_STATUSLINE_SOURCE,
} from './claude-observation-sources'

export interface ClaudeObservationDetail {
  legacyContext?: ContextData
}

export type ClaudeTelemetryQuery = Pick<
  TelemetryQuery,
  'todayHud' | 'burningSessions' | 'sessionSeries'
>

export interface ClaudeObservationAdapterOptions {
  stores: ProviderCurrentObservationStores
  sink?: MetricSink
  now?: () => number
  observationStaleAfterMs?: number
  getTelemetryQuery: () => ClaudeTelemetryQuery | null
  getDefaultUserEmail: () => string
  getDetailedContext: (sessionId: string) => Promise<ContextData>
}

/**
 * Provider-owned boundary for Claude's three existing observation transports.
 *
 * Statusline pushes are the sole writer of current usage/context/quota. OTLP
 * data is queried through Prometheus for history only, so replaying Prometheus
 * samples can never duplicate current-state ingress or historical emission.
 */
export class ClaudeObservationAdapter {
  readonly adapter: ProviderAdapter<ClaudeObservationDetail>
  readonly statusline: CcQuotaService

  private readonly stores: ProviderCurrentObservationStores
  private readonly now: () => number
  private readonly getTelemetryQuery: () => ClaudeTelemetryQuery | null
  private readonly getDefaultUserEmail: () => string
  private readonly getDetailedContext: (sessionId: string) => Promise<ContextData>

  constructor(options: ClaudeObservationAdapterOptions) {
    this.stores = options.stores
    this.now = options.now ?? Date.now
    this.getTelemetryQuery = options.getTelemetryQuery
    this.getDefaultUserEmail = options.getDefaultUserEmail
    this.getDetailedContext = options.getDetailedContext
    this.statusline = new CcQuotaService({
      sink: options.sink,
      now: this.now,
      observationStores: options.stores,
      observationStaleAfterMs: options.observationStaleAfterMs,
    })

    this.adapter = defineProviderAdapter({
      provider: { id: CLAUDE_PROVIDER_ID, label: 'Claude Code' },
      sessionLifecycle: 'terminal',
      capabilities: {
        observations: {
          'session-usage': { state: 'supported', detail: { sources: [CLAUDE_STATUSLINE_SOURCE] } },
          'session-context': { state: 'supported', detail: { sources: [CLAUDE_STATUSLINE_SOURCE] } },
          'provider-quota': { state: 'supported', detail: { sources: [CLAUDE_STATUSLINE_SOURCE] } },
          'historical-telemetry': { state: 'supported', detail: { sources: [CLAUDE_PROMETHEUS_SOURCE] } },
          'context-breakdown': { state: 'supported', detail: { sources: [CLAUDE_CONTEXT_SOURCE] } },
        },
        delivery: {
          acceptance: { state: 'unsupported', reason: 'Claude delivery lands in a later slice' },
          confirmation: { state: 'unsupported', reason: 'Claude delivery lands in a later slice' },
        },
      },
      observe: {
        'session-usage': request => Promise.resolve(this.observeSessionUsage(request)),
        'session-context': request => Promise.resolve(this.observeSessionContext(request)),
        'provider-quota': request => Promise.resolve(this.observeProviderQuota(request)),
        'historical-telemetry': request => this.observeHistoricalTelemetry(request),
        'context-breakdown': request => this.observeContextBreakdown(request),
      },
      delivery: null,
    })
  }

  async todayHud(options: Parameters<TelemetryQuery['todayHud']>[0]): Promise<HudSnapshot> {
    return this.requireTelemetryQuery().todayHud(options)
  }

  async burningSessions(
    options: Parameters<TelemetryQuery['burningSessions']>[0],
  ): Promise<string[]> {
    return this.requireTelemetryQuery().burningSessions(options)
  }

  async sessionSeries(
    options: Parameters<TelemetryQuery['sessionSeries']>[0],
  ): Promise<HudSeries> {
    return this.requireTelemetryQuery().sessionSeries(options)
  }

  private observeSessionUsage(
    request: ProviderObservationRequestFor<'session-usage'>,
  ): ProviderObservationSnapshotFor<'session-usage', ClaudeObservationDetail> {
    return this.stores.sessions.getUsage(CLAUDE_PROVIDER_ID, request.scope.sessionId)
      ?? this.notObserved('session-usage', request.scope, CLAUDE_STATUSLINE_SOURCE)
  }

  private observeSessionContext(
    request: ProviderObservationRequestFor<'session-context'>,
  ): ProviderObservationSnapshotFor<'session-context', ClaudeObservationDetail> {
    return this.stores.sessions.getContext(CLAUDE_PROVIDER_ID, request.scope.sessionId)
      ?? this.notObserved('session-context', request.scope, CLAUDE_STATUSLINE_SOURCE)
  }

  private observeProviderQuota(
    request: ProviderObservationRequestFor<'provider-quota'>,
  ): ProviderObservationSnapshotFor<'provider-quota', ClaudeObservationDetail> {
    if (request.scope.accountRef !== CLAUDE_ACCOUNT_REF) {
      return this.unavailable(
        'provider-quota',
        request.scope,
        CLAUDE_STATUSLINE_SOURCE,
        'not-applicable',
        `Claude account ${request.scope.accountRef} is not configured`,
      )
    }
    return this.stores.quotas.get(CLAUDE_PROVIDER_ID, request.scope.accountRef)
      ?? this.notObserved('provider-quota', request.scope, CLAUDE_STATUSLINE_SOURCE)
  }

  private async observeHistoricalTelemetry(
    request: ProviderObservationRequestFor<'historical-telemetry'>,
  ): Promise<ProviderObservationSnapshotFor<'historical-telemetry', ClaudeObservationDetail>> {
    if (
      request.scope.kind === 'provider'
      && request.scope.accountRef !== CLAUDE_ACCOUNT_REF
    ) {
      return this.unavailable(
        'historical-telemetry',
        request.scope,
        CLAUDE_PROMETHEUS_SOURCE,
        'not-applicable',
        `Claude account ${request.scope.accountRef} is not configured`,
      )
    }
    const query = this.getTelemetryQuery()
    if (!query) {
      return this.unavailable(
        'historical-telemetry',
        request.scope,
        CLAUDE_PROMETHEUS_SOURCE,
        'temporarily-unavailable',
        'Claude telemetry stack is not ready',
      )
    }
    try {
      const value = request.scope.kind === 'session'
        ? historicalFromSessionSeries(await query.sessionSeries({
            sessionId: request.scope.sessionId,
            userEmail: this.getDefaultUserEmail(),
            endSec: Math.floor(this.now() / 1_000),
            windowSec: 300,
            stepSec: 5,
          }))
        : historicalFromHud(await query.todayHud({
            userEmail: this.getDefaultUserEmail(),
            tzOffsetMinutes: new Date(this.now()).getTimezoneOffset(),
          }), this.now())
      return this.available(
        'historical-telemetry',
        request.scope,
        CLAUDE_PROMETHEUS_SOURCE,
        value,
      )
    } catch (error) {
      return this.unavailable(
        'historical-telemetry',
        request.scope,
        CLAUDE_PROMETHEUS_SOURCE,
        'source-error',
        (error as Error).message,
      )
    }
  }

  private async observeContextBreakdown(
    request: ProviderObservationRequestFor<'context-breakdown'>,
  ): Promise<ProviderObservationSnapshotFor<'context-breakdown', ClaudeObservationDetail>> {
    try {
      const legacyContext = await this.getDetailedContext(request.scope.sessionId)
      return {
        ...this.available(
          'context-breakdown',
          request.scope,
          CLAUDE_CONTEXT_SOURCE,
          {
            categories: legacyContext.categories.map((category, index) => ({
              id: category.name || `category-${index + 1}`,
              label: category.name || `Category ${index + 1}`,
              tokens: category.tokens,
            })),
          },
        ),
        detail: { legacyContext },
      }
    } catch (error) {
      return this.unavailable(
        'context-breakdown',
        request.scope,
        CLAUDE_CONTEXT_SOURCE,
        'source-error',
        (error as Error).message,
      )
    }
  }

  private available<K extends 'historical-telemetry' | 'context-breakdown'>(
    kind: K,
    scope: ProviderObservationRequestFor<K>['scope'],
    source: ProviderSource,
    value: K extends 'historical-telemetry'
      ? ProviderHistoricalTelemetry
      : ProviderContextBreakdown,
  ): ProviderObservationSnapshotFor<K, ClaudeObservationDetail> {
    const observedAt = new Date(this.now()).toISOString()
    return {
      kind,
      providerId: CLAUDE_PROVIDER_ID,
      scope,
      source,
      freshness: { state: 'fresh', observedAt, checkedAt: observedAt },
      availability: { state: 'available', value },
    } as ProviderObservationSnapshotFor<K, ClaudeObservationDetail>
  }

  private notObserved<K extends 'session-usage' | 'session-context' | 'provider-quota'>(
    kind: K,
    scope: ProviderObservationRequestFor<K>['scope'],
    source: ProviderSource,
  ): ProviderObservationSnapshotFor<K, ClaudeObservationDetail> {
    return this.unavailable(kind, scope, source, 'not-observed')
  }

  private unavailable<K extends ProviderObservationKind>(
    kind: K,
    scope: ProviderObservationRequestFor<K>['scope'],
    source: ProviderSource,
    reason: 'not-observed' | 'source-error' | 'not-applicable' | 'temporarily-unavailable',
    message?: string,
  ): ProviderObservationSnapshotFor<K, ClaudeObservationDetail> {
    return {
      kind,
      providerId: CLAUDE_PROVIDER_ID,
      scope,
      source,
      freshness: {
        state: 'unknown',
        observedAt: null,
        checkedAt: new Date(this.now()).toISOString(),
      },
      availability: {
        state: 'unavailable',
        reason,
        ...(message ? { message } : {}),
      },
    } as ProviderObservationSnapshotFor<K, ClaudeObservationDetail>
  }

  private requireTelemetryQuery(): ClaudeTelemetryQuery {
    const query = this.getTelemetryQuery()
    if (!query) throw new Error('Claude telemetry stack is not ready')
    return query
  }
}

export function createClaudeObservationAdapter(
  options: ClaudeObservationAdapterOptions,
): ClaudeObservationAdapter {
  return new ClaudeObservationAdapter(options)
}

function historicalFromSessionSeries(series: HudSeries): ProviderHistoricalTelemetry {
  return {
    series: [
      telemetrySeries('cost', 'USD', series.series.cost),
      telemetrySeries('tokens', 'tokens', series.series.tokens),
      telemetrySeries('cache-hit', 'ratio', series.series.cache),
      telemetrySeries('duty', 'ratio', series.series.duty),
    ],
  }
}

function historicalFromHud(hud: HudSnapshot, now: number): ProviderHistoricalTelemetry {
  const at = new Date(now).toISOString()
  return {
    series: [
      singletonSeries('cost', 'USD', at, hud.cost.total),
      singletonSeries('tokens', 'tokens', at, hud.tokens.total),
      singletonSeries('token-rate-minute', 'tokens/minute', at, hud.rate.perMin),
      singletonSeries('token-rate-hour', 'tokens/hour', at, hud.rate.perHour),
      singletonSeries('cache-hit', 'ratio', at, hud.cacheHitPct),
      singletonSeries('duty', 'ratio', at, hud.dutyCycle.value),
    ],
  }
}

function telemetrySeries(
  metric: string,
  unit: string,
  points: readonly [number, number | null][],
) {
  return {
    metric,
    unit,
    points: points.map(([at, value]) => ({ at: new Date(at * 1_000).toISOString(), value })),
  }
}

function singletonSeries(
  metric: string,
  unit: string,
  at: string,
  value: number | null,
) {
  return { metric, unit, points: [{ at, value }] }
}
