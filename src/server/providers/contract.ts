import type {
  ProviderCapabilities,
  ProviderIdentity,
  ProviderObservationKind,
  ProviderObservationRequestFor,
  ProviderObservationSnapshotFor,
  ProviderSource,
} from '../../domain/provider-capabilities'

export interface ProviderDeliveryRecipient {
  providerId: string
  sessionId: string
}

/**
 * One already-ledgered logical message making one final-mile attempt.
 *
 * `acceptedAt` is the router/ledger acceptance time. The adapter's own
 * `accepted` result below has narrower meaning: it took responsibility for
 * this attempt, not that the logical message is confirmed delivered.
 */
export interface ProviderDeliveryRequest {
  messageId: string
  attempt: number
  acceptedAt: string
  senderSessionId: string
  recipient: ProviderDeliveryRecipient
  text: string
}

export type ProviderDeliveryAcceptance<TDetail extends object = object> =
  | {
      state: 'accepted'
      messageId: string
      attempt: number
      acceptedAt: string
      attemptRef?: string
      detail?: TDetail
    }
  | {
      state: 'deferred'
      messageId: string
      attempt: number
      checkedAt: string
      reason: string
      retryAt?: string
      detail?: TDetail
    }
  | {
      state: 'rejected'
      messageId: string
      attempt: number
      checkedAt: string
      reason: string
      retryable: boolean
      detail?: TDetail
    }

export type AcceptedProviderDelivery<TDetail extends object = object> = Extract<
  ProviderDeliveryAcceptance<TDetail>,
  { state: 'accepted' }
>

export interface ProviderDeliveryEvidence {
  source: ProviderSource
  reference?: string
}

export type ProviderDeliveryConfirmation<TDetail extends object = object> =
  | {
      state: 'confirmed'
      messageId: string
      attempt: number
      confirmedAt: string
      evidence: ProviderDeliveryEvidence
      detail?: TDetail
    }
  | {
      state: 'pending'
      messageId: string
      attempt: number
      checkedAt: string
      reason: string
      retryAt?: string
      detail?: TDetail
    }
  | {
      state: 'failed'
      messageId: string
      attempt: number
      checkedAt: string
      reason: string
      retryable: boolean
      detail?: TDetail
    }

interface ProviderDeliveryAcceptanceAdapter<TDetail extends object = object> {
  accept(
    request: ProviderDeliveryRequest,
  ): Promise<ProviderDeliveryAcceptance<TDetail>>
}

export interface ProviderAcceptanceOnlyDeliveryAdapter<
  TDetail extends object = object,
> extends ProviderDeliveryAcceptanceAdapter<TDetail> {
  /**
   * Absence is meaningful: the provider accepts attempts but exposes no
   * confirmation evidence.
   */
  confirm?: never
}

export interface ProviderConfirmingDeliveryAdapter<
  TDetail extends object = object,
> extends ProviderDeliveryAcceptanceAdapter<TDetail> {
  confirm(
    request: ProviderDeliveryRequest,
    acceptance: AcceptedProviderDelivery<TDetail>,
  ): Promise<ProviderDeliveryConfirmation<TDetail>>
}

export type ProviderDeliveryAdapter<TDetail extends object = object> =
  | ProviderAcceptanceOnlyDeliveryAdapter<TDetail>
  | ProviderConfirmingDeliveryAdapter<TDetail>

export type ProviderObservationHandlers<TDetail extends object = object> = {
  [K in ProviderObservationKind]: (
    request: ProviderObservationRequestFor<K>,
  ) => Promise<ProviderObservationSnapshotFor<K, TDetail>>
}

/**
 * Provider-neutral boundary for a managed CLI.
 *
 * Managed sessions remain terminal-first: start, resume, stop, and liveness
 * belong to the existing terminal lifecycle. Native channels and service
 * transports may augment observation or delivery without replacing that
 * lifecycle. An app-server can therefore become a future adapter transport,
 * but it is not a prerequisite for registering or launching a provider.
 *
 * The registry/factory and lifecycle resolution intentionally live in the next
 * milestone. This contract is open: a new provider supplies this object without
 * adding its identity to shared domain, router, or UI code.
 */
export interface ProviderAdapter<TDetail extends object = object> {
  provider: ProviderIdentity
  sessionLifecycle: 'terminal'
  capabilities: ProviderCapabilities<TDetail>
  observe: ProviderObservationHandlers<TDetail>
  delivery: ProviderDeliveryAdapter<TDetail> | null
}

/**
 * Identity helper that preserves an adapter's provider-specific detail type
 * while exposing the provider-neutral contract to registries and consumers.
 */
export function defineProviderAdapter<TDetail extends object = object>(
  adapter: ProviderAdapter<TDetail>,
): ProviderAdapter<TDetail> {
  return adapter
}
