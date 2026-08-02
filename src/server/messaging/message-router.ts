import { randomUUID } from 'node:crypto'
import { connect, type NatsConnection, type Subscription } from 'nats'
import { log } from '../logger'
import {
  validateDeliveryAcceptIntent,
  type DeliveryLedgerRecipient,
  type DeliverySessionRef,
} from './delivery-ledger'
import type {
  LiveDeliveryRequest,
  LiveDeliveryResult,
  RecipientExclusion,
} from './live-recipient-resolution'
import {
  TINSTAR_MESSAGE_ROUTER_AUTH_ENV,
  TINSTAR_AGENT_INCARNATION_ENV,
  TINSTAR_SESSION_NAME_ENV,
} from './message-router-address'
import {
  deriveMessageRouterSessionKey,
  messageRouterAuthKeyFromHex,
  signMessageRoutePayload,
  verifyMessageRouteEnvelope,
  type AuthenticatedMessageRoute,
} from './message-router-auth'

export {
  messageRouterSubject,
  MESSAGE_ROUTER_AUTH_FILE,
  MESSAGE_ROUTE_SUBJECT_PREFIX,
  TINSTAR_AGENT_INCARNATION_ENV,
  TINSTAR_MESSAGE_ROUTER_AUTH_ENV,
  TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV,
  TINSTAR_NATS_URL_ENV,
  TINSTAR_SESSION_NAME_ENV,
} from './message-router-address'
export {
  deriveMessageRouterSessionKey,
  messageRouterAuthKeyFromHex,
  messageRouterMasterKey,
  signMessageRoutePayload,
  verifyMessageRouteEnvelope,
} from './message-router-auth'
export type { AuthenticatedMessageRoute } from './message-router-auth'

export const MESSAGE_ROUTE_PROTOCOL_VERSION = 1 as const
export const DEFAULT_MESSAGE_ROUTE_TIMEOUT_MS = 15_000
export const MAX_MESSAGE_ROUTE_REQUEST_BYTES = 1024 * 1024
const ROUTER_QUEUE = 'tinstar-message-router-v1'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

/** Provider-neutral request submitted by each managed reply MCP. */
export interface MessageRouteRequest extends LiveDeliveryRequest {
  version: typeof MESSAGE_ROUTE_PROTOCOL_VERSION
}

export interface MessageRouteReceipt {
  requestId: string
  messageId: string
  acceptedAt: string
  destinationKind: 'dm' | 'broadcast' | 'breakout'
  deliveryIds: string[]
  recipients: DeliveryLedgerRecipient[]
  exclusions: RecipientExclusion[]
}

export type MessageRouteAcceptedResponse = {
  version: typeof MESSAGE_ROUTE_PROTOCOL_VERSION
  status: 'accepted' | 'partial'
  requestId: string
  receipt: MessageRouteReceipt
}

export interface MessageRouteErrorDetail {
  code: string
  message: string
  destinationKind?: 'dm' | 'broadcast' | 'breakout'
  subject?: string
  sessionId?: string
  reason?: string
  exclusions?: RecipientExclusion[]
  rejection?: {
    reason: string
    detail?: string
  }
}

export type MessageRouteErrorResponse = {
  version: typeof MESSAGE_ROUTE_PROTOCOL_VERSION
  status: 'error'
  requestId: string | null
  error: MessageRouteErrorDetail
}

export type MessageRouteResponse =
  | MessageRouteAcceptedResponse
  | MessageRouteErrorResponse

function errorMessage(result: Extract<LiveDeliveryResult, { ok: false }>): string {
  switch (result.error.code) {
    case 'invalid-request': return result.error.detail
    case 'invalid-destination': return `Invalid destination ${result.error.subject}.`
    case 'session-config-unavailable': return 'Managed sessions are unavailable.'
    case 'sender-unavailable': return `Managed sender ${result.error.sessionId} is unavailable (${result.error.reason}).`
    case 'recipient-unavailable': return 'No live recipient accepted the message.'
    case 'empty-live-set': return 'No live subscribers accepted the message.'
    case 'ambiguous-recipient': return 'The direct destination matched multiple sessions.'
    case 'ledger-rejected': return result.error.rejection.detail
      ?? `The delivery ledger rejected the message: ${result.error.rejection.reason}.`
    case 'ledger-failed': return result.error.detail
  }
}

