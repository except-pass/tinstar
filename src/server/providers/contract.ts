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
  /**
   * Session names are reusable. Durable dispatchers should carry the live
   * process incarnation so provider-local queues cannot leak across a restart.
   * Optional keeps adapters compatible with callers that have no lifecycle
   * identity, while delivery-ledger recipients always provide it.
   */
  incarnation?: string
}

export interface ProviderDeliveryTarget extends ProviderDeliveryRecipient {
  /** Fences a reused session name to the process selected by the router. */
  incarnation: string
}

/**
 * The adapter may already have performed its final-mile side effect before a
 * malformed result is detected. Callers must not blind-retry when
 * `sideEffectMayHaveOccurred` is true; the offending result remains attached
 * for ledger policy and diagnostics. Only a post-invocation accept failure may
 * have delivered. Preflight rejections and confirmation failures are read-only,
 * so `sideEffectMayHaveOccurred` is false; a non-null confirmation result does
 * not imply a delivery side effect.
 * `actualProviderId` is non-null exactly when a foreign top-level or recipient
 * provider caused rejection; it is null for provider-neutral message, attempt,
 * or session drift, across both preflight and post-invocation failures. In a
 * preflight failure, `expected.providerId` is the rejecting adapter while
 * `expected.recipient` preserves the submitted target; provider IDs inside
 * `expected` differ only for recipient-routing failures.
 */
export class ProviderDeliveryIdentityError extends Error {
  readonly name = 'ProviderDeliveryIdentityError'

  constructor(
    message: string,
    readonly sideEffectMayHaveOccurred: boolean,
    readonly result:
      | ProviderDeliveryAcceptance
      | ProviderDeliveryConfirmation
      | null,
    readonly expected: ProviderDeliveryResultIdentity,
    readonly actualProviderId: string | null,
  ) {
    super(message)
  }
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
  deliveryId: string
  attempt: number
  acceptedAt: string
  sender: {
    sessionId: string
    incarnation: string
  }
  destination: {
    subject: string
  }
  recipient: ProviderDeliveryTarget
  text: string
}

export interface ProviderDeliveryResultIdentity {
  providerId: string
  messageId: string
  attempt: number
  recipient: ProviderDeliveryRecipient
}

type ProviderDeliveryResult<TFields extends object> =
  ProviderDeliveryResultIdentity & TFields

// Confirmation only probes provider evidence; a new operation must explicitly
// decide whether it can perform the final-mile delivery side effect.
type ProviderDeliveryOperation =
  | { name: 'accept'; sideEffectMayHaveOccurred: true }
  | { name: 'confirm'; sideEffectMayHaveOccurred: false }

const ACCEPT_OPERATION = {
  name: 'accept',
  sideEffectMayHaveOccurred: true,
} as const satisfies ProviderDeliveryOperation
const CONFIRM_OPERATION = {
  name: 'confirm',
  sideEffectMayHaveOccurred: false,
} as const satisfies ProviderDeliveryOperation

export type ProviderDeliveryAcceptance<TDetail extends object = object> =
  | ProviderDeliveryResult<{
      /**
       * The synchronous provider receipt proves the final-mile enqueue. This
       * is terminal delivery evidence, not merely acceptance for later work.
       */
      state: 'delivered'
      deliveredAt: string
      evidence: ProviderDeliveryEvidence
      detail?: TDetail
    }>
  | ProviderDeliveryResult<{
      state: 'accepted'
      acceptedAt: string
      attemptRef?: string
      detail?: TDetail
    }>
  | ProviderDeliveryResult<{
      state: 'deferred'
      checkedAt: string
      reason: string
      retryAt?: string
      detail?: TDetail
    }>
  | ProviderDeliveryResult<{
      state: 'rejected'
      checkedAt: string
      reason: string
      retryable: boolean
      detail?: TDetail
    }>

export type AcceptedProviderDelivery<TDetail extends object = object> = Extract<
  ProviderDeliveryAcceptance<TDetail>,
  { state: 'accepted' }
>

