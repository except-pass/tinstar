import type {
  ProviderCapabilities,
  ProviderObservationKind,
  ProviderObservationRequestFor,
  ProviderObservationSnapshotFor,
} from '../../domain/provider-capabilities'
import { findCodexUserMessage } from '../sessions/codex-transcript'
import {
  defineProviderAdapter,
  type AcceptedProviderDeliveryIdentity,
  type ProviderAdapter,
  type ProviderDeliveryAcceptance,
  type ProviderDeliveryConfirmation,
  type ProviderDeliveryRequest,
} from './contract'

export const CODEX_MESSAGE_ENVELOPE_MARKER = 'TINSTAR_MESSAGE_ENVELOPE_V1'
const CODEX_PROVIDER_ID = 'codex'
const ROLLOUT_EVIDENCE = {
  id: 'codex-rollout-user-message',
  label: 'Codex rollout user message',
} as const

export interface CodexMessageEnvelope {
  schema: 'tinstar.message.v1'
  message_id: string
  attempt: number
  accepted_at: string
  sender_session_id: string
  recipient: {
    provider_id: string
    session_id: string
    incarnation?: string
  }
  text: string
}

export interface CodexDeliveryDependencies {
  now?: () => string
  captureScreen: (sessionId: string) => Promise<string>
  sendPrompt: (sessionId: string, prompt: string) => Promise<void>
  resolveTranscript: (sessionId: string) => Promise<string | null>
}

interface QueuedAttempt {
  key: string
  request: ProviderDeliveryRequest
  prompt: string
}

export type CodexTerminalSafety =
  | { state: 'safe' }
  | { state: 'unsafe'; reason: string }

const UNSAFE_MODAL_PATTERNS: readonly [RegExp, string][] = [
  [/press enter to (?:confirm|submit|continue)/i, 'Codex is waiting for a modal confirmation'],
  [/(?:esc|escape) to (?:cancel|go back)/i, 'Codex is waiting for a modal decision'],
  [/would you like to (?:run|allow|approve)/i, 'Codex is waiting for permission'],
  [/(?:select|choose) an option/i, 'Codex is waiting for a selection'],
  [/use (?:the )?(?:up and down )?arrow keys/i, 'Codex is waiting for a selection'],
  [/pasted text|paste (?:preview|confirmation)/i, 'Codex is showing a paste modal'],
]

const COMPOSER_SHORTCUT_HINT = /^\s*\?\s+for shortcuts(?:\s|$)/i

/** Only a visible Codex composer is safe; unknown screens fail closed. */
export function classifyCodexTerminalSafety(screen: string): CodexTerminalSafety {
  const plain = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  for (const [pattern, reason] of UNSAFE_MODAL_PATTERNS) {
    if (pattern.test(plain)) return { state: 'unsafe', reason }
  }
  const tail = plain.split('\n').slice(-10)
  // `›` is not enough: Codex uses the same glyph for the selected row in
  // approval, model, and other picker overlays. The normal composer has a
  // stable adjacent `? for shortcuts` footer; modal pickers replace that footer
  // with their own Enter/Esc instructions. Require both pieces as one positive
  // signature so an unfamiliar screen remains fail-closed.
  const hasComposer = tail.some((line, index) => (
    /^\s*›(?:\s|$)/u.test(line)
    && COMPOSER_SHORTCUT_HINT.test(tail[index + 1] ?? '')
  ))
  if (hasComposer) return { state: 'safe' }
  return { state: 'unsafe', reason: 'Codex composer is not visible' }
}

export function renderCodexMessageEnvelope(request: ProviderDeliveryRequest): string {
  const envelope: CodexMessageEnvelope = {
    schema: 'tinstar.message.v1',
    message_id: request.messageId,
    attempt: request.attempt,
    accepted_at: request.acceptedAt,
    sender_session_id: request.senderSessionId,
    recipient: {
      provider_id: request.recipient.providerId,
      session_id: request.recipient.sessionId,
      ...(request.recipient.incarnation !== undefined
        ? { incarnation: request.recipient.incarnation }
        : {}),
    },
    text: request.text,
  }
  return `${CODEX_MESSAGE_ENVELOPE_MARKER}\n${JSON.stringify(envelope)}`
}