/** Convert the internal resolver result to the stable request/reply wire shape. */
export function routeResponse(
  request: Pick<MessageRouteRequest, 'requestId'>,
  result: LiveDeliveryResult,
): MessageRouteResponse {
  if (result.ok) {
    return {
      version: MESSAGE_ROUTE_PROTOCOL_VERSION,
      status: result.exclusions.length > 0 ? 'partial' : 'accepted',
      requestId: request.requestId,
      receipt: {
        ...result.acceptance.receipt,
        destinationKind: result.destinationKind,
        recipients: result.acceptance.deliveries.map(delivery => ({
          ...delivery.recipient,
        })),
        exclusions: result.exclusions.map(exclusion => ({ ...exclusion })),
      },
    }
  }

  const detail: MessageRouteErrorDetail = {
    code: result.error.code,
    message: errorMessage(result),
  }
  if ('destinationKind' in result.error) {
    detail.destinationKind = result.error.destinationKind
  }
  if ('subject' in result.error) detail.subject = result.error.subject
  if (result.error.code === 'sender-unavailable') {
    detail.sessionId = result.error.sessionId
    detail.reason = result.error.reason
  }
  if ('exclusions' in result.error) {
    detail.exclusions = result.error.exclusions.map(exclusion => ({ ...exclusion }))
  }
  if (result.error.code === 'ledger-rejected') {
    detail.rejection = {
      reason: result.error.rejection.reason,
      ...(result.error.rejection.detail !== undefined
        ? { detail: result.error.rejection.detail }
        : {}),
    }
  }
  return {
    version: MESSAGE_ROUTE_PROTOCOL_VERSION,
    status: 'error',
    requestId: request.requestId,
    error: detail,
  }
}

function invalidResponse(message: string, requestId: string | null = null): MessageRouteErrorResponse {
  return {
    version: MESSAGE_ROUTE_PROTOCOL_VERSION,
    status: 'error',
    requestId,
    error: { code: 'invalid-request', message },
  }
}

function parseRouteRequest(data: Uint8Array, masterKey: Uint8Array):
  | { ok: true; request: MessageRouteRequest; authKey: Buffer }
  | { ok: false; response: MessageRouteErrorResponse; authKey?: Buffer } {
  if (data.byteLength > MAX_MESSAGE_ROUTE_REQUEST_BYTES) {
    return {
      ok: false,
      response: invalidResponse(
        `request exceeds ${MAX_MESSAGE_ROUTE_REQUEST_BYTES} bytes`,
      ),
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(textDecoder.decode(data))
  } catch {
    return { ok: false, response: invalidResponse('request must be valid UTF-8 JSON') }
  }
  if (!isRecord(parsed) || !isRecord(parsed.payload)) {
    return { ok: false, response: invalidResponse('request must be an object') }
  }
  const envelope = parsed as Partial<AuthenticatedMessageRoute<unknown>>
  const candidate = envelope.payload as Partial<MessageRouteRequest>
  const requestId = typeof candidate.requestId === 'string'
    && candidate.requestId.trim()
    ? candidate.requestId
    : null
  const sender = isRecord(candidate.sender)
    && isNonEmptyString(candidate.sender.sessionId)
    && isNonEmptyString(candidate.sender.incarnation)
    ? {
        sessionId: candidate.sender.sessionId,
        incarnation: candidate.sender.incarnation,
      }
    : null
  const authKey = sender
    ? deriveMessageRouterSessionKey(masterKey, sender)
    : undefined
  if (typeof envelope.auth !== 'string') {
    return {
      ok: false,
      response: invalidResponse('request authentication is missing', requestId),
      authKey,
    }
  }
  if (candidate.version !== MESSAGE_ROUTE_PROTOCOL_VERSION) {
    return {
      ok: false,
      response: invalidResponse(
        `unsupported message route version ${String(candidate.version)}`,
        requestId,
      ),
      authKey,
    }
  }
  const problem = validateDeliveryAcceptIntent(candidate)
  if (problem) {
    return { ok: false, response: invalidResponse(problem, requestId), authKey }
  }
  if (!authKey || !verifyMessageRouteEnvelope({
    payload: candidate,
    auth: envelope.auth,
  }, authKey)) {
    return {
      ok: false,
      response: invalidResponse('request authentication failed', requestId),
      authKey,
    }
  }
  return { ok: true, request: candidate as MessageRouteRequest, authKey }
}

function parseRouteResponse(
  data: Uint8Array,
  authKey: Uint8Array,
): MessageRouteResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(textDecoder.decode(data))
  } catch {
    throw new MessageRouteTransportError(
      'invalid-response',
      'Tinstar message router returned invalid UTF-8 JSON',
    )
  }
  if (!isRecord(parsed)
    || !('payload' in parsed)
    || typeof parsed.auth !== 'string'
    || !verifyMessageRouteEnvelope({ payload: parsed.payload, auth: parsed.auth }, authKey)) {
    throw new MessageRouteTransportError(
      'invalid-response',
      'Tinstar message router returned an unauthenticated response',
    )
  }
  if (!isMessageRouteResponse(parsed.payload)) {
    throw new MessageRouteTransportError(
      'invalid-response',
      'Tinstar message router returned an unsupported response',
    )
  }
  return parsed.payload
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecipient(value: unknown): value is DeliveryLedgerRecipient {
  return isRecord(value)
    && isNonEmptyString(value.providerId)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.incarnation)
}