/**
 * Stable provider, recipient, message, and attempt identity used for
 * confirmation. Provider-owned detail stays out of this input so heterogeneous
 * registries can safely erase adapter detail. An adapter that needs
 * provider-owned lookup state sets `attemptRef`; adapters that can derive state
 * from the shared identity may omit it.
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
  | ProviderDeliveryResult<{
      state: 'confirmed'
      confirmedAt: string
      evidence: ProviderDeliveryEvidence
      detail?: TDetail
    }>
  | ProviderDeliveryResult<{
      state: 'pending'
      checkedAt: string
      reason: string
      retryAt?: string
      detail?: TDetail
    }>
  | ProviderDeliveryResult<{
      state: 'failed'
      checkedAt: string
      reason: string
      retryable: boolean
      detail?: TDetail
    }>

interface ProviderDeliveryAcceptanceAdapter<TDetail extends object = object> {
  accept: (
    request: ProviderDeliveryRequest,
  ) => Promise<ProviderDeliveryAcceptance<TDetail>>
  /**
   * Idempotently discard provider-local work that never reached acceptance.
   * Dispatchers call this before terminalizing an exhausted deferral so a
   * stale FIFO head cannot block later messages for the same recipient.
   */
  abandon?: (request: ProviderDeliveryRequest) => Promise<void>
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
  /**
   * Read-only evidence probe: implementations must not perform or repeat the
   * final-mile delivery side effect because confirmation failures are retry-safe.
   */
  confirm: (
    acceptance: AcceptedProviderDeliveryIdentity,
  ) => Promise<ProviderDeliveryConfirmation<TDetail>>
}

export type ProviderDeliveryAdapter<TDetail extends object = object> =
  | ProviderAcceptanceOnlyDeliveryAdapter<TDetail>
  | ProviderConfirmingDeliveryAdapter<TDetail>

/** Apply the router-stamp and stable-identity guards to a delivery-only adapter. */
export function defineProviderDeliveryAdapter<TDetail extends object = object>(
  providerId: string,
  delivery: ProviderDeliveryAdapter<TDetail>,
): ProviderDeliveryAdapter<TDetail> {
  if (!providerId.trim() || providerId !== providerId.trim()) {
    throw new TypeError('Provider delivery adapter id must be non-empty and trimmed')
  }
  return guardDeliveryAdapter(providerId, delivery)
}

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
    assertProviderDeliveryRequest(providerId, request)
    const result = await rawAccept(request)
    assertDeliveryIdentity(
      providerId,
      ACCEPT_OPERATION,
      result,
      deliveryIdentityFor(providerId, request),
    )
    return result
  }
  rememberGuardedHandler(accept, rawAccept, 'delivery:accept')

  const rawAbandon = delivery.abandon
    ? unwrapGuardedHandler(delivery.abandon, 'delivery:abandon')
    : null
  const abandon = rawAbandon
    ? async (request: ProviderDeliveryRequest): Promise<void> => {
        assertProviderDeliveryRequest(providerId, request)
        await rawAbandon(request)
      }
    : null
  if (abandon) {
    rememberGuardedHandler(abandon, rawAbandon!, 'delivery:abandon')
  }

  const acceptanceAdapter = { accept, ...(abandon ? { abandon } : {}) }
  if (!delivery.confirm) return acceptanceAdapter

  const rawConfirm = unwrapGuardedHandler(delivery.confirm, 'delivery:confirm')
  const confirm = async (acceptance: AcceptedProviderDeliveryIdentity) => {
    if (acceptance.providerId !== providerId) {
      throw preflightDeliveryIdentityError(
        `Provider "${providerId}" delivery confirmation belongs to provider `
        + `"${acceptance.providerId}"`,
        {
          providerId,
          actualProviderId: acceptance.providerId,
          source: acceptance,
        },
      )
    }
    if (acceptance.recipient.providerId !== providerId) {
      throw preflightDeliveryIdentityError(
        `Provider "${providerId}" delivery confirmation targets recipient provider `
        + `"${acceptance.recipient.providerId}"`,
        {
          providerId,
          actualProviderId: acceptance.recipient.providerId,
          source: acceptance,
        },
      )
    }
    const result = await rawConfirm(acceptance)
    assertDeliveryIdentity(
      providerId,
      CONFIRM_OPERATION,
      result,
      deliveryIdentityFor(providerId, acceptance),
    )
    return result
  }
  rememberGuardedHandler(confirm, rawConfirm, 'delivery:confirm')
  return { ...acceptanceAdapter, confirm }
}

function assertProviderDeliveryRequest(
  providerId: string,
  request: ProviderDeliveryRequest,
): void {
  const problem = providerDeliveryRequestProblem(request)
  if (problem) {
    throw new TypeError(
      `Provider "${providerId}" delivery request is not router-stamped: ${problem}`,
    )
  }
  if (request.recipient.providerId !== providerId) {
    throw preflightDeliveryIdentityError(
      `Provider "${providerId}" delivery request is addressed to provider `
      + `"${request.recipient.providerId}"`,
      {
        providerId,
        actualProviderId: request.recipient.providerId,
        source: request,
      },
    )
  }
}