export function parseCodexMessageEnvelope(message: string): CodexMessageEnvelope | null {
  const prefix = `${CODEX_MESSAGE_ENVELOPE_MARKER}\n`
  if (!message.startsWith(prefix)) return null
  try {
    const value = JSON.parse(message.slice(prefix.length)) as Partial<CodexMessageEnvelope>
    if (
      value.schema !== 'tinstar.message.v1'
      || typeof value.message_id !== 'string'
      || !Number.isSafeInteger(value.attempt)
      || typeof value.accepted_at !== 'string'
      || typeof value.sender_session_id !== 'string'
      || typeof value.text !== 'string'
      || value.recipient === null
      || typeof value.recipient !== 'object'
      || typeof value.recipient.provider_id !== 'string'
      || typeof value.recipient.session_id !== 'string'
      || (value.recipient.incarnation !== undefined
        && typeof value.recipient.incarnation !== 'string')
    ) return null
    return value as CodexMessageEnvelope
  } catch {
    return null
  }
}

function attemptKey(request: Pick<ProviderDeliveryRequest, 'messageId' | 'attempt' | 'recipient'>): string {
  return `${request.recipient.sessionId}\u0000${request.recipient.incarnation ?? ''}`
    + `\u0000${request.messageId}\u0000${request.attempt}`
}

function attemptRef(messageId: string, attempt: number): string {
  return `tinstar-message-v1:${messageId}:${attempt}`
}

function resultIdentity(request: Pick<ProviderDeliveryRequest, 'messageId' | 'attempt' | 'recipient'>) {
  return {
    providerId: CODEX_PROVIDER_ID,
    messageId: request.messageId,
    attempt: request.attempt,
    recipient: request.recipient,
  }
}

/**
 * Codex final-mile delivery. The queue is intentionally process-local: the
 * durable router ledger remains authoritative across restarts and replays an
 * unconfirmed attempt. This queue only prevents keystrokes entering a live TUI
 * modal and preserves FIFO between retries in the current process.
 */
export class CodexDeliveryAdapter {
  private readonly queues = new Map<string, QueuedAttempt[]>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly now: () => string

  constructor(private readonly deps: CodexDeliveryDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  queueDepth(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0
  }

  accept(request: ProviderDeliveryRequest): Promise<ProviderDeliveryAcceptance> {
    return this.serialize(request.recipient.sessionId, () => this.acceptSerial(request))
  }

  private async acceptSerial(request: ProviderDeliveryRequest): Promise<ProviderDeliveryAcceptance> {
    const identity = resultIdentity(request)
    const key = attemptKey(request)
    const prompt = renderCodexMessageEnvelope(request)
    let queue = this.queues.get(request.recipient.sessionId) ?? []
    const queuedIncarnation = queue[0]?.request.recipient.incarnation
    if (
      request.recipient.incarnation !== undefined
      && queue.length > 0
      && queuedIncarnation !== request.recipient.incarnation
    ) {
      // The lifecycle/dispatcher boundary only submits a currently live
      // incarnation. A reusable session name therefore identifies a replacement
      // process here, and any deferred input for its predecessor is no longer a
      // deliverable FIFO head ("queues are for the living").
      this.queues.delete(request.recipient.sessionId)
      queue = []
    }
    const queued = queue.find(item => item.key === key)
    if (queued && queued.prompt !== prompt) {
      return {
        ...identity,
        state: 'rejected',
        checkedAt: this.now(),
        reason: 'The same Codex delivery attempt was retried with a different envelope',
        retryable: false,
      }
    }
    if (!queued) {
      queue.push({ key, request, prompt })
      this.queues.set(request.recipient.sessionId, queue)
    }

    if (queue[0]?.key !== key) {
      return {
        ...identity,
        state: 'deferred',
        checkedAt: this.now(),
        reason: 'An earlier Codex message is queued for this recipient',
      }
    }

    let safety: CodexTerminalSafety
    try {
      safety = classifyCodexTerminalSafety(
        await this.deps.captureScreen(request.recipient.sessionId),
      )
    } catch (error) {
      return {
        ...identity,
        state: 'deferred',
        checkedAt: this.now(),
        reason: `Codex terminal state could not be inspected: ${(error as Error).message}`,
      }
    }
    if (safety.state === 'unsafe') {
      return {
        ...identity,
        state: 'deferred',
        checkedAt: this.now(),
        reason: safety.reason,
      }
    }

    try {
      await this.deps.sendPrompt(request.recipient.sessionId, queue[0]!.prompt)
    } catch (error) {
      // A rejected attempt has reached a terminal outcome for this invocation.
      // The durable router may retry it as a new attempt, but retaining this
      // failed head would make that retry wait behind an item that can never
      // be accepted and poison the recipient's FIFO queue.
      queue.shift()
      if (queue.length === 0) this.queues.delete(request.recipient.sessionId)
      return {
        ...identity,
        state: 'rejected',
        checkedAt: this.now(),
        reason: `Codex prompt injection failed: ${(error as Error).message}`,
        retryable: true,
      }
    }

    queue.shift()
    if (queue.length === 0) this.queues.delete(request.recipient.sessionId)
    return {
      ...identity,
      state: 'accepted',
      acceptedAt: this.now(),
      attemptRef: attemptRef(request.messageId, request.attempt),
    }
  }

  async confirm(
    acceptance: AcceptedProviderDeliveryIdentity,
  ): Promise<ProviderDeliveryConfirmation> {
    const identity = resultIdentity(acceptance)
    const expectedRef = attemptRef(acceptance.messageId, acceptance.attempt)
    if (acceptance.attemptRef !== expectedRef) {
      return {
        ...identity,
        state: 'failed',
        checkedAt: this.now(),
        reason: 'Codex delivery acceptance has an invalid attempt reference',
        retryable: false,
      }
    }

    let transcriptPath: string | null
    try {
      transcriptPath = await this.deps.resolveTranscript(acceptance.recipient.sessionId)
    } catch (error) {
      return {
        ...identity,
        state: 'pending',
        checkedAt: this.now(),
        reason: `Codex rollout could not be resolved: ${(error as Error).message}`,
      }
    }
    if (!transcriptPath) {
      return {
        ...identity,
        state: 'pending',
        checkedAt: this.now(),
        reason: 'Codex rollout is not available yet',
      }
    }

    const evidence = findCodexUserMessage(transcriptPath, (message) => {
      const envelope = parseCodexMessageEnvelope(message)
      return envelope !== null
        && envelope.message_id === acceptance.messageId
        && envelope.attempt === acceptance.attempt
        && envelope.recipient.provider_id === acceptance.recipient.providerId
        && envelope.recipient.session_id === acceptance.recipient.sessionId
        && envelope.recipient.incarnation === acceptance.recipient.incarnation
    })
    if (!evidence) {
      return {
        ...identity,
        state: 'pending',
        checkedAt: this.now(),
        reason: 'Codex rollout has not recorded this message as user input',
      }
    }
    return {
      ...identity,
      state: 'confirmed',
      confirmedAt: evidence.timestamp ?? this.now(),
      evidence: {
        source: ROLLOUT_EVIDENCE,
        reference: expectedRef,
      },
    }
  }

  private serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.chains.set(sessionId, current)
    void current.finally(() => {
      if (this.chains.get(sessionId) === current) this.chains.delete(sessionId)
    }).catch(() => undefined)
    return current
  }
}