function isExclusion(value: unknown): value is RecipientExclusion {
  return isRecord(value)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.reason)
}

function isMessageRouteResponse(value: unknown): value is MessageRouteResponse {
  if (!isRecord(value)
    || value.version !== MESSAGE_ROUTE_PROTOCOL_VERSION
    || (value.status !== 'accepted'
      && value.status !== 'partial'
      && value.status !== 'error')) return false
  if (value.status === 'error') {
    if (value.requestId !== null && !isNonEmptyString(value.requestId)) return false
    return isRecord(value.error)
      && isNonEmptyString(value.error.code)
      && isNonEmptyString(value.error.message)
  }
  if (!isNonEmptyString(value.requestId) || !isRecord(value.receipt)) return false
  const receipt = value.receipt
  return receipt.requestId === value.requestId
    && isNonEmptyString(receipt.messageId)
    && isNonEmptyString(receipt.acceptedAt)
    && (receipt.destinationKind === 'dm'
      || receipt.destinationKind === 'broadcast'
      || receipt.destinationKind === 'breakout')
    && Array.isArray(receipt.deliveryIds)
    && receipt.deliveryIds.length > 0
    && receipt.deliveryIds.every(isNonEmptyString)
    && Array.isArray(receipt.recipients)
    && receipt.recipients.length > 0
    && receipt.recipients.every(isRecipient)
    && Array.isArray(receipt.exclusions)
    && receipt.exclusions.every(isExclusion)
}

export type MessageRouteTransportErrorCode =
  | 'no-responder'
  | 'timeout'
  | 'request-failed'
  | 'invalid-response'

export class MessageRouteTransportError extends Error {
  readonly name = 'MessageRouteTransportError'