function providerDeliveryRequestProblem(request: ProviderDeliveryRequest): string | null {
  if (!request || typeof request !== 'object') return 'request must be an object'
  if (!request.messageId?.trim()) return 'messageId must not be empty'
  if (!request.deliveryId?.trim()) return 'deliveryId must not be empty'
  if (!Number.isInteger(request.attempt) || request.attempt < 1) return 'attempt must be positive'
  if (!request.acceptedAt?.trim() || Number.isNaN(Date.parse(request.acceptedAt))) {
    return 'acceptedAt must be an ISO timestamp'
  }
  if (!request.sender?.sessionId?.trim() || !request.sender.incarnation?.trim()) {
    return 'sender identity is incomplete'
  }
  if (!request.destination?.subject?.trim()) return 'destination subject must not be empty'
  if (!request.recipient?.providerId?.trim()
    || !request.recipient.sessionId?.trim()
    || !request.recipient.incarnation?.trim()) return 'recipient identity is incomplete'
  if (typeof request.text !== 'string' || !request.text.trim()) return 'text must not be empty'
  return null
}

function preflightDeliveryIdentityError(
  message: string,
  options: {
    providerId: string
    actualProviderId: string
    source: Pick<
      ProviderDeliveryResultIdentity,
      'messageId' | 'attempt' | 'recipient'
    >
  },
): ProviderDeliveryIdentityError {
  return new ProviderDeliveryIdentityError(
    message,
    false,
    null,
    deliveryIdentityFor(options.providerId, options.source),
    options.actualProviderId,
  )
}

function deliveryIdentityFor(
  providerId: string,
  source: Pick<
    ProviderDeliveryResultIdentity,
    'messageId' | 'attempt' | 'recipient'
  >,
): ProviderDeliveryResultIdentity {
  return {
    providerId,
    messageId: source.messageId,
    attempt: source.attempt,
    recipient: source.recipient,
  }
}

function deliveryResultIdentityError(
  message: string,
  options: {
    operation: ProviderDeliveryOperation
    actual: ProviderDeliveryAcceptance | ProviderDeliveryConfirmation
    expected: ProviderDeliveryResultIdentity
    actualProviderId: string | null
  },
): ProviderDeliveryIdentityError {
  return new ProviderDeliveryIdentityError(
    message,
    options.operation.sideEffectMayHaveOccurred,
    options.actual,
    options.expected,
    options.actualProviderId,
  )
}

function assertDeliveryIdentity(
  providerId: string,
  operation: ProviderDeliveryOperation,
  actual: ProviderDeliveryAcceptance | ProviderDeliveryConfirmation,
  expected: ProviderDeliveryResultIdentity,
): void {
  if (actual.providerId !== expected.providerId) {
    throw deliveryResultIdentityError(
      `Provider "${providerId}" delivery ${operation.name} returned providerId `
      + `"${actual.providerId}", expected "${expected.providerId}"`,
      {
        operation,
        actual,
        expected,
        actualProviderId: actual.providerId,
      },
    )
  }
  if (actual.messageId !== expected.messageId) {
    throw deliveryResultIdentityError(
      `Provider "${providerId}" delivery ${operation.name} returned messageId `
      + `"${actual.messageId}", expected "${expected.messageId}"`,
      {
        operation,
        actual,
        expected,
        actualProviderId: null,
      },
    )
  }
  if (actual.attempt !== expected.attempt) {
    throw deliveryResultIdentityError(
      `Provider "${providerId}" delivery ${operation.name} returned attempt `
      + `${actual.attempt}, expected ${expected.attempt}`,
      {
        operation,
        actual,
        expected,
        actualProviderId: null,
      },
    )
  }
  if (actual.recipient.providerId !== expected.recipient.providerId) {
    throw deliveryResultIdentityError(
      `Provider "${providerId}" delivery ${operation.name} returned recipient providerId `
      + `"${actual.recipient.providerId}", expected "${expected.recipient.providerId}"`,
      {
        operation,
        actual,
        expected,
        actualProviderId: actual.recipient.providerId,
      },
    )
  }
  if (actual.recipient.sessionId !== expected.recipient.sessionId) {
    throw deliveryResultIdentityError(
      `Provider "${providerId}" delivery ${operation.name} returned recipient sessionId `
      + `"${actual.recipient.sessionId}", expected "${expected.recipient.sessionId}"`,
      {
        operation,
        actual,
        expected,
        actualProviderId: null,
      },
    )
  }
  if (actual.recipient.incarnation !== expected.recipient.incarnation) {
    throw deliveryResultIdentityError(
      `Provider "${providerId}" delivery ${operation.name} returned recipient incarnation `
      + `"${actual.recipient.incarnation}", expected "${expected.recipient.incarnation}"`,
      {
        operation,
        actual,
        expected,
        actualProviderId: null,
      },
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
