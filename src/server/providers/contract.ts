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
 * An adapter that needs provider-owned lookup state sets `attemptRef`; adapters
 * that can derive state from `messageId` and `attempt` may omit it.
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

interface RawGuardedHandler {
  kind: string
  handler: object
}

const rawHandlerByGuard = new WeakMap<object, RawGuardedHandler>()

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
 * because availability can change between observations. Handlers must stamp
 * snapshots with the registering adapter's provider ID. Re-registering an
 * adapter unwraps earlier guards before applying the new manifest.
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
    delivery: adapter.delivery === null
      ? null
      : guardDeliveryAdapter(adapter.provider.id, adapter.delivery),
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

function guardDeliveryAdapter<TDetail extends object>(
  providerId: string,
  delivery: ProviderDeliveryAdapter<TDetail>,
): ProviderDeliveryAdapter<TDetail> {
  const rawAccept = unwrapGuardedHandler(delivery.accept, 'delivery:accept')
  const accept = async (request: ProviderDeliveryRequest) => {
    const result = await rawAccept(request)
    assertDeliveryIdentity(providerId, 'accept', result, request)
    return result
  }
  rememberGuardedHandler(accept, rawAccept, 'delivery:accept')

  if (!delivery.confirm) return { accept }

  const rawConfirm = unwrapGuardedHandler(delivery.confirm, 'delivery:confirm')
  const confirm = async (acceptance: AcceptedProviderDeliveryIdentity) => {
    const result = await rawConfirm(acceptance)
    assertDeliveryIdentity(providerId, 'confirm', result, acceptance)
    return result
  }
  rememberGuardedHandler(confirm, rawConfirm, 'delivery:confirm')
  return { accept, confirm }
}

function assertDeliveryIdentity(
  providerId: string,
  operation: 'accept' | 'confirm',
  actual: { messageId: string; attempt: number },
  expected: { messageId: string; attempt: number },
): void {
  if (actual.messageId !== expected.messageId) {
    throw new Error(
      `Provider "${providerId}" delivery ${operation} returned messageId `
      + `"${actual.messageId}", expected "${expected.messageId}"`,
    )
  }
  if (actual.attempt !== expected.attempt) {
    throw new Error(
      `Provider "${providerId}" delivery ${operation} returned attempt `
      + `${actual.attempt}, expected ${expected.attempt}`,
    )
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
  const guardKind = `observation:${kind}`
  const rawHandler = unwrapGuardedHandler(handler, guardKind)
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
  rememberGuardedHandler(guardedHandler, rawHandler, guardKind)
  return guardedHandler
}

function unwrapGuardedHandler<THandler extends object>(
  handler: THandler,
  kind: string,
): THandler {
  const entry = rawHandlerByGuard.get(handler)
  return entry?.kind === kind
    ? entry.handler as THandler
    : handler
}

function rememberGuardedHandler<THandler extends object>(
  guard: THandler,
  rawHandler: THandler,
  kind: string,
): void {
  rawHandlerByGuard.set(guard, { kind, handler: rawHandler })
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
