import type { ProviderAdapterRegistry } from '../providers/lifecycle'
import type {
  DeliveryEnvelope,
  DeliveryLedger,
  DeliveryRecord,
  DeliveryTransitionInput,
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

export interface DeliveryDispatchOptions {
  now?: () => number
  retryDelayMs?: number
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
  const attempt = current.attempt + 1
  const claimed = await transition(ledger, {
    deliveryId: current.id,
    expected: { state: current.state, attempt: current.attempt },
    next: { state: 'in-flight', attempt },
  })
  if (!claimed) return { deliveryId: current.id, state: 'skipped' }

  const adapter = registry.deliveryFor(current.recipient.providerId)
  if (!adapter) {
    const reason = `Provider "${current.recipient.providerId}" has no delivery adapter`
    const recorded = await transition(ledger, {
      deliveryId: current.id,
      expected: { state: 'in-flight', attempt },
      next: { state: 'failed', attempt, reason, retryable: false },
    })
    return recorded
      ? { deliveryId: current.id, state: 'failed', reason }
      : { deliveryId: current.id, state: 'ambiguous', reason: `could not record: ${reason}` }
  }

  try {
    const result = await adapter.accept({
      messageId: envelope.message.id,
      deliveryId: current.id,
      attempt,
      acceptedAt: envelope.message.acceptedAt,
      sender: { ...envelope.message.sender },
      destination: { ...envelope.message.destination },
      recipient: { ...current.recipient },
      text: envelope.message.text,
    })
    if (result.state === 'delivered') {
      const recorded = await transition(ledger, {
        deliveryId: current.id,
        expected: { state: 'in-flight', attempt },
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
      const recorded = await transition(ledger, {
        deliveryId: current.id,
        expected: { state: 'in-flight', attempt },
        next: {
          state: 'accepted',
          attempt,
          ...(result.attemptRef ? { attemptRef: result.attemptRef } : {}),
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
      const recorded = await transition(ledger, {
        deliveryId: current.id,
        expected: { state: 'in-flight', attempt },
        next: {
          state: 'pending',
          attempt,
          reason: result.reason,
          retryAt: retryAtFor(
            result.checkedAt,
            result.retryAt,
            options.retryDelayMs,
            now,
          ),
        },
      })
      return recorded
        ? { deliveryId: current.id, state: 'pending', reason: result.reason }
        : {
            deliveryId: current.id,
            state: 'ambiguous',
            reason: `could not record provider deferral: ${result.reason}`,
          }
    }
    const recorded = await transition(ledger, {
      deliveryId: current.id,
      expected: { state: 'in-flight', attempt },
      next: {
        state: 'failed',
        attempt,
        reason: result.reason,
        retryable: result.retryable,
        ...(result.retryable
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

function lastEvent(delivery: DeliveryRecord) {
  return delivery.history[delivery.history.length - 1]!
}

function isAttemptDue(delivery: DeliveryRecord, now: number): boolean {
  if (delivery.state === 'accepted') return delivery.attempt === 0
  if (delivery.state === 'failed' && lastEvent(delivery).retryable !== true) return false
  if (delivery.state !== 'pending' && delivery.state !== 'failed') return false
  const retryAt = lastEvent(delivery).retryAt
  return !retryAt || Date.parse(retryAt) <= now
}

function retryAtFor(
  checkedAt: string,
  explicitRetryAt: string | undefined,
  retryDelayMs = DELIVERY_RETRY_DELAY_MS,
  now = Date.now(),
): string {
  if (explicitRetryAt) return explicitRetryAt
  const checkedAtMs = Date.parse(checkedAt)
  const base = Number.isFinite(checkedAtMs) ? Math.max(checkedAtMs, now) : now
  return new Date(base + retryDelayMs).toISOString()
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
 * Resume every due, retry-safe obligation in global acceptance/id FIFO order.
 * In-flight attempts and provider-accepted attempts remain fenced because
 * their side effect may already have occurred or requires confirmation.
 */
export async function recoverAcceptedMessages(
  ledger: RecoveryLedger,
  registry: ProviderAdapterRegistry,
  options: DeliveryDispatchOptions = {},
): Promise<DeliveryDispatchOutcome[]> {
  const now = options.now?.() ?? Date.now()
  const due = ledger.listRecoverable().filter(delivery => isAttemptDue(delivery, now))
  return Promise.all(due.map(delivery => deliveryDispatchScheduler.run(async () => {
    const envelope = ledger.getMessage(delivery.messageId)
    if (!envelope) return { deliveryId: delivery.id, state: 'skipped' as const }
    return dispatchOne(envelope, delivery, ledger, registry, options)
  })))
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

let activeDeliveryRetryScheduler: DeliveryRetryScheduler | null = null

/**
 * Replace the process-wide retry loop during backend/HMR replacement. The old
 * loop is stopped before the new one starts polling the shared ledger.
 */
export async function replaceDeliveryRetryScheduler(
  scheduler: DeliveryRetryScheduler,
): Promise<DeliveryDispatchOutcome[]> {
  const previous = activeDeliveryRetryScheduler
  activeDeliveryRetryScheduler = scheduler
  if (previous && previous !== scheduler) await previous.stop()
  if (activeDeliveryRetryScheduler !== scheduler) return []
  return scheduler.start()
}

export async function stopDeliveryRetryScheduler(): Promise<void> {
  const current = activeDeliveryRetryScheduler
  activeDeliveryRetryScheduler = null
  await current?.stop()
}

/** Route newly accepted work through the same FIFO sweep as due retries. */
export function runDeliveryRetrySchedulerNow(): Promise<DeliveryDispatchOutcome[]> {
  return activeDeliveryRetryScheduler?.runNow() ?? Promise.resolve([])
}
