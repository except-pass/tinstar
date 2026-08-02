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
  state: 'accepted' | 'pending' | 'failed' | 'ambiguous' | 'skipped'
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
): Promise<DeliveryDispatchOutcome> {
  // The durable recipient is the obligation: never re-resolve this delivery to
  // a replacement process. Provider adapters must classify a changed
  // incarnation as a terminal recipient-replaced rejection.
  const current = ledger.getDelivery(captured.id)
  if (!current || current.state !== 'accepted' || current.attempt !== 0) {
    return { deliveryId: captured.id, state: 'skipped' }
  }
  const claimed = await transition(ledger, {
    deliveryId: current.id,
    expected: { state: 'accepted', attempt: 0 },
    next: { state: 'in-flight', attempt: 1 },
  })
  if (!claimed) return { deliveryId: current.id, state: 'skipped' }

  const adapter = registry.deliveryFor(current.recipient.providerId)
  if (!adapter) {
    const reason = `Provider "${current.recipient.providerId}" has no delivery adapter`
    const recorded = await transition(ledger, {
      deliveryId: current.id,
      expected: { state: 'in-flight', attempt: 1 },
      next: { state: 'failed', attempt: 1, reason, retryable: false },
    })
    return recorded
      ? { deliveryId: current.id, state: 'failed', reason }
      : { deliveryId: current.id, state: 'ambiguous', reason: `could not record: ${reason}` }
  }

  try {
    const result = await adapter.accept({
      messageId: envelope.message.id,
      deliveryId: current.id,
      attempt: 1,
      acceptedAt: envelope.message.acceptedAt,
      sender: { ...envelope.message.sender },
      destination: { ...envelope.message.destination },
      recipient: { ...current.recipient },
      text: envelope.message.text,
    })
    if (result.state === 'accepted') {
      const recorded = await transition(ledger, {
        deliveryId: current.id,
        expected: { state: 'in-flight', attempt: 1 },
        next: {
          state: 'accepted',
          attempt: 1,
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
        expected: { state: 'in-flight', attempt: 1 },
        next: {
          state: 'pending',
          attempt: 1,
          reason: result.reason,
          ...(result.retryAt ? { retryAt: result.retryAt } : {}),
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
      expected: { state: 'in-flight', attempt: 1 },
      next: {
        state: 'failed',
        attempt: 1,
        reason: result.reason,
        retryable: result.retryable,
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

/**
 * Dispatch each recipient exactly once from its durable accepted/0 state.
 * Results retain the ledger's recipient order even when providers settle out
 * of order.
 */
export async function dispatchAcceptedMessage(
  messageId: string,
  ledger: DispatchLedger,
  registry: ProviderAdapterRegistry,
): Promise<DeliveryDispatchOutcome[]> {
  const envelope = ledger.getMessage(messageId)
  if (!envelope) return []
  return Promise.all(
    envelope.deliveries.map(delivery => deliveryDispatchScheduler.run(() =>
      dispatchOne(envelope, delivery, ledger, registry),
    )),
  )
}

/**
 * Resume only delivery obligations that crashed before their first provider
 * attempt was claimed. In-flight and pending attempts need provider evidence
 * or an explicit retry policy; replaying them here could duplicate a delivery.
 */
export async function recoverAcceptedMessages(
  ledger: RecoveryLedger,
  registry: ProviderAdapterRegistry,
): Promise<DeliveryDispatchOutcome[]> {
  const messageIds = new Set(
    ledger.listRecoverable()
      .filter(delivery => delivery.state === 'accepted' && delivery.attempt === 0)
      .map(delivery => delivery.messageId),
  )
  const outcomes: DeliveryDispatchOutcome[] = []
  for (const messageId of messageIds) {
    outcomes.push(...await dispatchAcceptedMessage(messageId, ledger, registry))
  }
  return outcomes
}
