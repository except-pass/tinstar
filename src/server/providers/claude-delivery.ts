import { createHmac } from 'node:crypto'
import { createConnection } from 'node:net'
import type {
  ProviderDeliveryAcceptance,
  ProviderDeliveryAdapter,
  ProviderDeliveryRequest,
} from './contract'
import { natsControlSocketPath } from '../sessions/nats-control'

export const CLAUDE_CHANNEL_DELIVERY_VERSION = 1 as const
const DEFAULT_TIMEOUT_MS = 5_000

export interface ClaudeChannelDeliveryPayload extends ProviderDeliveryRequest {
  version: typeof CLAUDE_CHANNEL_DELIVERY_VERSION
}

export interface AuthenticatedClaudeChannelDelivery {
  payload: ClaudeChannelDeliveryPayload
  auth: string
}

export interface ClaudeChannelDeliveryCommand {
  action: 'deliver'
  envelope: AuthenticatedClaudeChannelDelivery
}

export type ClaudeChannelDeliveryResponse =
  | {
      version: typeof CLAUDE_CHANNEL_DELIVERY_VERSION
      status: 'accepted'
      messageId: string
      deliveryId: string
      attempt: number
      recipient: { providerId: string; sessionId: string; incarnation: string }
      acceptedAt: string
    }
  | {
      version: typeof CLAUDE_CHANNEL_DELIVERY_VERSION
      status: 'rejected'
      messageId: string
      deliveryId: string
      attempt: number
      recipient: { providerId: string; sessionId: string; incarnation: string }
      checkedAt: string
      reason: string
      retryable: boolean
    }

export class ClaudeChannelControlError extends Error {
  readonly name = 'ClaudeChannelControlError'
  constructor(
    readonly code: 'unavailable' | 'timeout' | 'invalid-response',
    message: string,
    readonly commandMayHaveArrived: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

function authenticator(payload: unknown, key: Uint8Array): string {
  return createHmac('sha256', key).update(JSON.stringify(payload), 'utf8').digest('hex')
}

export function authenticatedClaudeChannelDelivery(
  request: ProviderDeliveryRequest,
  authKey: Uint8Array,
): AuthenticatedClaudeChannelDelivery {
  const payload: ClaudeChannelDeliveryPayload = {
    version: CLAUDE_CHANNEL_DELIVERY_VERSION,
    ...structuredClone(request),
  }
  return { payload, auth: authenticator(payload, authKey) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchingResponse(
  value: unknown,
  request: ProviderDeliveryRequest,
): value is ClaudeChannelDeliveryResponse {
  if (!isRecord(value)
    || value.version !== CLAUDE_CHANNEL_DELIVERY_VERSION
    || (value.status !== 'accepted' && value.status !== 'rejected')
    || value.messageId !== request.messageId
    || value.deliveryId !== request.deliveryId
    || value.attempt !== request.attempt
    || !isRecord(value.recipient)
    || value.recipient.providerId !== request.recipient.providerId
    || value.recipient.sessionId !== request.recipient.sessionId
    || value.recipient.incarnation !== request.recipient.incarnation) return false
  return value.status === 'accepted'
    ? typeof value.acceptedAt === 'string'
    : typeof value.checkedAt === 'string'
      && typeof value.reason === 'string'
      && typeof value.retryable === 'boolean'
}

export function requestClaudeChannelDelivery(
  socketPath: string,
  command: ClaudeChannelDeliveryCommand,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ClaudeChannelDeliveryResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let sent = false
    let settled = false
    let buffer = ''
    const finish = (error?: Error, response?: ClaudeChannelDeliveryResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(response!)
    }
    const timer = setTimeout(() => finish(new ClaudeChannelControlError(
      'timeout',
      `Claude channel control socket did not acknowledge within ${timeoutMs}ms`,
      sent,
    )), timeoutMs)
    socket.once('connect', () => {
      sent = true
      socket.write(`${JSON.stringify(command)}\n`)
    })
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      let parsed: unknown
      try { parsed = JSON.parse(buffer.slice(0, newline)) } catch {
        finish(new ClaudeChannelControlError(
          'invalid-response', 'Claude channel returned invalid JSON', true,
        ))
        return
      }
      if (!matchingResponse(parsed, command.envelope.payload)) {
        finish(new ClaudeChannelControlError(
          'invalid-response', 'Claude channel returned a mismatched delivery receipt', true,
        ))
        return
      }
      finish(undefined, parsed)
    })
    socket.once('error', error => finish(new ClaudeChannelControlError(
      sent ? 'invalid-response' : 'unavailable',
      `Claude channel control socket failed: ${error.message}`,
      sent,
      { cause: error },
    )))
  })
}

export interface ClaudeDeliveryDependencies {
  authKeyFor: (request: ProviderDeliveryRequest) => Uint8Array
  socketPathFor?: (sessionId: string) => string
  deliver?: (
    socketPath: string,
    command: ClaudeChannelDeliveryCommand,
  ) => Promise<ClaudeChannelDeliveryResponse>
  now?: () => string
}

export function createClaudeDeliveryAdapter(
  dependencies: ClaudeDeliveryDependencies,
): ProviderDeliveryAdapter {
  const socketPathFor = dependencies.socketPathFor ?? natsControlSocketPath
  const deliver = dependencies.deliver ?? requestClaudeChannelDelivery
  const now = dependencies.now ?? (() => new Date().toISOString())
  return {
    async accept(request): Promise<ProviderDeliveryAcceptance> {
      let response: ClaudeChannelDeliveryResponse
      try {
        response = await deliver(
          socketPathFor(request.recipient.sessionId),
          {
            action: 'deliver',
            envelope: authenticatedClaudeChannelDelivery(
              request,
              dependencies.authKeyFor(request),
            ),
          },
        )
      } catch (error) {
        if (error instanceof ClaudeChannelControlError && !error.commandMayHaveArrived) {
          return {
            state: 'rejected',
            providerId: 'claude',
            messageId: request.messageId,
            attempt: request.attempt,
            recipient: request.recipient,
            checkedAt: now(),
            reason: error.message,
            retryable: true,
          }
        }
        throw error
      }
      if (response.status === 'rejected') {
        return {
          state: 'rejected',
          providerId: 'claude',
          messageId: response.messageId,
          attempt: response.attempt,
          recipient: request.recipient,
          checkedAt: response.checkedAt,
          reason: response.reason,
          retryable: response.retryable,
        }
      }
      return {
        state: 'accepted',
        providerId: 'claude',
        messageId: request.messageId,
        attempt: request.attempt,
        recipient: request.recipient,
        acceptedAt: response.acceptedAt,
        attemptRef: request.deliveryId,
      }
    },
  }
}
