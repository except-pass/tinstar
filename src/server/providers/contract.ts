import type {
  ProviderCapabilities,
  ProviderIdentity,
  ProviderObservationKind,
  ProviderObservationScope,
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

/**
 * Stable attempt identity used for confirmation. Provider-owned detail stays
 * out of this input so heterogeneous registries can safely erase adapter detail.
 */
export type AcceptedProviderDeliveryIdentity = Omit<
  AcceptedProviderDelivery<object>,
  'detail'
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
  accept: (
    request: ProviderDeliveryRequest,
  ) => Promise<ProviderDeliveryAcceptance<TDetail>>
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
  confirm: (
    acceptance: AcceptedProviderDeliveryIdentity,
  ) => Promise<ProviderDeliveryConfirmation<TDetail>>
}

export type ProviderDeliveryAdapter<TDetail extends object = object> =
  | ProviderAcceptanceOnlyDeliveryAdapter<TDetail>
  | ProviderConfirmingDeliveryAdapter<TDetail>

export type ProviderObservationHandlers<TDetail extends object = object> = {
  [K in ProviderObservationKind]: (
    request: ProviderObservationRequestFor<K>,
  ) => Promise<ProviderObservationSnapshotFor<K, TDetail>>
}

const rawObservationHandlerByGuard = new WeakMap<object, object>()

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
 * Registration boundary that preserves provider-specific detail while rejecting
 * capability drift. Observation results are checked when their handlers run
 * because availability can change between observations.
 */
export function defineProviderAdapter<TDetail extends object = object>(
  adapter: ProviderAdapter<TDetail>,
): ProviderAdapter<TDetail> {
  const acceptanceSupported = adapter.capabilities.delivery.acceptance.state === 'supported'
  const hasAcceptance = adapter.delivery !== null
  if (acceptanceSupported !== hasAcceptance) {
    throw new Error(
      `Provider "${adapter.provider.id}" delivery acceptance is ${acceptanceSupported ? 'supported' : 'unsupported'}, `
      + `but its adapter ${hasAcceptance ? 'supplies' : 'does not supply'} accept`,
    )
  }

  const confirmationSupported = adapter.capabilities.delivery.confirmation.state === 'supported'
  const hasConfirmation = typeof adapter.delivery?.confirm === 'function'
  if (confirmationSupported !== hasConfirmation) {
    throw new Error(
      `Provider "${adapter.provider.id}" delivery confirmation is ${confirmationSupported ? 'supported' : 'unsupported'}, `
      + `but its adapter ${hasConfirmation ? 'supplies' : 'does not supply'} confirm`,
    )
  }

  return {
    ...adapter,
    observe: {
      'session-usage': guardObservationHandler(
        adapter,
        'session-usage',
        adapter.observe['session-usage'],
      ),
      'session-context': guardObservationHandler(
        adapter,
        'session-context',
        adapter.observe['session-context'],
      ),
      'provider-quota': guardObservationHandler(
        adapter,
        'provider-quota',
        adapter.observe['provider-quota'],
      ),
      'historical-telemetry': guardObservationHandler(
        adapter,
        'historical-telemetry',
        adapter.observe['historical-telemetry'],
      ),
      'context-breakdown': guardObservationHandler(
        adapter,
        'context-breakdown',
        adapter.observe['context-breakdown'],
      ),
    },
  }
}

function guardObservationHandler<
  K extends ProviderObservationKind,
  TDetail extends object,
>(
  adapter: ProviderAdapter<TDetail>,
  kind: K,
  handler: (
    request: ProviderObservationRequestFor<K>,
  ) => Promise<ProviderObservationSnapshotFor<K, TDetail>>,
): (
  request: ProviderObservationRequestFor<K>,
) => Promise<ProviderObservationSnapshotFor<K, TDetail>> {
  const rawHandler = (
    rawObservationHandlerByGuard.get(handler) as typeof handler | undefined
  ) ?? handler
  const guardedHandler = async (request: ProviderObservationRequestFor<K>) => {
    const snapshot = await rawHandler(request)
    if (snapshot.providerId !== adapter.provider.id) {
      throw new Error(
        `Provider "${adapter.provider.id}" observation "${kind}" returned providerId `
        + `"${snapshot.providerId}"`,
      )
    }
    if (snapshot.kind !== kind) {
      throw new Error(
        `Provider "${adapter.provider.id}" observation "${kind}" returned kind `
        + `"${snapshot.kind}"`,
      )
    }
    if (!observationScopesEqual(snapshot.scope, request.scope)) {
      throw new Error(
        `Provider "${adapter.provider.id}" observation "${kind}" returned a scope `
        + 'that does not match the request',
      )
    }
    const capabilitySupported = adapter.capabilities.observations[kind].state === 'supported'
    const observationSupported = snapshot.availability.state !== 'unsupported'
    if (capabilitySupported !== observationSupported) {
      throw new Error(
        `Provider "${adapter.provider.id}" observation "${kind}" is declared `
        + `${capabilitySupported ? 'supported' : 'unsupported'}, but its handler returned `
        + `${snapshot.availability.state}`,
      )
    }
    return snapshot
  }
  rawObservationHandlerByGuard.set(guardedHandler, rawHandler)
  return guardedHandler
}

function observationScopesEqual(
  left: ProviderObservationScope,
  right: ProviderObservationScope,
): boolean {
  if (left.kind === 'session') {
    return right.kind === 'session' && left.sessionId === right.sessionId
  }
  return right.kind === 'provider' && left.accountRef === right.accountRef
}