  constructor(
    readonly code: MessageRouteTransportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export interface NatsRouteRequestClient {
  request(
    subject: string,
    data: Uint8Array,
    options: { timeout: number },
  ): Promise<{ data: Uint8Array }>
}

function transportCode(error: unknown): MessageRouteTransportErrorCode {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === '503' || /no responders?/i.test(message)) return 'no-responder'
  if (code === 'TIMEOUT' || /timeout/i.test(message)) return 'timeout'
  return 'request-failed'
}

/**
 * Request durable acceptance. NATS request/reply supplies the critical offline
 * behavior: no Tinstar responder and response timeouts reject this promise.
 */
export async function requestMessageRoute(
  client: NatsRouteRequestClient,
  subject: string,
  request: MessageRouteRequest,
  authKey: Uint8Array,
  timeoutMs = DEFAULT_MESSAGE_ROUTE_TIMEOUT_MS,
): Promise<MessageRouteResponse> {
  let response: { data: Uint8Array }
  try {
    response = await client.request(
      subject,
      textEncoder.encode(JSON.stringify(signMessageRoutePayload(request, authKey))),
      { timeout: timeoutMs },
    )
  } catch (error) {
    const code = transportCode(error)
    const reason = code === 'no-responder'
      ? 'has no responder; Tinstar may be offline'
      : code === 'timeout'
        ? `did not respond within ${timeoutMs}ms`
        : `request failed: ${error instanceof Error ? error.message : String(error)}`
    throw new MessageRouteTransportError(
      code,
      `Tinstar message router ${reason}`,
      { cause: error },
    )
  }
  const decoded = parseRouteResponse(response.data, authKey)
  if (decoded.requestId !== request.requestId) {
    throw new MessageRouteTransportError(
      'invalid-response',
      'Tinstar message router returned a receipt for a different request',
    )
  }
  return decoded
}

export interface ReplyMcpToolInput {
  to: string
  text: string
  /** Optional caller idempotency key; generated once per tool invocation when absent. */
  requestId?: string
}

export interface ReplyMcpToolResult {
  isError?: true
  content: [{ type: 'text'; text: string }]
  structuredContent?: MessageRouteResponse
}

export interface ReplyMcpHandlerDependencies {
  sender: DeliverySessionRef
  authKey: Uint8Array
  route: (
    request: AuthenticatedMessageRoute<MessageRouteRequest>,
  ) => Promise<AuthenticatedMessageRoute<MessageRouteResponse>>
  createRequestId?: () => string
}

/** Read the fenced sender identity inherited by a managed reply MCP process. */
export function deliverySenderFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DeliverySessionRef {
  const sessionId = env[TINSTAR_SESSION_NAME_ENV]?.trim() ?? ''
  const incarnation = env[TINSTAR_AGENT_INCARNATION_ENV]?.trim() ?? ''
  if (!sessionId || !incarnation) {
    throw new Error(
      `managed reply requires ${TINSTAR_SESSION_NAME_ENV} and ${TINSTAR_AGENT_INCARNATION_ENV}`,
    )
  }
  return { sessionId, incarnation }
}

/** Read and validate the launch-scoped request authentication key. */
export function deliveryAuthKeyFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const value = env[TINSTAR_MESSAGE_ROUTER_AUTH_ENV]?.trim() ?? ''
  if (!value) {
    throw new Error(`managed reply requires ${TINSTAR_MESSAGE_ROUTER_AUTH_ENV}`)
  }
  return messageRouterAuthKeyFromHex(value)
}

/**
 * Provider-neutral implementation of the reply MCP tool contract.
 *
 * It intentionally receives only a request function. There is no publish
 * dependency and therefore no path that can report raw NATS publication as
 * durable acceptance.
 */
export function createReplyMcpHandler(
  dependencies: ReplyMcpHandlerDependencies,
): (input: ReplyMcpToolInput) => Promise<ReplyMcpToolResult> {
  const createRequestId = dependencies.createRequestId ?? randomUUID
  const sender = { ...dependencies.sender }
  return async (input) => {
    try {
      if (!input || typeof input !== 'object') {
        throw new Error('reply input must be an object')
      }
      const request: MessageRouteRequest = {
        version: MESSAGE_ROUTE_PROTOCOL_VERSION,
        requestId: input.requestId ?? createRequestId(),
        sender: { ...sender },
        destination: { subject: input.to },
        text: input.text,
      }
      const problem = validateDeliveryAcceptIntent(request)
      if (problem) throw new Error(problem)
      const responseEnvelope = await dependencies.route(
        signMessageRoutePayload(request, dependencies.authKey),
      )
      if (!verifyMessageRouteEnvelope(responseEnvelope, dependencies.authKey)
        || !isMessageRouteResponse(responseEnvelope.payload)
        || responseEnvelope.payload.requestId !== request.requestId) {
        throw new MessageRouteTransportError(
          'invalid-response',
          'Tinstar message router returned an unauthenticated response',
        )
      }
      const response = responseEnvelope.payload
      if (response.status === 'error') {
        return {
          isError: true,
          content: [{ type: 'text', text: response.error.message }],
          structuredContent: response,
        }
      }
      const qualifier = response.status === 'partial'
        ? `partially accepted with ${response.receipt.exclusions.length} exclusion(s)`
        : 'accepted'
      return {
        content: [{
          type: 'text',
          text: `Message ${response.receipt.messageId} ${qualifier} by Tinstar.`,
        }],
        structuredContent: response,
      }
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: error instanceof Error ? error.message : String(error),
        }],
      }
    }
  }
}

