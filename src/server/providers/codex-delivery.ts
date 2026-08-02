import { createHash } from 'node:crypto'
import type {
  ProviderCapabilities,
  ProviderObservationKind,
  ProviderObservationRequestFor,
  ProviderObservationSnapshotFor,
} from '../../domain/provider-capabilities'
import { scanCodexUserMessages } from '../sessions/codex-transcript'
import {
  defineProviderAdapter,
  type AcceptedProviderDeliveryIdentity,
  type ProviderAdapter,
  type ProviderDeliveryAcceptance,
  type ProviderDeliveryConfirmation,
  type ProviderDeliveryResultIdentity,
  type ProviderDeliveryRequest,
} from './contract'

export const CODEX_MESSAGE_ENVELOPE_MARKER = 'TINSTAR_MESSAGE_ENVELOPE_V1'
const CODEX_PROVIDER_ID = 'codex'
const CODEX_TRANSCRIPT_DISCOVERY_TTL_MS = 5_000
const MAX_CODEX_TRANSCRIPT_PATHS = 1_024
const MAX_CODEX_CONFIRMATION_CURSORS = 4_096
const ROLLOUT_EVIDENCE = {
  id: 'codex-rollout-user-message',
  label: 'Codex rollout user message',
} as const

export interface CodexMessageEnvelope {
  schema: 'tinstar.message.v1'
  message_id: string
  delivery_id: string
  attempt: number
  accepted_at: string
  sender: {
    session_id: string
    incarnation: string
  }
  destination: {
    subject: string
  }
  recipient: {
    provider_id: string
    session_id: string
    incarnation: string
  }
  text: string
}

export interface CodexSessionInput {
  captureScreen(scrollback?: number): Promise<string>
  submitPrompt(prompt: string, beforeEnter: () => Promise<boolean>): Promise<boolean>
}

export interface CodexDeliveryDependencies {
  now?: () => string
  withSessionInput: <T>(
    sessionId: string,
    operation: (input: CodexSessionInput) => Promise<T>,
  ) => Promise<T>
  currentIncarnation: (sessionId: string) => Promise<string | null>
  resolveTranscript: (sessionId: string) => Promise<string | null>
}

interface QueuedAttempt {
  key: string
  deliveryKey: string
  request: ProviderDeliveryRequest
  prompt: string
}

interface TranscriptPathCache {
  path: string
  verified: boolean
  refreshAfter: number
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
    delivery_id: request.deliveryId,
    attempt: request.attempt,
    accepted_at: request.acceptedAt,
    sender: {
      session_id: request.sender.sessionId,
      incarnation: request.sender.incarnation,
    },
    destination: { subject: request.destination.subject },
    recipient: {
      provider_id: request.recipient.providerId,
      session_id: request.recipient.sessionId,
      incarnation: request.recipient.incarnation,
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
      || typeof value.delivery_id !== 'string'
      || !Number.isSafeInteger(value.attempt)
      || typeof value.accepted_at !== 'string'
      || value.sender === null
      || typeof value.sender !== 'object'
      || typeof value.sender.session_id !== 'string'
      || typeof value.sender.incarnation !== 'string'
      || value.destination === null
      || typeof value.destination !== 'object'
      || typeof value.destination.subject !== 'string'
      || typeof value.text !== 'string'
      || value.recipient === null
      || typeof value.recipient !== 'object'
      || typeof value.recipient.provider_id !== 'string'
      || typeof value.recipient.session_id !== 'string'
      || typeof value.recipient.incarnation !== 'string'
    ) return null
    return value as CodexMessageEnvelope
  } catch {
    return null
  }
}

function attemptKey(request: {
  messageId: string
  attempt: number
  recipient: { sessionId: string; incarnation?: string }
}): string {
  return `${request.recipient.sessionId}\u0000${request.recipient.incarnation ?? ''}`
    + `\u0000${request.messageId}\u0000${request.attempt}`
}