const capabilities = {
  observations: {
    'session-usage': { state: 'unsupported', reason: 'Not implemented by this delivery slice' },
    'session-context': { state: 'unsupported', reason: 'Not implemented by this delivery slice' },
    'provider-quota': { state: 'unsupported', reason: 'Not implemented by this delivery slice' },
    'historical-telemetry': { state: 'unsupported', reason: 'Not implemented by this delivery slice' },
    'context-breakdown': { state: 'unsupported', reason: 'Not implemented by this delivery slice' },
  },
  delivery: {
    acceptance: {
      state: 'supported',
      detail: {
        transports: [{ id: 'tmux-prompt', kind: 'terminal', label: 'Managed terminal prompt' }],
        timing: ['mid-turn', 'next-boundary'],
      },
    },
    confirmation: {
      state: 'supported',
      detail: { evidence: [ROLLOUT_EVIDENCE] },
    },
  },
} as const satisfies ProviderCapabilities

async function unsupportedObservation<K extends ProviderObservationKind>(
  request: ProviderObservationRequestFor<K>,
): Promise<ProviderObservationSnapshotFor<K>> {
  return {
    kind: request.kind,
    providerId: CODEX_PROVIDER_ID,
    scope: request.scope,
    source: null,
    freshness: {
      state: 'unknown',
      observedAt: null,
      checkedAt: new Date().toISOString(),
    },
    availability: {
      state: 'unsupported',
      reason: 'Not implemented by this delivery slice',
    },
  }
}

/** M3 provider-contract wrapper consumed by the router/dispatcher slice. */
export function createCodexProviderAdapter(
  deps: CodexDeliveryDependencies,
): ProviderAdapter {
  const delivery = new CodexDeliveryAdapter(deps)
  return defineProviderAdapter({
    provider: { id: CODEX_PROVIDER_ID, label: 'Codex' },
    sessionLifecycle: 'terminal',
    capabilities,
    observe: {
      'session-usage': unsupportedObservation,
      'session-context': unsupportedObservation,
      'provider-quota': unsupportedObservation,
      'historical-telemetry': unsupportedObservation,
      'context-breakdown': unsupportedObservation,
    },
    delivery,
  })
}
