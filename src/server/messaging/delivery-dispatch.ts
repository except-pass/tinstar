import type { ProviderAdapterRegistry } from '../providers/lifecycle'
import type {
  AcceptedProviderDeliveryIdentity,
  ProviderDeliveryRequest,
} from '../providers/contract'
import type {
  DeliveryEnvelope,
  DeliveryLedger,
  DeliveryRecord,
  DeliveryTransitionInput,
} from './delivery-ledger'
import {
  activeProviderAcceptance,
  deliverySendAttemptCount,
  lastDeliveryEvent,
} from './delivery-ledger'

type DispatchLedger = Pick<DeliveryLedger, 'getMessage' | 'getDelivery' | 'transition'>
type RecoveryLedger = DispatchLedger & Pick<DeliveryLedger, 'listRecoverable'>

/**
 * Bound provider final-mile work for a live-set broadcast. Each worker still
 * claims one delivery through the ledger CAS before invoking provider code.
 */
export const DELIVERY_DISPATCH_CONCURRENCY = 16
export const DELIVERY_RETRY_DELAY_MS = 1_000
export const DELIVERY_RETRY_POLL_MS = 250
/** Preserve the pre-existing bounded confirmation window with exponential spacing. */
export const DELIVERY_CONFIRMATION_MAX_CHECKS = 6
export const DELIVERY_RETRY_MAX_DELAY_MS = 8_000
export const DELIVERY_MAX_ATTEMPTS = 3
/** Roughly thirty minutes with exponential retry capped at eight seconds. */
export const DELIVERY_MAX_DEFERRALS = 228
export const DELIVERY_MAX_ABANDON_FAILURES = 3

export interface DeliveryDispatchOptions {
  now?: () => number
  retryDelayMs?: number
  confirmationMaxChecks?: number
  maxAttempts?: number
  maxDeferrals?: number
  maxAbandonFailures?: number
}

function maxAttemptsFor(options: DeliveryDispatchOptions): number {
  return Math.max(1, options.maxAttempts ?? DELIVERY_MAX_ATTEMPTS)
}

function maxDeferralsFor(options: DeliveryDispatchOptions): number {
  return Math.max(1, options.maxDeferrals ?? DELIVERY_MAX_DEFERRALS)
}

function maxAbandonFailuresFor(options: DeliveryDispatchOptions): number {
  return Math.max(1, options.maxAbandonFailures ?? DELIVERY_MAX_ABANDON_FAILURES)
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

class DeliveryDispatchScheduler {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await operation()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active -= 1
  }
}

const deliveryDispatchScheduler = new DeliveryDispatchScheduler(
  DELIVERY_DISPATCH_CONCURRENCY,
)

export interface DeliveryDispatchOutcome {
  deliveryId: string
  state: 'accepted' | 'pending' | 'delivered' | 'failed' | 'ambiguous' | 'skipped'
  reason?: string
}

async function transition(
  ledger: DispatchLedger,
  input: DeliveryTransitionInput,
): Promise<boolean> {
  return (await ledger.transition(input)).updated
}

function deliveryRequest(
  envelope: DeliveryEnvelope,
  delivery: DeliveryRecord,
): ProviderDeliveryRequest {
  return {
    messageId: envelope.message.id,
    deliveryId: delivery.id,
    attempt: delivery.attempt,
    acceptedAt: envelope.message.acceptedAt,
    sender: { ...envelope.message.sender },
    destination: { ...envelope.message.destination },
    recipient: { ...delivery.recipient },
    text: envelope.message.text,
  }
}

