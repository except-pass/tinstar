import type {
  DeliveryEvidence,
  DeliveryLedgerHealth,
  DeliveryLedgerRecipient,
  DeliveryRecord,
  DeliveryTransitionInput,
  DeliveryTransitionResult,
} from './delivery-ledger'

export type DeliveryRecoveryLiveness =
  | { state: 'alive'; incarnation: string }
  | { state: 'dead'; reason: string }
  | { state: 'inconclusive'; reason: string }

export interface DeliveryRecoveryEvidenceIdentity {
  providerId: string
  messageId: string
  attempt: number
  /** Provider-owned attempt identity, when the interrupted dispatch recorded one. */
  attemptRef?: string
  recipient: {
    providerId: string
    sessionId: string
    incarnation: string
  }
}

export type DeliveryRecoveryEvidence =
  | (DeliveryRecoveryEvidenceIdentity & {
      state: 'confirmed'
      confirmedAt: string
      evidence: DeliveryEvidence
    })
  | (DeliveryRecoveryEvidenceIdentity & {
      /** A complete provider transcript scan found no exact stamped message ID. */
      state: 'not-found'
      checkedAt: string
      reason: string
    })
  | (DeliveryRecoveryEvidenceIdentity & {
      /** Evidence could not prove either delivery or exact stamped absence. */
      state: 'inconclusive'
      checkedAt: string
      reason: string
    })

export interface DeliveryRecoveryEvidenceRequest {
  providerId: string
  messageId: string
  deliveryId: string
  attempt: number
  attemptRef?: string
  acceptedAt: string
  recipient: DeliveryLedgerRecipient
}

interface DeliveryRecoveryLedger {
  readonly health: DeliveryLedgerHealth
  listRecoverable(): DeliveryRecord[]
  getDelivery(deliveryId: string): DeliveryRecord | undefined
  transition(input: DeliveryTransitionInput): Promise<DeliveryTransitionResult>
}

export interface DeliveryRecoveryDependencies {
  ledger: DeliveryRecoveryLedger
  observeRecipient(
    recipient: DeliveryLedgerRecipient,
  ): Promise<DeliveryRecoveryLiveness>
  inspectTranscriptEvidence(
    request: DeliveryRecoveryEvidenceRequest,
  ): Promise<DeliveryRecoveryEvidence>
}

export type DeliveryRecoveryDisposition =
  | 'ready'
  | 'delivered'
  | 'failed'
  | 'ambiguous'
  | 'error'

export interface DeliveryRecoveryOutcome {
  deliveryId: string
  messageId: string
  disposition: DeliveryRecoveryDisposition
  reason: string
}

export interface DeliveryRecoveryReport {
  status: 'complete' | 'faulted'
  ledgerHealth: DeliveryLedgerHealth
  scanned: number
  outcomes: DeliveryRecoveryOutcome[]
}

const activeRecoveries = new WeakMap<object, Promise<DeliveryRecoveryReport>>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lastAttemptRef(delivery: DeliveryRecord): string | undefined {
  return delivery.history.at(-1)?.attemptRef
}

function evidenceMatches(
  evidence: DeliveryRecoveryEvidence,
  delivery: DeliveryRecord,
): boolean {
  return evidence.providerId === delivery.recipient.providerId
    && evidence.messageId === delivery.messageId
    && evidence.attempt === delivery.attempt
    && evidence.attemptRef === lastAttemptRef(delivery)
    && evidence.recipient.providerId === delivery.recipient.providerId
    && evidence.recipient.sessionId === delivery.recipient.sessionId
    && evidence.recipient.incarnation === delivery.recipient.incarnation
}

function outcome(
  delivery: DeliveryRecord,
  disposition: DeliveryRecoveryDisposition,
  reason: string,
): DeliveryRecoveryOutcome {
  return {
    deliveryId: delivery.id,
    messageId: delivery.messageId,
    disposition,
    reason,
  }
}

/**
 * Reconcile durable delivery obligations once at backend startup.
 *
 * The ledger remains authoritative. This coordinator only advances records by
 * compare-and-swap transitions, never reconstructs obligations from tmux or a
 * transcript, and never changes the stamped recipient incarnation.
 */
export class DeliveryRecoveryCoordinator {
  constructor(private readonly dependencies: DeliveryRecoveryDependencies) {}

  recover(): Promise<DeliveryRecoveryReport> {
    const key = this.dependencies.ledger as object
    const active = activeRecoveries.get(key)
    if (active) return active
    const run = this.recoverOwned().finally(() => {
      if (activeRecoveries.get(key) === run) activeRecoveries.delete(key)
    })
    activeRecoveries.set(key, run)
    return run
  }

  private async recoverOwned(): Promise<DeliveryRecoveryReport> {
    const ledger = this.dependencies.ledger
    if (ledger.health === 'faulted-read-only' || ledger.health === 'write-uncertain') {
      return {
        status: 'faulted',
        ledgerHealth: ledger.health,
        scanned: 0,
        outcomes: [],
      }
    }

    let recoverable: DeliveryRecord[]
    try {
      recoverable = ledger.listRecoverable()
    } catch (error) {
      return {
        status: 'faulted',
        ledgerHealth: ledger.health,
        scanned: 0,
        outcomes: [{
          deliveryId: '<ledger>',
          messageId: '<ledger>',
          disposition: 'error',
          reason: `could not enumerate recovery work: ${errorMessage(error)}`,
        }],
      }
    }

    const outcomes: DeliveryRecoveryOutcome[] = []
    for (const delivery of recoverable) {
      try {
        outcomes.push(await this.recoverDelivery(delivery))
      } catch (error) {
        outcomes.push(outcome(
          delivery,
          'error',
          `unexpected recovery failure: ${errorMessage(error)}`,
        ))
      }
    }
    return {
      status: outcomes.some(entry => entry.disposition === 'error')
        ? 'faulted'
        : 'complete',
      ledgerHealth: ledger.health,
      scanned: recoverable.length,
      outcomes,
    }
  }