export interface NatsRouteMessage {
  data: Uint8Array
  reply?: string
  respond(data: Uint8Array): boolean
}

export interface NatsRouteSubscription extends AsyncIterable<NatsRouteMessage> {
  unsubscribe(): void
}

export interface NatsRouteConnection {
  subscribe(
    subject: string,
    options: { queue: string },
  ): NatsRouteSubscription
  closed(): Promise<unknown>
  flush(): Promise<void>
  drain(): Promise<void>
}

export interface NatsMessageRouterDependencies {
  subject: string
  authMasterKey: Uint8Array
  route: (request: MessageRouteRequest) => Promise<LiveDeliveryResult>
  connect?: () => Promise<NatsRouteConnection>
  natsUrl?: string
  reconnectDelayMs?: number
  observeAccepted?: (
    request: MessageRouteRequest,
    response: MessageRouteAcceptedResponse,
  ) => void
  /** Starts provider final-mile work only after the durable receipt is returned. */
  dispatchAccepted?: (
    request: MessageRouteRequest,
    response: MessageRouteAcceptedResponse,
  ) => Promise<void>
}

interface ProcessRouterOwner {
  generation: number
  active: NatsMessageRouterService | null
  /** Stops activation-scoped companions, such as the durable retry scheduler. */
  cleanup: (() => Promise<void>) | null
  transition: Promise<void>
}

const PROCESS_ROUTER_OWNERS = Symbol.for('tinstar.message-router-owners.v1')

function processRouterOwners(): Map<string, ProcessRouterOwner> {
  const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
  let owners = processGlobal[PROCESS_ROUTER_OWNERS] as
    | Map<string, ProcessRouterOwner>
    | undefined
  if (!owners) {
    owners = new Map()
    processGlobal[PROCESS_ROUTER_OWNERS] = owners
  }
  return owners
}

export interface MessageRouterOwnerLease {
  /**
   * Prepare and start one complete backend activation under this generation.
   * A superseded lease never invokes prepare.
   */
  activate(
    prepare: () => Promise<{
      service: NatsMessageRouterService
      cleanup?: () => Promise<void>
    } | null>,
  ): Promise<MessageRouterActivationResult>
  /** Start only if this is still the newest backend for the config root. */
  start(service: NatsMessageRouterService): Promise<MessageRouterActivationResult>
  /** Stop this lease's responder without disturbing a newer backend. */
  stop(): Promise<void>
}

export type MessageRouterActivationResult =
  | 'activated'
  | 'superseded'
  | 'failed'

export interface MessageRouterActivationDecision {
  cleanup: boolean
  continueStartup: boolean
  warnFailure: boolean
}

/** Backend policy for the router-owner outcome; undefined means no owner. */
export function messageRouterActivationDecision(
  result: MessageRouterActivationResult | undefined,
): MessageRouterActivationDecision {
  switch (result) {
    case 'superseded':
      return { cleanup: true, continueStartup: false, warnFailure: false }
    case 'failed':
      return { cleanup: true, continueStartup: false, warnFailure: true }
    case 'activated':
    case undefined:
      return { cleanup: false, continueStartup: true, warnFailure: false }
  }
}

interface PreparedMessageRouter {
  service: NatsMessageRouterService
  cleanup?: () => Promise<void>
}

