import type {
  ProviderQuota,
  ProviderSessionContext,
  ProviderSessionUsage,
  ProviderSource,
  ProviderTokenUsage,
} from '../../domain/provider-capabilities'
import type { Metric } from '../types'
import { ProviderCurrentObservationStores } from './observation-stores'

export interface ProviderTranscriptObservationEvent {
  /** Provider-stable identity for one normalized native event. */
  id: string
  /** Native capture time when available. */
  observedAt: string | null
  /** True when an existing file is being scanned to rebuild current state. */
  replayed: boolean
  sessionUsage?: ProviderSessionUsage
  sessionContext?: ProviderSessionContext
  providerQuota?: ProviderQuota
}

export interface ProviderObservationIngestInput {
  providerId: string
  sessionId: string
  accountRef: string
  source: ProviderSource
  event: ProviderTranscriptObservationEvent
}

export interface ProviderObservationMetricSink {
  pushMetric(metric: Metric): void
}

export interface ProviderObservationIngestorOptions {
  stores: ProviderCurrentObservationStores
  sink?: ProviderObservationMetricSink
  now?: () => number
  staleAfterMs?: number
}

const NOOP_SINK: ProviderObservationMetricSink = { pushMetric: () => {} }
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1_000
const MAX_SEEN_EVENT_IDS_PER_SESSION = 4_096

/**
 * Shared ingress for provider-native transcript observations.
 *
 * Provider adapters normalize their native events before this boundary. The
 * ingestor owns current-store projection, cross-session quota ordering, replay
 * dedupe, and provider-labelled historical metrics without knowing provider IDs.
 */
export class ProviderObservationIngestor {
  private readonly stores: ProviderCurrentObservationStores
  private readonly sink: ProviderObservationMetricSink
  private readonly now: () => number
  private readonly staleAfterMs: number
  private readonly seenBySession = new Map<string, Set<string>>()

  constructor(options: ProviderObservationIngestorOptions) {
    this.stores = options.stores
    this.sink = options.sink ?? NOOP_SINK
    this.now = options.now ?? Date.now
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  }

  ingest(input: ProviderObservationIngestInput): boolean {
    const identity = JSON.stringify([input.providerId, input.sessionId])
    let seen = this.seenBySession.get(identity)
    if (!seen) {
      seen = new Set()
      this.seenBySession.set(identity, seen)
    }
    if (seen.has(input.event.id)) return false

    const checkedAt = new Date(this.now()).toISOString()
    const observedAt = input.event.observedAt ?? checkedAt
    const freshness = {
      state: 'fresh' as const,
      observedAt,
      checkedAt,
      staleAfterMs: this.staleAfterMs,
    }
    let changed = false

    if (input.event.sessionUsage) {
      changed = this.stores.sessions.setUsage({
        kind: 'session-usage',
        providerId: input.providerId,
        scope: { kind: 'session', sessionId: input.sessionId },
        source: input.source,
        freshness,
        availability: { state: 'available', value: input.event.sessionUsage },
      }) || changed
    }
    if (input.event.sessionContext) {
      changed = this.stores.sessions.setContext({
        kind: 'session-context',
        providerId: input.providerId,
        scope: { kind: 'session', sessionId: input.sessionId },
        source: input.source,
        freshness,
        availability: { state: 'available', value: input.event.sessionContext },
      }) || changed
    }
    if (input.event.providerQuota) {
      const prior = this.stores.quotas.get(input.providerId, input.accountRef)
      const priorObservedAt = prior?.freshness.observedAt
      if (
        priorObservedAt === null
        || priorObservedAt === undefined
        || Date.parse(observedAt) >= Date.parse(priorObservedAt)
      ) {
        changed = this.stores.quotas.set({
          kind: 'provider-quota',
          providerId: input.providerId,
          scope: { kind: 'provider', accountRef: input.accountRef },
          source: input.source,
          freshness,
          availability: { state: 'available', value: input.event.providerQuota },
        }) || changed
      }
    }

    seen.add(input.event.id)
    if (seen.size > MAX_SEEN_EVENT_IDS_PER_SESSION) {
      const oldest = seen.values().next().value
      if (oldest) seen.delete(oldest)
    }

    if (!input.event.replayed) this.emitHistoricalMetrics(input, observedAt)
    return changed
  }

  clearSession(providerId: string, sessionId: string): void {
    this.seenBySession.delete(JSON.stringify([providerId, sessionId]))
    this.stores.sessions.delete(providerId, sessionId)
  }

  private emitHistoricalMetrics(
    input: ProviderObservationIngestInput,
    timestamp: string,
  ): void {
    const model = input.event.sessionUsage?.model ?? 'unknown'
    if (input.event.sessionUsage?.cumulativeTokens) {
      this.emitTokenMetrics(
        input,
        input.event.sessionUsage.cumulativeTokens,
        'cumulative',
        model,
        timestamp,
      )
    }
    if (input.event.sessionUsage?.latestTurnTokens) {
      this.emitTokenMetrics(
        input,
        input.event.sessionUsage.latestTurnTokens,
        'latest-turn',
        model,
        timestamp,
      )
    }

    const context = input.event.sessionContext
    if (context?.usedTokens !== undefined) {
      this.pushGauge('tinstar_provider_session_context_tokens', context.usedTokens, {
        provider: input.providerId,
        session: input.sessionId,
        measurement: 'used',
        model,
      }, timestamp)
    }
    if (context?.windowTokens !== undefined) {
      this.pushGauge('tinstar_provider_session_context_tokens', context.windowTokens, {
        provider: input.providerId,
        session: input.sessionId,
        measurement: 'window',
        model,
      }, timestamp)
    }
    if (context?.usedPercent !== undefined) {
      this.pushGauge('tinstar_provider_session_context_used_ratio', context.usedPercent / 100, {
        provider: input.providerId,
        session: input.sessionId,
        model,
      }, timestamp)
    }

    for (const window of input.event.providerQuota?.windows ?? []) {
      const labels = {
        provider: input.providerId,
        account: input.accountRef,
        window: window.id,
        window_minutes: String(window.windowMinutes),
      }
      this.pushGauge(
        'tinstar_provider_quota_used_ratio',
        window.usedPercent / 100,
        labels,
        timestamp,
      )
      if (window.resetsAt) {
        this.pushGauge(
          'tinstar_provider_quota_resets_at_seconds',
          Date.parse(window.resetsAt) / 1_000,
          labels,
          timestamp,
        )
      }
    }
  }

  private emitTokenMetrics(
    input: ProviderObservationIngestInput,
    usage: ProviderTokenUsage,
    aggregation: 'cumulative' | 'latest-turn',
    model: string,
    timestamp: string,
  ): void {
    for (const [token, value] of Object.entries(usage)) {
      if (value === undefined) continue
      this.pushGauge('tinstar_provider_session_tokens', value, {
        provider: input.providerId,
        session: input.sessionId,
        aggregation,
        token,
        model,
      }, timestamp)
    }
  }

  private pushGauge(
    name: string,
    value: number,
    labels: Record<string, string>,
    timestamp: string,
  ): void {
    this.sink.pushMetric({ name, type: 'gauge', value, labels, timestamp })
  }
}