  private async recoverDelivery(
    captured: DeliveryRecord,
  ): Promise<DeliveryRecoveryOutcome> {
    const current = this.dependencies.ledger.getDelivery(captured.id)
    if (!current) return outcome(captured, 'error', 'ledger record disappeared')

    let observed: DeliveryRecoveryLiveness
    try {
      observed = await this.dependencies.observeRecipient({ ...current.recipient })
    } catch (error) {
      observed = {
        state: 'inconclusive',
        reason: `recipient liveness probe failed: ${errorMessage(error)}`,
      }
    }
    if (observed.state === 'dead') {
      const reason = typeof observed.reason === 'string' && observed.reason.trim()
        ? observed.reason
        : 'recipient process was not running'
      return this.terminalize(current, reason)
    }
    if (observed.state === 'inconclusive') {
      return outcome(current, 'ambiguous', observed.reason)
    }
    if (typeof observed.incarnation !== 'string' || !observed.incarnation.trim()) {
      return outcome(current, 'ambiguous', 'recipient process identity was unavailable')
    }
    if (observed.incarnation !== current.recipient.incarnation) {
      return this.terminalize(
        current,
        'recipient process incarnation changed while Tinstar was offline',
      )
    }

    if (current.state === 'in-flight') return this.reconcileInFlight(current)
    if (current.state === 'pending') {
      return outcome(current, 'ready', 'pending obligation retained after restart')
    }
    return this.makePending(current, 'same recipient process survived restart')
  }

  private async reconcileInFlight(
    delivery: DeliveryRecord,
  ): Promise<DeliveryRecoveryOutcome> {
    let evidence: DeliveryRecoveryEvidence
    try {
      const attemptRef = lastAttemptRef(delivery)
      evidence = await this.dependencies.inspectTranscriptEvidence({
        providerId: delivery.recipient.providerId,
        messageId: delivery.messageId,
        deliveryId: delivery.id,
        attempt: delivery.attempt,
        ...(attemptRef !== undefined
          ? { attemptRef }
          : {}),
        acceptedAt: delivery.acceptedAt,
        recipient: { ...delivery.recipient },
      })
    } catch (error) {
      return outcome(
        delivery,
        'ambiguous',
        `transcript evidence probe failed: ${errorMessage(error)}`,
      )
    }
    if (!evidenceMatches(evidence, delivery)) {
      return outcome(
        delivery,
        'ambiguous',
        'transcript evidence did not match the exact delivery identity',
      )
    }
    if (evidence.state === 'inconclusive') {
      return outcome(delivery, 'ambiguous', evidence.reason)
    }
    if (evidence.state === 'not-found') {
      return this.makePending(delivery, evidence.reason)
    }
    if (evidence.state !== 'confirmed') {
      return outcome(delivery, 'ambiguous', 'transcript evidence state was unknown')
    }
    const transition = await this.dependencies.ledger.transition({
      deliveryId: delivery.id,
      expected: { state: delivery.state, attempt: delivery.attempt },
      next: {
        state: 'delivered',
        attempt: delivery.attempt,
        evidence: evidence.evidence,
      },
    })
    return transition.updated
      ? outcome(delivery, 'delivered', 'exact stamped transcript evidence confirmed delivery')
      : outcome(delivery, 'error', `could not record delivery: ${transition.reason}`)
  }

  private async makePending(
    delivery: DeliveryRecord,
    reason: string,
  ): Promise<DeliveryRecoveryOutcome> {
    if (delivery.state === 'pending') return outcome(delivery, 'ready', reason)
    const transition = await this.dependencies.ledger.transition({
      deliveryId: delivery.id,
      expected: { state: delivery.state, attempt: delivery.attempt },
      next: { state: 'pending', attempt: delivery.attempt, reason },
    })
    return transition.updated
      ? outcome(delivery, 'ready', reason)
      : outcome(delivery, 'error', `could not make delivery ready: ${transition.reason}`)
  }

  private async terminalize(
    delivery: DeliveryRecord,
    reason: string,
  ): Promise<DeliveryRecoveryOutcome> {
    const transition = await this.dependencies.ledger.transition({
      deliveryId: delivery.id,
      expected: { state: delivery.state, attempt: delivery.attempt },
      next: {
        state: 'failed',
        attempt: delivery.attempt,
        reason,
        retryable: false,
      },
    })
    return transition.updated
      ? outcome(delivery, 'failed', reason)
      : outcome(delivery, 'error', `could not terminalize delivery: ${transition.reason}`)
  }
}

/**
 * Startup barrier shared with router ownership. Recovery errors are observable,
 * but settling this promise always releases backend boot and router startup.
 */
export async function settleDeliveryRecoveryBarrier(options: {
  recover: () => Promise<unknown>
  onError: (error: unknown) => void
}): Promise<void> {
  try {
    await options.recover()
  } catch (error) {
    try {
      options.onError(error)
    } catch {
      // Reporting is downstream of the fail-closed recovery decision. A broken
      // logger must not strand backend boot or the router ownership barrier.
    }
  }
}