async function runOwnerLifecycleStep(
  failureMessage: string,
  operation: (() => Promise<void>) | null | undefined,
): Promise<void> {
  if (!operation) return
  try {
    await operation()
  } catch (error) {
    log.warn(
      'message-router',
      `${failureMessage}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function stopOwnedRouterResources(
  state: ProcessRouterOwner,
  phase: 'previous' | 'lease' | 'shutdown',
): Promise<void> {
  const active = state.active
  const cleanup = state.cleanup
  state.active = null
  state.cleanup = null
  await runOwnerLifecycleStep(
    phase === 'previous'
      ? 'previous responder drain failed'
      : `${phase} responder stop failed`,
    active ? () => active.stop() : null,
  )
  await runOwnerLifecycleStep(
    phase === 'previous'
      ? 'previous responder cleanup failed'
      : `${phase} responder cleanup failed`,
    cleanup,
  )
}

async function rollbackPreparedRouter(
  prepared: PreparedMessageRouter,
): Promise<void> {
  await runOwnerLifecycleStep(
    'failed to stop rolled-back responder',
    () => prepared.service.stop(),
  )
  await runOwnerLifecycleStep(
    'failed to cleanup rolled-back responder',
    prepared.cleanup,
  )
}

/**
 * Reserve the one process-local responder slot for a config root.
 *
 * Vite can invoke backend initialization again without terminating the Node
 * process. Keeping this registry on globalThis makes it survive module reloads;
 * serialized replacement ensures two ledgers never answer the same queue.
 */
export function reserveMessageRouterOwner(configRoot: string): MessageRouterOwnerLease {
  const owners = processRouterOwners()
  const state = owners.get(configRoot) ?? {
    generation: 0,
    active: null,
    cleanup: null,
    transition: Promise.resolve(),
  }
  // The registry survives module reloads. Owners created by the previous
  // module shape have no companion cleanup field.
  state.cleanup ??= null
  owners.set(configRoot, state)
  const generation = ++state.generation

  const activate: MessageRouterOwnerLease['activate'] = async (prepare) => {
    const activation = state.transition.then(async (): Promise<MessageRouterActivationResult> => {
      if (state.generation !== generation) return 'superseded'

      // Reserving a lease is intentionally non-destructive. Only a backend
      // whose NATS connection is ready and whose generation is still current
      // may retire the working responder and retry scheduler it replaces.
      await stopOwnedRouterResources(state, 'previous')
      if (state.generation !== generation) return 'superseded'

      let prepared: PreparedMessageRouter | null
      try {
        prepared = await prepare()
      } catch (error) {
        log.warn(
          'message-router',
          `failed to prepare responder: ${error instanceof Error ? error.message : String(error)}`,
        )
        return 'failed'
      }
      if (!prepared) return 'failed'
      if (state.generation !== generation) {
        await runOwnerLifecycleStep(
          'failed to cleanup superseded responder',
          prepared.cleanup,
        )
        return 'superseded'
      }

      try {
        await prepared.service.start()
      } catch (error) {
        log.warn(
          'message-router',
          `failed to start responder: ${error instanceof Error ? error.message : String(error)}`,
        )
        await rollbackPreparedRouter(prepared)
        return 'failed'
      }
      if (state.generation !== generation) {
        await rollbackPreparedRouter(prepared)
        return 'superseded'
      }

      state.active = prepared.service
      state.cleanup = prepared.cleanup ?? null
      return 'activated'
    })
    const settled = activation.catch((error): MessageRouterActivationResult => {
      // This is a defensive boundary for an older HMR transition or a future
      // lifecycle branch that escapes the deliberately-contained steps above.
      log.warn(
        'message-router',
        `responder activation failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return 'failed'
    })
    state.transition = settled.then(() => {})
    return settled
  }

  return {
    activate,
    start(service) {
      return activate(async () => ({ service }))
    },
    async stop() {
      if (state.generation !== generation) return
      ++state.generation
      const stopping = state.transition.then(async () => {
        await stopOwnedRouterResources(state, 'lease')
      })
      state.transition = stopping.catch(() => {})
      await stopping
      if (owners.get(configRoot) === state && state.active === null) {
        owners.delete(configRoot)
      }
    },
  }
}