async function dispatchOne(
  envelope: DeliveryEnvelope,
  captured: DeliveryRecord,
  ledger: DispatchLedger,
  registry: ProviderAdapterRegistry,
  options: DeliveryDispatchOptions = {},
): Promise<DeliveryDispatchOutcome> {
  // The durable recipient is the obligation: never re-resolve this delivery to
  // a replacement process. Provider adapters must classify a changed
  // incarnation as a terminal recipient-replaced rejection.
  const current = ledger.getDelivery(captured.id)
  const now = options.now?.() ?? Date.now()
  if (!current || !isAttemptDue(current, now)) {
    return { deliveryId: captured.id, state: 'skipped' }
  }
  const priorAcceptance = durableAcceptance(envelope, current)
  const providerRegistered = registry.get(current.recipient.providerId) !== undefined
  const adapter = providerRegistered
    ? registry.deliveryFor(current.recipient.providerId)
    : null
  const completedAttempts = deliverySendAttemptCount(current)
  if (completedAttempts >= maxAttemptsFor(options)) {
    const budgetReason = `Provider delivery attempt budget exhausted after ${countLabel(completedAttempts, 'attempt')}`
    if (adapter?.abandon) {
      try {
        await adapter.abandon(deliveryRequest(envelope, current))
      } catch (error) {
        const cleanupFailures = (current.abandonFailureCount ?? 0) + 1
        const exhausted = cleanupFailures >= maxAbandonFailuresFor(options)
        const reason = `${budgetReason}; provider-local cleanup ${
          exhausted ? 'exhausted' : 'failed'
        } after ${countLabel(cleanupFailures, 'attempt')}: ${
          error instanceof Error ? error.message : String(error)
        }`
        const recorded = await transition(ledger, {
          deliveryId: current.id,
          expected: { state: current.state, attempt: current.attempt },
          abandonFailureCount: cleanupFailures,
          next: {
            state: exhausted ? 'failed' : 'pending',
            attempt: current.attempt,
            reason,
            ...(exhausted
              ? { retryable: false }
              : {
                  retryAt: new Date(
                    now + retryBackoffFor(
                      Math.max(1, providerDeferralCount(current)),
                      options,
                    ),
                  ).toISOString(),
                }),
          },
        })
        return recorded
          ? { deliveryId: current.id, state: exhausted ? 'failed' : 'pending', reason }
          : { deliveryId: current.id, state: 'ambiguous', reason: `could not record: ${reason}` }
      }
    }
    const priorCleanupFailures = current.abandonFailureCount ?? 0
    const reason = priorCleanupFailures > 0
      ? `${budgetReason}; provider-local cleanup completed after ${countLabel(
        priorCleanupFailures + 1,
        'attempt',
      )}`
      : budgetReason
    const recorded = await transition(ledger, {
      deliveryId: current.id,
      expected: { state: current.state, attempt: current.attempt },
      next: { state: 'failed', attempt: current.attempt, reason, retryable: false },
    })
    return recorded
      ? { deliveryId: current.id, state: 'failed', reason }
      : { deliveryId: current.id, state: 'ambiguous', reason: `could not record: ${reason}` }
  }
  const priorAbandonFailures = current.abandonFailureCount ?? 0
  if (priorAbandonFailures > 0) {
    const deferredReason = `Provider acceptance remained deferred after ${countLabel(
      providerDeferralCount(current),
      'deferral',
    )}`
    if (!adapter?.abandon) {
      const reason = `${deferredReason}; provider-local cleanup is no longer available`
      const recorded = await transition(ledger, {
        deliveryId: current.id,
        expected: { state: current.state, attempt: current.attempt },
        next: { state: 'failed', attempt: current.attempt, reason, retryable: false },
      })
      return recorded
        ? { deliveryId: current.id, state: 'failed', reason }
        : { deliveryId: current.id, state: 'ambiguous', reason: `could not record: ${reason}` }
    }
    try {
      await adapter.abandon(deliveryRequest(envelope, current))
    } catch (error) {
      const cleanupFailures = priorAbandonFailures + 1
      const exhausted = cleanupFailures >= maxAbandonFailuresFor(options)
      const reason = `${
        exhausted ? 'Provider deferral cleanup exhausted' : 'Provider deferral cleanup failed'
      } after ${countLabel(cleanupFailures, 'attempt')}: ${
        error instanceof Error ? error.message : String(error)
      }`
      const recorded = await transition(ledger, {
        deliveryId: current.id,
        expected: { state: current.state, attempt: current.attempt },
        abandonFailureCount: cleanupFailures,
        next: {
          state: exhausted ? 'failed' : 'pending',
          attempt: current.attempt,
          reason,
          ...(exhausted
            ? { retryable: false }
            : {
                retryAt: new Date(
                  now + retryBackoffFor(providerDeferralCount(current), options),
                ).toISOString(),
              }),
        },
      })
      return recorded
        ? { deliveryId: current.id, state: exhausted ? 'failed' : 'pending', reason }
        : { deliveryId: current.id, state: 'ambiguous', reason: `could not record: ${reason}` }
    }
    const cleanupAttempts = priorAbandonFailures + 1
    const reason = `${deferredReason}; provider-local cleanup completed after ${countLabel(
      cleanupAttempts,
      'attempt',
    )}`
    const recorded = await transition(ledger, {
      deliveryId: current.id,
      expected: { state: current.state, attempt: current.attempt },
      next: { state: 'failed', attempt: current.attempt, reason, retryable: false },
    })
    return recorded
      ? { deliveryId: current.id, state: 'failed', reason }
      : { deliveryId: current.id, state: 'ambiguous', reason: `could not record: ${reason}` }
  }
  const attempt = current.attempt + 1
  const claimed = await transition(ledger, {
    deliveryId: current.id,
    expected: { state: current.state, attempt: current.attempt },
    next: { state: 'in-flight', attempt },
  })
  if (!claimed) return { deliveryId: current.id, state: 'skipped' }

  if (!adapter) {
    const unavailable = providerRegistered
      ? `Provider "${current.recipient.providerId}" has no delivery adapter`
      : `Provider "${current.recipient.providerId}" is no longer registered`
    const reason = priorAcceptance
      ? `${unavailable}; attempt ${priorAcceptance.attempt} may already have been delivered but can no longer be confirmed`
      : unavailable
    const recorded = await transition(ledger, {
      deliveryId: current.id,
      expected: { state: 'in-flight', attempt },
      next: { state: 'failed', attempt, reason, retryable: false },
    })
    return recorded
      ? { deliveryId: current.id, state: priorAcceptance ? 'ambiguous' : 'failed', reason }
      : { deliveryId: current.id, state: 'ambiguous', reason: `could not record: ${reason}` }
  }

  const request = deliveryRequest(envelope, {
    ...current,
    attempt,
  })
  try {
    const result = await adapter.accept(request)
    if (result.state === 'delivered') {
      const recorded = await transition(ledger, {
        deliveryId: current.id,
        expected: { state: 'in-flight', attempt },
        countsAsSendAttempt: true,
        resetDeferralCount: true,
        resetAbandonFailureCount: true,
        next: {
          state: 'delivered',
          attempt,
          evidence: result.evidence,
        },
      })
      return recorded
        ? { deliveryId: current.id, state: 'delivered' }
        : {
            deliveryId: current.id,
            state: 'ambiguous',
            reason: 'provider proved delivery but the ledger transition failed',
          }
    }
    if (result.state === 'accepted') {
      const providerAcceptedAt = canonicalTimestamp(result.acceptedAt, now)
      const recorded = await transition(ledger, {
        deliveryId: current.id,
        expected: { state: 'in-flight', attempt },
        countsAsSendAttempt: true,
        resetDeferralCount: true,
        resetAbandonFailureCount: true,
        next: {
          state: 'accepted',
          attempt,
          providerAcceptedAt,
          ...(result.attemptRef ? { attemptRef: result.attemptRef } : {}),
          retryAt: retryAtFor(
            providerAcceptedAt,
            undefined,
            options.retryDelayMs,
            now,
          ),
        },
      })
      return recorded
        ? { deliveryId: current.id, state: 'accepted' }
        : {
            deliveryId: current.id,
            state: 'ambiguous',
            reason: 'provider accepted the attempt but the ledger transition failed',
          }
    }
    if (result.state === 'deferred') {
      const deferralCount = providerDeferralCount(current) + 1
      const exhausted = deferralCount >= maxDeferralsFor(options)
      const reason = exhausted
        ? `Provider acceptance remained deferred after ${countLabel(deferralCount, 'deferral')}: ${result.reason}`
        : result.reason
      if (exhausted && adapter.abandon) {
        try {
          await adapter.abandon(request)
        } catch (error) {
          const cleanupFailures = (current.abandonFailureCount ?? 0) + 1
          const cleanupExhausted = cleanupFailures >= maxAbandonFailuresFor(options)
          const cleanupReason = `${
            cleanupExhausted ? 'Provider deferral cleanup exhausted' : 'Provider deferral cleanup failed'
          } after ${countLabel(cleanupFailures, 'attempt')}: ${
            error instanceof Error ? error.message : String(error)
          }`
          const recorded = await transition(ledger, {
            deliveryId: current.id,
            expected: { state: 'in-flight', attempt },
            deferralCount,
            abandonFailureCount: cleanupFailures,
            next: {
              state: cleanupExhausted ? 'failed' : 'pending',
              attempt,
              reason: cleanupReason,
              ...(cleanupExhausted
                ? { retryable: false }
                : {
                    retryAt: retryAtFor(
                      result.checkedAt,
                      result.retryAt,
                      retryBackoffFor(deferralCount, options),
                      now,
                    ),
                  }),
            },
          })
          return recorded
            ? {
                deliveryId: current.id,
                state: cleanupExhausted ? 'failed' : 'pending',
                reason: cleanupReason,
              }
            : {
                deliveryId: current.id,
                state: 'ambiguous',
                reason: `could not record ${cleanupReason}`,
              }
        }
      }
      const recorded = await transition(ledger, {
        deliveryId: current.id,
        expected: { state: 'in-flight', attempt },
        deferralCount,
        next: {
          state: exhausted ? 'failed' : 'pending',
          attempt,
          reason,
          ...(exhausted
            ? { retryable: false }
            : {
                retryAt: retryAtFor(
                  result.checkedAt,
                  result.retryAt,
                  retryBackoffFor(deferralCount, options),
                  now,
                ),
              }),
        },
      })
      return recorded
        ? { deliveryId: current.id, state: exhausted ? 'failed' : 'pending', reason }
        : {
            deliveryId: current.id,
            state: 'ambiguous',
            reason: `could not record provider deferral: ${result.reason}`,
          }
    }
    const retryable = result.retryable
      && completedAttempts + 1 < maxAttemptsFor(options)
    const recorded = await transition(ledger, {
      deliveryId: current.id,
      expected: { state: 'in-flight', attempt },
      countsAsSendAttempt: true,
      resetDeferralCount: true,
      resetAbandonFailureCount: true,
      next: {
        state: 'failed',
        attempt,
        reason: result.reason,
        retryable,
        ...(retryable
          ? {
              retryAt: retryAtFor(
                result.checkedAt,
                undefined,
                options.retryDelayMs,
                now,
              ),
            }
          : {}),
      },
    })
    return recorded
      ? { deliveryId: current.id, state: 'failed', reason: result.reason }
      : {
          deliveryId: current.id,
          state: 'ambiguous',
          reason: `could not record provider rejection: ${result.reason}`,
        }
  } catch (error) {
    // Once the adapter was invoked, a missing acknowledgement is ambiguous.
    // Keep the durable record in-flight so recovery can inspect exact provider
    // evidence instead of blindly duplicating a possibly delivered message.
    return {
      deliveryId: current.id,
      state: 'ambiguous',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Aggregate provider deferrals survive history truncation and ledger reopen. */
function providerDeferralCount(delivery: DeliveryRecord): number {
  return delivery.deferralCount ?? 0
}

function isAttemptDue(delivery: DeliveryRecord, now: number): boolean {
  if (delivery.state === 'accepted') return delivery.attempt === 0
  if (delivery.state === 'failed') {
    if (lastDeliveryEvent(delivery).retryable !== true) return false
    const retryAt = lastDeliveryEvent(delivery).retryAt
    return !retryAt || Date.parse(retryAt) <= now
  }
  // Once a provider has durably accepted an attempt, only its read-only
  // confirmation path may advance it. Never turn a later pending confirmation
  // into a duplicate final-mile accept.
  if (activeProviderAcceptance(delivery)) return false
  if (delivery.state !== 'pending') return false
  const retryAt = lastDeliveryEvent(delivery).retryAt
  return !retryAt || Date.parse(retryAt) <= now
}

function isConfirmationDue(delivery: DeliveryRecord, now: number): boolean {
  if (!activeProviderAcceptance(delivery)) return false
  if (delivery.state === 'accepted') {
    const retryAt = lastDeliveryEvent(delivery).retryAt
    return !retryAt || Date.parse(retryAt) <= now
  }
  if (delivery.state === 'in-flight') return true
  if (delivery.state !== 'pending') return false
  const retryAt = lastDeliveryEvent(delivery).retryAt
  return !retryAt || Date.parse(retryAt) <= now
}

function retryAtFor(
  checkedAt: string,
  explicitRetryAt: string | undefined,
  retryDelayMs = DELIVERY_RETRY_DELAY_MS,
  now = Date.now(),
): string {
  if (explicitRetryAt) {
    const explicit = Date.parse(explicitRetryAt)
    if (Number.isFinite(explicit)) return new Date(explicit).toISOString()
  }
  const checkedAtMs = Date.parse(checkedAt)
  const base = Number.isFinite(checkedAtMs) ? Math.max(checkedAtMs, now) : now
  return new Date(base + retryDelayMs).toISOString()
}

function retryBackoffFor(
  retryCount: number,
  options: DeliveryDispatchOptions,
): number {
  const baseDelay = options.retryDelayMs ?? DELIVERY_RETRY_DELAY_MS
  return Math.min(
    baseDelay * (2 ** Math.max(0, retryCount - 1)),
    DELIVERY_RETRY_MAX_DELAY_MS,
  )
}

function canonicalTimestamp(value: string, fallbackMs: number): string {
  const parsed = Date.parse(value)
  const safeFallback = Number.isFinite(fallbackMs) ? fallbackMs : Date.now()
  return new Date(Number.isFinite(parsed) ? parsed : safeFallback).toISOString()
}

function durableAcceptance(
  envelope: DeliveryEnvelope,
  delivery: DeliveryRecord,
): AcceptedProviderDeliveryIdentity | null {
  const accepted = activeProviderAcceptance(delivery)
  if (!accepted) return null
  return {
    providerId: delivery.recipient.providerId,
    messageId: envelope.message.id,
    attempt: delivery.attempt,
    recipient: { ...delivery.recipient },
    state: 'accepted',
    acceptedAt: accepted.acceptedAt,
    ...(accepted.attemptRef ? { attemptRef: accepted.attemptRef } : {}),
  }
}

async function confirmOne(
  captured: DeliveryRecord,
  ledger: DispatchLedger,
  registry: ProviderAdapterRegistry,
  options: DeliveryDispatchOptions = {},
  loadedEnvelope?: DeliveryEnvelope,
): Promise<DeliveryDispatchOutcome> {
  const current = ledger.getDelivery(captured.id)
  if (!current || current.attempt < 1 || current.state === 'delivered') {
    return { deliveryId: captured.id, state: 'skipped' }
  }
  const envelope = loadedEnvelope ?? ledger.getMessage(current.messageId)
  if (!envelope) return { deliveryId: current.id, state: 'skipped' }
  const adapter = registry.get(current.recipient.providerId)
    ? registry.deliveryFor(current.recipient.providerId)
    : null
  const acceptance = durableAcceptance(envelope, current)
  if (!adapter?.confirm || !acceptance) {
    return { deliveryId: current.id, state: 'skipped' }
  }

  try {
    const result = await adapter.confirm(acceptance)
    if (result.state === 'confirmed') {
      const recorded = await transition(ledger, {
        deliveryId: current.id,
        expected: { state: current.state, attempt: current.attempt },
        next: {
          state: 'delivered',
          attempt: current.attempt,
          evidence: result.evidence,
        },
      })
      return recorded
        ? { deliveryId: current.id, state: 'delivered' }
        : { deliveryId: current.id, state: 'ambiguous', reason: 'could not record delivery evidence' }
    }
    if (result.state === 'pending') {
      return recordPendingConfirmation(
        current,
        ledger,
        result.reason,
        result.checkedAt,
        result.retryAt,
        options,
      )
    }
    const retryable = result.retryable
      && deliverySendAttemptCount(current) < maxAttemptsFor(options)
    const recorded = await transition(ledger, {
      deliveryId: current.id,
      expected: { state: current.state, attempt: current.attempt },
      clearProviderAcceptance: true,
      next: {
        state: 'failed',
        attempt: current.attempt,
        reason: result.reason,
        retryable,
        ...(retryable
          ? {
              retryAt: retryAtFor(
                result.checkedAt,
                undefined,
                options.retryDelayMs,
                options.now?.() ?? Date.now(),
              ),
            }
          : {}),
      },
    })
    return recorded
      ? { deliveryId: current.id, state: 'failed', reason: result.reason }
      : { deliveryId: current.id, state: 'ambiguous', reason: 'could not record failed confirmation' }
  } catch (error) {
    const now = options.now?.() ?? Date.now()
    return recordPendingConfirmation(
      current,
      ledger,
      error instanceof Error ? error.message : String(error),
      new Date(now).toISOString(),
      undefined,
      options,
    )
  }
}

function confirmationCheckCount(delivery: DeliveryRecord): number {
  return activeProviderAcceptance(delivery)?.confirmationCount ?? 0
}

async function recordPendingConfirmation(
  current: DeliveryRecord,
  ledger: DispatchLedger,
  reason: string,
  checkedAt: string,
  explicitRetryAt: string | undefined,
  options: DeliveryDispatchOptions,
): Promise<DeliveryDispatchOutcome> {
  const now = options.now?.() ?? Date.now()
  const checkCount = confirmationCheckCount(current) + 1
  const maxChecks = options.confirmationMaxChecks ?? DELIVERY_CONFIRMATION_MAX_CHECKS
  const exhausted = checkCount >= maxChecks
  const completedAttempts = deliverySendAttemptCount(current)
  const attemptBudgetExhausted = completedAttempts >= maxAttemptsFor(options)
  const terminal = exhausted && attemptBudgetExhausted
  const baseDelay = options.retryDelayMs ?? DELIVERY_RETRY_DELAY_MS
  const confirmationDelay = retryBackoffFor(checkCount, options)
  const retryAt = retryAtFor(
    checkedAt,
    explicitRetryAt,
    exhausted ? baseDelay : confirmationDelay,
    now,
  )
  const failureReason = terminal
    ? `Provider delivery could not be confirmed after ${countLabel(completedAttempts, 'attempt')}: ${reason}`
    : `Provider confirmation remained pending after ${checkCount} checks: ${reason}`
  const recorded = await transition(ledger, {
    deliveryId: current.id,
    expected: { state: current.state, attempt: current.attempt },
    countsAsConfirmationCheck: true,
    ...(exhausted ? { clearProviderAcceptance: true as const } : {}),
    next: exhausted
      ? {
          state: 'failed',
          attempt: current.attempt,
          reason: failureReason,
          retryable: !terminal,
          ...(!terminal ? { retryAt } : {}),
        }
      : {
          state: 'pending',
          attempt: current.attempt,
          reason,
          retryAt,
        },
  })
  if (!recorded) {
    return {
      deliveryId: current.id,
      state: 'ambiguous',
      reason: exhausted
        ? 'could not record exhausted provider confirmation'
        : 'could not record pending confirmation',
    }
  }
  return exhausted
    ? {
        deliveryId: current.id,
        state: 'failed',
        reason: failureReason,
      }
    : { deliveryId: current.id, state: 'pending', reason }
}

/**
 * Dispatch each currently due recipient in one message. Production routes
 * through the process-wide retry scheduler for global FIFO; this lower-level
 * entry point remains useful for isolated dispatch and contract tests.
 */
export async function dispatchAcceptedMessage(
  messageId: string,
  ledger: DispatchLedger,
  registry: ProviderAdapterRegistry,
  options: DeliveryDispatchOptions = {},
): Promise<DeliveryDispatchOutcome[]> {
  const envelope = ledger.getMessage(messageId)
  if (!envelope) return []
  return Promise.all(
    envelope.deliveries.map(delivery => deliveryDispatchScheduler.run(() =>
      dispatchOne(envelope, delivery, ledger, registry, options),
    )),
  )
}

/**
 * Resume due obligations and probe durable provider evidence in global
 * acceptance FIFO order. An in-flight call without durable evidence is
 * retried with the same message ID under the bounded at-least-once contract.
 */
export async function recoverAcceptedMessages(
  ledger: RecoveryLedger,
  registry: ProviderAdapterRegistry,
  options: DeliveryDispatchOptions = {},
): Promise<DeliveryDispatchOutcome[]> {
  const now = options.now?.() ?? Date.now()
  const work: Array<() => Promise<DeliveryDispatchOutcome>> = []
  const envelopes = new Map<string, DeliveryEnvelope | undefined>()
  const envelopeFor = (messageId: string): DeliveryEnvelope | undefined => {
    if (!envelopes.has(messageId)) envelopes.set(messageId, ledger.getMessage(messageId))
    return envelopes.get(messageId)
  }
  for (const delivery of ledger.listRecoverable()) {
    const providerRegistered = registry.get(delivery.recipient.providerId) !== undefined
    const adapter = providerRegistered
      ? registry.deliveryFor(delivery.recipient.providerId)
      : null
    if (!adapter) {
      const envelope = envelopeFor(delivery.messageId)
      if (!envelope) continue
      work.push(async () => {
        const current = ledger.getDelivery(delivery.id)
        if (!current || current.state === 'delivered') {
          return { deliveryId: delivery.id, state: 'skipped' }
        }
        const accepted = durableAcceptance(envelope, current)
        const inFlightAttempt = current.state === 'in-flight' && current.attempt > 0
          ? current.attempt
          : null
        const unavailable = providerRegistered
          ? `Provider "${current.recipient.providerId}" has no delivery adapter`
          : `Provider "${current.recipient.providerId}" is no longer registered`
        const reason = accepted
          ? `${unavailable}; attempt ${accepted.attempt} may already have been delivered but can no longer be confirmed`
          : inFlightAttempt
          ? `${unavailable}; in-flight attempt ${inFlightAttempt} may already have been submitted but can no longer be confirmed`
          : unavailable
        const recorded = await transition(ledger, {
          deliveryId: current.id,
          expected: { state: current.state, attempt: current.attempt },
          next: {
            state: 'failed',
            attempt: current.attempt,
            reason,
            retryable: false,
          },
        })
        return recorded
          ? {
              deliveryId: current.id,
              state: accepted || inFlightAttempt ? 'ambiguous' : 'failed',
              reason,
            }
          : { deliveryId: current.id, state: 'ambiguous', reason: `could not record: ${reason}` }
      })
      continue
    }
    const attemptDue = isAttemptDue(delivery, now)
    const confirmationDue = !!adapter.confirm && isConfirmationDue(delivery, now)
    const needsAcceptanceTerminalization = !adapter.confirm && !!activeProviderAcceptance(delivery)
    const envelope = attemptDue || confirmationDue || needsAcceptanceTerminalization
      ? envelopeFor(delivery.messageId)
      : undefined
    if ((attemptDue || confirmationDue || needsAcceptanceTerminalization) && !envelope) continue
    if (delivery.state === 'in-flight') {
      work.push(async () => {
        const current = ledger.getDelivery(delivery.id)
        if (!current || current.state !== 'in-flight') {
          return { deliveryId: delivery.id, state: 'skipped' }
        }
        const completedAttempts = deliverySendAttemptCount(current)
        const exhausted = completedAttempts >= maxAttemptsFor(options)
        const ambiguity = `Provider "${current.recipient.providerId}" in-flight attempt ${
          current.attempt
        } may already have been submitted but returned no durable acceptance evidence`
        const reason = exhausted
          ? `${ambiguity}; provider delivery attempt budget exhausted after ${
            countLabel(completedAttempts, 'attempt')
          }`
          : ambiguity
        const recorded = await transition(ledger, {
          deliveryId: current.id,
          expected: { state: 'in-flight', attempt: current.attempt },
          countsAsSendAttempt: true,
          next: {
            state: 'failed',
            attempt: current.attempt,
            reason,
            retryable: !exhausted,
            ...(!exhausted
              ? {
                  retryAt: retryAtFor(
                    new Date(now).toISOString(),
                    undefined,
                    options.retryDelayMs,
                    now,
                  ),
                }
              : {}),
          },
        })
        return recorded
          ? { deliveryId: current.id, state: 'ambiguous', reason }
          : { deliveryId: current.id, state: 'ambiguous', reason: `could not record: ${reason}` }
      })
      continue
    }
    const accepted = envelope ? durableAcceptance(envelope, delivery) : null
    if (accepted && !adapter.confirm && envelope) {
      const acceptedEnvelope = envelope
      work.push(async () => {
        const current = ledger.getDelivery(delivery.id)
        if (!current) return { deliveryId: delivery.id, state: 'skipped' }
        const durable = durableAcceptance(acceptedEnvelope, current)
        if (!durable) return { deliveryId: current.id, state: 'skipped' }
        const reason = `Provider "${current.recipient.providerId}" accepted attempt ${
          durable.attempt
        } but exposes no confirmation evidence; delivery outcome is ambiguous`
        const recorded = await transition(ledger, {
          deliveryId: current.id,
          expected: { state: current.state, attempt: current.attempt },
          next: {
            state: 'failed',
            attempt: current.attempt,
            reason,
            retryable: false,
          },
        })
        return recorded
          ? { deliveryId: current.id, state: 'ambiguous', reason }
          : { deliveryId: current.id, state: 'ambiguous', reason: `could not record: ${reason}` }
      })
      continue
    }
    if (attemptDue && envelope) {
      work.push(() => dispatchOne(envelope, delivery, ledger, registry, options))
      continue
    }
    if (
      adapter.confirm
      && accepted
      && confirmationDue
      && envelope
    ) {
      work.push(() => confirmOne(delivery, ledger, registry, options, envelope))
    }
  }
  return Promise.all(work.map(operation => deliveryDispatchScheduler.run(operation)))
}

/** Polls the durable ledger for due retries; each sweep is single-flight. */
export class DeliveryRetryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private sweep: Promise<DeliveryDispatchOutcome[]> | null = null

  constructor(
    private readonly ledger: RecoveryLedger,
    private readonly registry: ProviderAdapterRegistry,
    private readonly options: DeliveryDispatchOptions & { pollMs?: number } = {},
  ) {}

  start(): Promise<DeliveryDispatchOutcome[]> {
    if (!this.timer) {
      this.timer = setInterval(() => { void this.runNow() }, this.options.pollMs ?? DELIVERY_RETRY_POLL_MS)
      this.timer.unref?.()
    }
    return this.runNow()
  }

  runNow(): Promise<DeliveryDispatchOutcome[]> {
    if (this.sweep) return this.sweep
    this.sweep = recoverAcceptedMessages(
      this.ledger,
      this.registry,
      this.options,
    ).finally(() => { this.sweep = null })
    return this.sweep
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.sweep) await this.sweep
  }
}

interface ProcessDeliveryRetryOwner {
  generation: number
  active: DeliveryRetryScheduler | null
  transition: Promise<void>
}

const PROCESS_DELIVERY_RETRY_OWNER = Symbol.for(
  'tinstar.delivery-retry-scheduler-owner.v1',
)

function processDeliveryRetryOwner(): ProcessDeliveryRetryOwner {
  const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
  let owner = processGlobal[PROCESS_DELIVERY_RETRY_OWNER] as
    | ProcessDeliveryRetryOwner
    | undefined
  if (!owner) {
    owner = {
      generation: 0,
      active: null,
      transition: Promise.resolve(),
    }
    processGlobal[PROCESS_DELIVERY_RETRY_OWNER] = owner
  }
  return owner
}

/**
 * Replace the process-wide retry loop during backend/HMR replacement. The old
 * loop is stopped before the new one starts polling the shared ledger.
 */
export async function replaceDeliveryRetryScheduler(
  scheduler: DeliveryRetryScheduler,
): Promise<DeliveryDispatchOutcome[]> {
  const owner = processDeliveryRetryOwner()
  const generation = ++owner.generation
  let outcomes: DeliveryDispatchOutcome[] = []
  const activation = owner.transition.then(async () => {
    const previous = owner.active
    owner.active = null
    if (previous && previous !== scheduler) await previous.stop()
    if (owner.generation !== generation) return

    try {
      outcomes = await scheduler.start()
    } catch (error) {
      try {
        await scheduler.stop()
      } catch (stopError) {
        const startMessage = error instanceof Error ? error.message : String(error)
        const stopMessage = stopError instanceof Error ? stopError.message : String(stopError)
        throw new AggregateError(
          [error, stopError],
          `retry scheduler start failed (${startMessage}); rollback failed (${stopMessage})`,
        )
      }
      throw error
    }
    if (owner.generation !== generation) {
      await scheduler.stop()
      return
    }
    owner.active = scheduler
  })
  owner.transition = activation.catch(() => {})
  await activation
  return outcomes
}

export async function stopDeliveryRetryScheduler(
  expected?: DeliveryRetryScheduler,
): Promise<void> {
  const owner = processDeliveryRetryOwner()
  if (expected) {
    // Generation cleanup must only retire the scheduler that generation
    // installed. Do not advance the global generation: a newer replacement may
    // already be queued behind the current transition.
    const stoppingExpected = owner.transition.then(async () => {
      if (owner.active === expected) owner.active = null
      await expected.stop()
    })
    owner.transition = stoppingExpected.catch(() => {})
    await stoppingExpected
    return
  }

  // Unscoped stop is reserved for whole-process shutdown/test reset.
  ++owner.generation
  const stopping = owner.transition.then(async () => {
    const current = owner.active
    owner.active = null
    await current?.stop()
  })
  owner.transition = stopping.catch(() => {})
  await stopping
}

/** Route newly accepted work through the same FIFO sweep as due retries. */
export function runDeliveryRetrySchedulerNow(): Promise<DeliveryDispatchOutcome[]> {
  return processDeliveryRetryOwner().active?.runNow() ?? Promise.resolve([])
}
