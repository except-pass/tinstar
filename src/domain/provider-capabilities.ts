/**
 * Stable, open identity for a managed CLI provider.
 *
 * This is deliberately not a string-literal union. Adding another provider is
 * configuration plus an adapter, not a shared schema migration.
 */
export interface ProviderIdentity {
  id: string
  label: string
}

/** A provider-native source, named without exposing its wire shape to consumers. */
export interface ProviderSource {
  id: string
  label: string
}

export type CapabilitySupport<T> =
  | {
      state: 'supported'
      detail: T
    }
  | {
      state: 'unsupported'
      reason: string
    }

export type ProviderObservationKind =
  | 'session-usage'
  | 'session-context'
  | 'provider-quota'
  | 'historical-telemetry'
  | 'context-breakdown'

export interface ObservationCapabilityDetail {
  sources: readonly ProviderSource[]
}

export type DeliveryTransportKind =
  | 'terminal'
  | 'provider-channel'
  | 'service'

export interface DeliveryTransport {
  id: string
  kind: DeliveryTransportKind
  label: string
}

export type DeliveryTiming = 'mid-turn' | 'next-boundary'

export interface DeliveryAcceptanceCapabilityDetail {
  transports: readonly DeliveryTransport[]
  timing: readonly DeliveryTiming[]
}

export interface DeliveryConfirmationEvidence {
  id: string
  label: string
}

export interface DeliveryConfirmationCapabilityDetail {
  evidence: readonly DeliveryConfirmationEvidence[]
}

/**
 * Exhaustive declarations let callers distinguish unsupported behavior from a
 * source that is supported but has not produced data yet.
 */
export interface ProviderCapabilities<TDetail extends object = object> {
  observations: Readonly<Record<
    ProviderObservationKind,
    CapabilitySupport<ObservationCapabilityDetail & TDetail>
  >>
  delivery: {
    acceptance: CapabilitySupport<DeliveryAcceptanceCapabilityDetail & TDetail>
    confirmation: CapabilitySupport<DeliveryConfirmationCapabilityDetail & TDetail>
  }
}

export type ProviderObservationScope =
  | ProviderSessionScope
  | ProviderScope

export interface ProviderSessionScope {
  kind: 'session'
  sessionId: string
}

/**
 * Account quota is provider-scoped. An optional opaque account reference may
 * distinguish configured accounts within one provider, but consumers must
 * never add quota windows across provider identities.
 */
export interface ProviderScope {
  kind: 'provider'
  accountRef?: string
}

export type ProviderSnapshotFreshness =
  | {
      state: 'fresh'
      observedAt: string
      checkedAt: string
      staleAfterMs?: number
    }
  | {
      state: 'stale'
      observedAt: string
      checkedAt: string
      staleSince?: string
    }
  | {
      state: 'unknown'
      observedAt: string | null
      checkedAt: string
    }

export type ProviderSnapshotUnavailableReason =
  | 'not-observed'
  | 'source-error'
  | 'session-not-running'
  | 'not-applicable'
  | 'temporarily-unavailable'

/**
 * Availability is a discriminated union so zero remains real data, while
 * transient absence and permanent lack of support remain distinct.
 */
export type ProviderSnapshotAvailability<TValue> =
  | {
      state: 'available'
      value: TValue
    }
  | {
      state: 'unavailable'
      reason: ProviderSnapshotUnavailableReason
      message?: string
    }
  | {
      state: 'unsupported'
      reason: string
    }

export interface ProviderTokenUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  total?: number
}

export type ProviderSessionUsage = {
  model?: string
} & (
  | {
      /** Usage accumulated across the provider session or thread. */
      cumulativeTokens: ProviderTokenUsage
      /** Usage attributed only to the latest request, when exposed separately. */
      latestTurnTokens?: ProviderTokenUsage
    }
  | {
      /** Some providers expose request usage without a session-wide counter. */
      cumulativeTokens?: ProviderTokenUsage
      latestTurnTokens: ProviderTokenUsage
    }
)

export interface ProviderSessionContext {
  usedTokens?: number
  windowTokens?: number
  usedPercent?: number
}

export interface ProviderQuotaWindow {
  /** Provider-native stable key; no shared 5-hour/7-day vocabulary is assumed. */
  id: string
  label: string
  /** Native window duration; Codex exposes this directly as `window_minutes`. */
  windowMinutes: number
  usedPercent: number
  resetsAt?: string
}

export interface ProviderQuota {
  windows: readonly ProviderQuotaWindow[]
}

export interface ProviderTelemetryPoint {
  at: string
  value: number | null
}

export interface ProviderTelemetrySeries {
  metric: string
  unit: string
  points: readonly ProviderTelemetryPoint[]
}

export interface ProviderHistoricalTelemetry {
  series: readonly ProviderTelemetrySeries[]
}

export interface ProviderContextCategory {
  id: string
  label: string
  tokens: number
}

export interface ProviderContextBreakdown {
  categories: readonly ProviderContextCategory[]
}

interface ProviderObservationValueByKind {
  'session-usage': ProviderSessionUsage
  'session-context': ProviderSessionContext
  'provider-quota': ProviderQuota
  'historical-telemetry': ProviderHistoricalTelemetry
  'context-breakdown': ProviderContextBreakdown
}

interface ProviderObservationScopeByKind {
  'session-usage': ProviderSessionScope
  'session-context': ProviderSessionScope
  'provider-quota': ProviderScope
  'historical-telemetry': ProviderObservationScope
  'context-breakdown': ProviderSessionScope
}

export type ProviderObservationRequestFor<K extends ProviderObservationKind> = {
  kind: K
  scope: ProviderObservationScopeByKind[K]
}

export type ProviderObservationRequest = {
  [K in ProviderObservationKind]: ProviderObservationRequestFor<K>
}[ProviderObservationKind]

export interface ProviderSnapshot<
  TKind extends ProviderObservationKind,
  TScope extends ProviderObservationScope,
  TValue,
  TDetail extends object = object,
> {
  kind: TKind
  providerId: string
  scope: TScope
  /**
   * null means there is no source for this observation, normally because the
   * capability is unsupported. A supported source that is temporarily missing
   * keeps its identity here and reports `availability: unavailable`.
   */
  source: ProviderSource | null
  freshness: ProviderSnapshotFreshness
  availability: ProviderSnapshotAvailability<TValue>
  /** Adapter-owned optional data. Shared consumers carry it but do not inspect it. */
  detail?: TDetail
}

export type ProviderObservationSnapshotFor<
  K extends ProviderObservationKind,
  TDetail extends object = object,
> = ProviderSnapshot<
  K,
  ProviderObservationScopeByKind[K],
  ProviderObservationValueByKind[K],
  TDetail
>

export type ProviderObservationSnapshot<TDetail extends object = object> = {
  [K in ProviderObservationKind]: ProviderObservationSnapshotFor<K, TDetail>
}[ProviderObservationKind]

export type ProviderQuotaSnapshot<TDetail extends object = object> = ProviderSnapshot<
  'provider-quota',
  ProviderScope,
  ProviderQuota,
  TDetail
>