/** Test-only reset for process-global ownership left by HMR lifecycle tests. */
export async function resetMessageRouterOwnersForTests(): Promise<void> {
  const owners = processRouterOwners()
  const states = [...owners.values()]
  owners.clear()
  await Promise.all(states.map(async (state) => {
    ++state.generation
    await state.transition
    await stopOwnedRouterResources(state, 'shutdown')
  }))
}

/** Stop every responder owned by this process (signal shutdown). */
export async function stopAllMessageRouters(): Promise<void> {
  const owners = processRouterOwners()
  const states = [...owners.values()]
  owners.clear()
  await Promise.all(states.map(async (state) => {
    ++state.generation
    await state.transition
    await stopOwnedRouterResources(state, 'shutdown')
  }))
}

function natsConnection(url: string): Promise<NatsRouteConnection> {
  return connect({ servers: url }).then(connection => connectionAdapter(connection))
}

function connectionAdapter(connection: NatsConnection): NatsRouteConnection {
  return {
    subscribe: (subject, options) => subscriptionAdapter(
      connection.subscribe(subject, options),
    ),
    closed: () => connection.closed(),
    flush: () => connection.flush(),
    drain: () => connection.drain(),
  }
}

function subscriptionAdapter(subscription: Subscription): NatsRouteSubscription {
  return {
    unsubscribe: () => { subscription.unsubscribe() },
    async *[Symbol.asyncIterator]() {
      for await (const message of subscription) yield message
    },
  }
}

/** Long-lived NATS responder owned by the Tinstar backend. */
export class NatsMessageRouterService {
  private readonly connect: () => Promise<NatsRouteConnection>
  private readonly reconnectDelayMs: number
  private connection: NatsRouteConnection | null = null
  private subscription: NatsRouteSubscription | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly inFlight = new Set<Promise<void>>()
  private running = false
  private generation = 0
  private connectAttempt: { generation: number; promise: Promise<void> } | null = null

  constructor(private readonly dependencies: NatsMessageRouterDependencies) {
    this.connect = dependencies.connect
      ?? (() => natsConnection(dependencies.natsUrl ?? 'nats://127.0.0.1:4222'))
    this.reconnectDelayMs = dependencies.reconnectDelayMs ?? 5_000
  }

  async start(): Promise<void> {
    if (this.running) {
      const current = this.connectAttempt
      if (current?.generation === this.generation) await current.promise
      return
    }
    this.running = true
    const generation = ++this.generation
    await this.connectOnce(generation)
  }

  private connectOnce(generation: number): Promise<void> {
    if (!this.isCurrentGeneration(generation) || this.connection) {
      return Promise.resolve()
    }
    const current = this.connectAttempt
    if (current?.generation === generation) return current.promise

    const promise = this.openConnection(generation).finally(() => {
      if (this.connectAttempt?.promise === promise) this.connectAttempt = null
    })
    this.connectAttempt = { generation, promise }
    return promise
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.running && this.generation === generation
  }

  private async openConnection(generation: number): Promise<void> {
    let opened: NatsRouteConnection | null = null
    try {
      const connection = await this.connect()
      opened = connection
      if (!this.isCurrentGeneration(generation)) {
        await connection.drain()
        return
      }
      const subscription = connection.subscribe(this.dependencies.subject, {
        queue: ROUTER_QUEUE,
      })
      // `subscribe` is buffered by the NATS client. Do not let start() return
      // until the broker has observed the responder, or an immediate request
      // can receive a false 503 during healthy startup.
      await connection.flush()
      if (!this.isCurrentGeneration(generation)) {
        subscription.unsubscribe()
        await connection.drain()
        return
      }
      this.connection = connection
      this.subscription = subscription
      log.info('message-router', `responding on ${this.dependencies.subject}`)
      void this.consume(connection, subscription, generation)
      void connection.closed().then((error) => {
        if (this.connection !== connection
          || !this.isCurrentGeneration(generation)) return
        this.connection = null
        this.subscription = null
        if (error) {
          log.warn('message-router', `NATS connection closed: ${String(error)}`)
        }
        this.scheduleReconnect(generation)
      })
    } catch (error) {
      if (opened && this.connection !== opened) {
        try { await opened.drain() } catch { /* failed connection is already unusable */ }
      }
      if (this.connection === opened) this.connection = null
      if (this.isCurrentGeneration(generation)) {
        log.warn('message-router', `failed to connect: ${error instanceof Error ? error.message : String(error)}`)
        this.scheduleReconnect(generation)
      }
    }
  }