function logicalDeliveryKey(
  request: Pick<ProviderDeliveryRequest, 'messageId' | 'deliveryId' | 'recipient'>,
): string {
  return `${request.recipient.sessionId}\u0000${request.recipient.incarnation ?? ''}`
    + `\u0000${request.messageId}\u0000${request.deliveryId}`
}

function recipientIncarnationKey(
  recipient: { sessionId: string; incarnation?: string },
): string {
  return `${recipient.sessionId}\u0000${recipient.incarnation ?? ''}`
}

function attemptRef(prompt: string): string {
  const digest = createHash('sha256').update(prompt, 'utf8').digest('hex')
  return `tinstar-message-v1:sha256:${digest}`
}

function resultIdentity(
  request: Pick<ProviderDeliveryResultIdentity, 'messageId' | 'attempt' | 'recipient'>,
) {
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
  private readonly transcriptPaths = new Map<string, TranscriptPathCache>()
  private readonly confirmationOffsets = new Map<string, {
    path: string
    identity: string
    offset: number
  }>()
  private readonly now: () => string

  constructor(private readonly deps: CodexDeliveryDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  queueDepth(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0
  }

  accept = (request: ProviderDeliveryRequest): Promise<ProviderDeliveryAcceptance> => {
    return this.serialize(request.recipient.sessionId, () => this.acceptSerial(request))
  }

  abandon = (request: ProviderDeliveryRequest): Promise<void> => {
    return this.serialize(request.recipient.sessionId, async () => {
      const queue = this.queues.get(request.recipient.sessionId)
      if (!queue) return
      const index = queue.findIndex(item => (
        item.deliveryKey === logicalDeliveryKey(request)
      ))
      if (index >= 0) queue.splice(index, 1)
      if (queue.length === 0) this.queues.delete(request.recipient.sessionId)
    })
  }

  private async acceptSerial(request: ProviderDeliveryRequest): Promise<ProviderDeliveryAcceptance> {
    const identity = resultIdentity(request)
    const key = attemptKey(request)
    const deliveryKey = logicalDeliveryKey(request)
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
      const retryIndex = queue.findIndex(item => item.deliveryKey === deliveryKey)
      if (retryIndex >= 0) {
        const prior = queue[retryIndex]!
        if (request.attempt <= prior.request.attempt) {
          return {
            ...identity,
            state: 'rejected',
            checkedAt: this.now(),
            reason: 'Codex delivery retry did not advance the durable attempt number',
            retryable: false,
          }
        }
        // A safe retry is the same logical FIFO item with a new stamped
        // attempt. Replace it in place so N+1 cannot queue behind stale N.
        queue[retryIndex] = { key, deliveryKey, request, prompt }
      } else {
        queue.push({ key, deliveryKey, request, prompt })
      }
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

    try {
      return await this.deps.withSessionInput(
        request.recipient.sessionId,
        input => this.deliverQueuedHead(input, request, queue, identity),
      )
    } catch (error) {
      return {
        ...identity,
        state: 'deferred',
        checkedAt: this.now(),
        reason: `Codex terminal input could not be inspected: ${(error as Error).message}`,
      }
    }
  }

  private async deliverQueuedHead(
    input: CodexSessionInput,
    request: ProviderDeliveryRequest,
    queue: QueuedAttempt[],
    identity: ReturnType<typeof resultIdentity>,
  ): Promise<ProviderDeliveryAcceptance> {
    const prompt = queue[0]!.prompt
    const liveIncarnation = await this.deps.currentIncarnation(request.recipient.sessionId)
    if (liveIncarnation !== request.recipient.incarnation) {
      queue.shift()
      if (queue.length === 0) this.queues.delete(request.recipient.sessionId)
      return {
        ...identity,
        state: 'rejected',
        checkedAt: this.now(),
        reason: 'The accepted Codex recipient process has been replaced or stopped',
        retryable: false,
      }
    }

    const safety = classifyCodexTerminalSafety(await input.captureScreen())
    if (safety.state === 'unsafe') {
      return {
        ...identity,
        state: 'deferred',
        checkedAt: this.now(),
        reason: safety.reason,
      }
    }

    let boundaryFailure: string | null = null
    try {
      const submitted = await input.submitPrompt(prompt, async () => {
        const current = await this.deps.currentIncarnation(request.recipient.sessionId)
        if (current !== request.recipient.incarnation) {
          boundaryFailure = 'The accepted Codex recipient process changed before submission'
          return false
        }
        const boundarySafety = classifyCodexTerminalSafety(await input.captureScreen())
        if (boundarySafety.state === 'unsafe') {
          boundaryFailure = boundarySafety.reason
          return false
        }
        return true
      })
      if (!submitted) {
        return {
          ...identity,
          state: 'deferred',
          checkedAt: this.now(),
          reason: boundaryFailure ?? 'Codex terminal changed before submission',
        }
      }
    } catch (error) {
      // Submission may have partially landed, so this delivery is terminal.
      // Drop its provider-local head so unrelated later messages to the same
      // recipient are not blocked behind work that cannot be retried safely.
      queue.shift()
      if (queue.length === 0) this.queues.delete(request.recipient.sessionId)
      return {
        ...identity,
        state: 'rejected',
        checkedAt: this.now(),
        reason: `Codex prompt submission may have partially failed: ${(error as Error).message}`,
        retryable: false,
      }
    }

    queue.shift()
    if (queue.length === 0) this.queues.delete(request.recipient.sessionId)
    return {
      ...identity,
      state: 'accepted',
      acceptedAt: this.now(),
      attemptRef: attemptRef(prompt),
    }
  }

  confirm = async (
    acceptance: AcceptedProviderDeliveryIdentity,
  ): Promise<ProviderDeliveryConfirmation> => {
    const identity = resultIdentity(acceptance)
    const expectedRef = acceptance.attemptRef
    if (!expectedRef || !/^tinstar-message-v1:sha256:[a-f0-9]{64}$/.test(expectedRef)) {
      return {
        ...identity,
        state: 'failed',
        checkedAt: this.now(),
        reason: 'Codex delivery acceptance has an invalid attempt reference',
        retryable: false,
      }
    }

    const checkedAt = this.now()
    const parsedNow = Date.parse(checkedAt)
    const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now()
    let evidencePendingReason: string | null = null
    const recipientKey = recipientIncarnationKey(acceptance.recipient)
    const cachedTranscript = this.transcriptPaths.get(recipientKey)
    let transcriptPath = cachedTranscript?.path ?? null
    if (!cachedTranscript || (!cachedTranscript.verified && cachedTranscript.refreshAfter <= nowMs)) {
      try {
        const resolved = await this.deps.resolveTranscript(acceptance.recipient.sessionId)
        if (resolved) {
          transcriptPath = resolved
          this.rememberTranscriptPath(recipientKey, {
            path: resolved,
            verified: false,
            refreshAfter: nowMs + CODEX_TRANSCRIPT_DISCOVERY_TTL_MS,
          })
        } else if (cachedTranscript) {
          this.rememberTranscriptPath(recipientKey, {
            ...cachedTranscript,
            refreshAfter: nowMs + CODEX_TRANSCRIPT_DISCOVERY_TTL_MS,
          })
        }
      } catch (error) {
        evidencePendingReason = `Codex rollout could not be resolved: ${(error as Error).message}`
      }
    }
    if (!transcriptPath) {
      evidencePendingReason ??= 'Codex rollout is not available yet'
    }

    const confirmationKey = attemptKey(acceptance)
    const priorScan = this.confirmationOffsets.get(confirmationKey)
    if (transcriptPath) {
      const scan = await scanCodexUserMessages(
        transcriptPath,
        priorScan?.path === transcriptPath ? priorScan.offset : 0,
        (message) => {
          const envelope = parseCodexMessageEnvelope(message)
          return envelope !== null
            && attemptRef(message) === expectedRef
            && envelope.message_id === acceptance.messageId
            && envelope.attempt === acceptance.attempt
            && envelope.recipient.provider_id === acceptance.recipient.providerId
            && envelope.recipient.session_id === acceptance.recipient.sessionId
            && envelope.recipient.incarnation === acceptance.recipient.incarnation
        },
        priorScan?.path === transcriptPath ? priorScan.identity : undefined,
      )
      if (!scan.available) {
        this.transcriptPaths.delete(recipientKey)
        this.confirmationOffsets.delete(confirmationKey)
        evidencePendingReason = 'Codex rollout is not available yet'
      } else {
        if (scan.identity) {
          this.rememberConfirmationOffset(confirmationKey, {
            path: transcriptPath,
            identity: scan.identity,
            offset: scan.nextOffset,
          })
        }
        if (scan.evidence) {
          // Discovery can fall back to the newest same-workdir rollout when several
          // sessions share a worktree. Bind the path to this incarnation only after
          // exact envelope evidence proves it belongs to the accepted delivery.
          this.rememberTranscriptPath(recipientKey, {
            path: transcriptPath,
            verified: true,
            refreshAfter: Number.POSITIVE_INFINITY,
          })
          this.confirmationOffsets.delete(confirmationKey)
          return {
            ...identity,
            state: 'confirmed',
            confirmedAt: scan.evidence.timestamp ?? this.now(),
            evidence: {
              source: ROLLOUT_EVIDENCE,
              reference: expectedRef,
            },
          }
        }
        evidencePendingReason = 'Codex rollout has not recorded this message as user input'
      }
    }

    // Exact durable provider evidence wins if the recipient exits or is
    // replaced after accepting input but before the scheduled confirmation.
    try {
      const liveIncarnation = await this.deps.currentIncarnation(acceptance.recipient.sessionId)
      if (liveIncarnation !== acceptance.recipient.incarnation) {
        this.transcriptPaths.delete(recipientKey)
        this.confirmationOffsets.delete(confirmationKey)
        return {
          ...identity,
          state: 'failed',
          checkedAt: this.now(),
          reason: 'The accepted Codex recipient process has been replaced or stopped',
          retryable: false,
        }
      }
    } catch (error) {
      return {
        ...identity,
        state: 'pending',
        checkedAt: this.now(),
        reason: `Codex recipient liveness could not be inspected: ${(error as Error).message}`,
      }
    }
    return {
      ...identity,
      state: 'pending',
      checkedAt: this.now(),
      reason: evidencePendingReason ?? 'Codex rollout is not available yet',
    }
  }

  private rememberTranscriptPath(key: string, value: TranscriptPathCache): void {
    this.transcriptPaths.delete(key)
    this.transcriptPaths.set(key, value)
    while (this.transcriptPaths.size > MAX_CODEX_TRANSCRIPT_PATHS) {
      const oldest = this.transcriptPaths.keys().next().value
      if (oldest === undefined) break
      this.transcriptPaths.delete(oldest)
    }
  }

  private rememberConfirmationOffset(
    key: string,
    value: { path: string; identity: string; offset: number },
  ): void {
    this.confirmationOffsets.delete(key)
    this.confirmationOffsets.set(key, value)
    while (this.confirmationOffsets.size > MAX_CODEX_CONFIRMATION_CURSORS) {
      const oldest = this.confirmationOffsets.keys().next().value
      if (oldest === undefined) break
      this.confirmationOffsets.delete(oldest)
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

export function createCodexDeliveryAdapter(
  deps: CodexDeliveryDependencies,
): CodexDeliveryAdapter {
  return new CodexDeliveryAdapter(deps)
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