  private async consume(
    connection: NatsRouteConnection,
    subscription: NatsRouteSubscription,
    generation: number,
  ): Promise<void> {
    try {
      for await (const message of subscription) {
        const work = this.handle(message).finally(() => this.inFlight.delete(work))
        this.inFlight.add(work)
      }
    } catch (error) {
      if (this.running) {
        log.warn('message-router', `subscription ended: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      if (this.isCurrentGeneration(generation)
        && this.subscription === subscription) {
        this.subscription = null
        if (this.connection === connection) this.connection = null
        try { await connection.drain() } catch { /* closed connection */ }
        this.scheduleReconnect(generation)
      }
    }
  }

  private async handle(message: NatsRouteMessage): Promise<void> {
    // A raw publish has no reply inbox and can never communicate acceptance.
    // Reject it before parsing or durable mutation rather than accepting into a
    // void and letting the sender confuse publication with delivery.
    if (!message.reply) {
      log.warn('message-router', 'ignored route publication without a reply inbox')
      return
    }

    const parsed = parseRouteRequest(message.data, this.dependencies.authMasterKey)
    let response: MessageRouteResponse
    if (!parsed.ok) {
      response = parsed.response
    } else {
      try {
        response = routeResponse(
          parsed.request,
          await this.dependencies.route(parsed.request),
        )
      } catch (error) {
        response = {
          version: MESSAGE_ROUTE_PROTOCOL_VERSION,
          status: 'error',
          requestId: parsed.request.requestId,
          error: {
            code: 'router-failed',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
      if (response.status !== 'error') {
        try {
          this.dependencies.observeAccepted?.(parsed.request, response)
        } catch (error) {
          // Observability is downstream of durable acceptance. Never replace an
          // acceptance receipt with a monitoring failure.
          log.warn('message-router', `acceptance observation failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    try {
      const envelope: AuthenticatedMessageRoute<MessageRouteResponse> = parsed.authKey
        ? signMessageRoutePayload(response, parsed.authKey)
        : { payload: response, auth: '' }
      if (!message.respond(textEncoder.encode(JSON.stringify(envelope)))) {
        log.warn('message-router', `reply inbox rejected response for ${response.requestId ?? 'unknown request'}`)
      }
    } catch (error) {
      // The ledger may already contain the acceptance. A retry with the same
      // request ID replays it, so this failed final response is safe and visible
      // to the caller as a timeout rather than a false success.
      log.warn('message-router', `failed to respond: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (parsed.ok && response.status !== 'error' && this.dependencies.dispatchAccepted) {
      try {
        await this.dependencies.dispatchAccepted(parsed.request, response)
      } catch (error) {
        // Durable acceptance has already been returned. The provider attempt
        // owns its ledger state; transport failures must never become a false
        // router rejection or disappear as a silent publication success.
        log.warn('message-router', `final-mile dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private scheduleReconnect(generation: number): void {
    if (!this.isCurrentGeneration(generation) || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connectOnce(generation)
    }, this.reconnectDelayMs)
    this.reconnectTimer.unref?.()
  }

  async stop(): Promise<void> {
    this.running = false
    ++this.generation
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const subscription = this.subscription
    this.subscription = null
    const connection = this.connection
    this.connection = null
    subscription?.unsubscribe()
    await Promise.allSettled([...this.inFlight])
    if (connection) {
      try {
        await connection.drain()
      } catch (error) {
        log.warn('message-router', `failed to drain stopped responder: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
