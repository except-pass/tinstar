import type { Session } from '../sessions/session'
import { parseSubject, type ParsedSubject } from '../nats/subjects'
import { sanitizeSubjectToken } from '../sessions/nats-subscriptions'
import type {
  DeliveryAcceptIntent,
  DeliveryAcceptInput,
  DeliveryAcceptResult,
  DeliveryLedgerRecipient,
} from './delivery-ledger'
import { validateDeliveryAcceptIntent } from './delivery-ledger'

export type LiveDeliveryRequest = DeliveryAcceptIntent

export type RecipientExclusionReason =
  | 'missing'
  | 'graveyarded'
  | 'not-started'
  | 'stopped'
  | 'deleting'
  | 'not-subscribed'
  | 'lifecycle-conflict'
  | 'process-dead'
  | 'liveness-check-failed'
  | 'provider-unavailable'
  | 'identity-unavailable'

export interface RecipientExclusion {
  sessionId: string
  reason: RecipientExclusionReason
}

export interface DeliveryRecipientLease {
  token: string
  release: () => void
}

export interface LiveDeliveryDependencies {
  listSessions: () => readonly Session[] | Promise<readonly Session[]>
  /** Re-read after acquiring the lifecycle lease; the initial list is discovery only. */
  readSession: (sessionId: string) => Session | null
  isDeleting: (sessionId: string) => boolean
  graveyardSessionNames: () => readonly string[]
  /** A held lease must prevent start, stop, and delete for this session. */
  acquireLease: (sessionId: string) => DeliveryRecipientLease | null
  /** Reconciliation may invalidate a generation when the process dies. */
  leaseIsCurrent: (sessionId: string, token: string) => boolean
  /** Definitive managed-process observation made while the lease is held. */
  observeProcess: (sessionId: string) => Promise<
    | { state: 'alive'; incarnation: string }
    | { state: 'dead' }
  >
  /** Provider identity comes from the open registry, never a shared provider union. */
  providerIdFor: (session: Session) => string
  replayAcceptance: (
    input: DeliveryAcceptIntent,
  ) => Promise<DeliveryAcceptResult | null>
  accept: (input: DeliveryAcceptInput) => Promise<DeliveryAcceptResult>
}

type DestinationKind = ParsedSubject['kind']
type AcceptedDelivery = Extract<DeliveryAcceptResult, { accepted: true }>
type RejectedDelivery = Extract<DeliveryAcceptResult, { accepted: false }>

export type LiveDeliveryResult =
  | {
    ok: true
    destinationKind: DestinationKind
    exclusions: RecipientExclusion[]
    acceptance: AcceptedDelivery
  }
  | {
    ok: false
    error:
      | {
        code: 'invalid-request'
        detail: string
      }
      | {
        code: 'invalid-destination'
        subject: string
      }
      | {
        code: 'session-config-unavailable'
        subject: string
      }
      | {
        code: 'recipient-unavailable' | 'empty-live-set'
        destinationKind: DestinationKind
        subject: string
        exclusions: RecipientExclusion[]
      }
      | {
        code: 'ambiguous-recipient'
        destinationKind: 'dm'
        subject: string
        sessionIds: string[]
      }
      | {
        code: 'ledger-rejected'
        destinationKind: DestinationKind
        subject: string
        exclusions: RecipientExclusion[]
        rejection: RejectedDelivery
      }
      | {
        code: 'ledger-failed'
        destinationKind: DestinationKind
        subject: string
        exclusions: RecipientExclusion[]
        detail: string
      }
  }

const PROCESS_BACKED_STATES = new Set<Session['state']>([
  'running',
  'idle',
  'needs_attention',
])

function destinationSessions(
  parsed: ParsedSubject,
  subject: string,
  sessions: readonly Session[],
): Session[] {
  if (parsed.kind === 'dm') {
    const matching = sessions.filter(
      session => sanitizeSubjectToken(session.name) === parsed.session,
    )
    const exact = matching.find(session => session.name === parsed.session)
    return exact ? [exact] : matching
  }
  return sessions.filter(session =>
    session.nats?.enabled === true
    && session.nats.subscriptions.includes(subject))
}

function stateExclusion(session: Session): RecipientExclusionReason | null {
  if (session.state === 'creating') return 'not-started'
  if (session.state === 'stopped') return 'stopped'
  return PROCESS_BACKED_STATES.has(session.state) ? null : 'stopped'
}

function subscribesTo(
  session: Session,
  subject: string,
  parsed: ParsedSubject,
): boolean {
  if (session.nats?.enabled !== true) return false
  if (!session.nats.subscriptions.includes(subject)) return false
  return parsed.kind !== 'dm'
    || sanitizeSubjectToken(session.name) === parsed.session
}

function directMissingExclusion(
  parsed: Extract<ParsedSubject, { kind: 'dm' }>,
  deps: LiveDeliveryDependencies,
): RecipientExclusion {
  const graveyarded = deps.graveyardSessionNames().some(
    name => sanitizeSubjectToken(name) === parsed.session,
  )
  return {
    sessionId: parsed.session,
    reason: graveyarded ? 'graveyarded' : 'missing',
  }
}

function sortExclusions(exclusions: RecipientExclusion[]): RecipientExclusion[] {
  return exclusions.sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId)
    || left.reason.localeCompare(right.reason))
}

/**
 * Resolve a subject against the managed-session live set and durably accept the
 * resulting recipient snapshot.
 *
 * Every definitive state read and process probe happens under a lifecycle
 * lease, and those leases remain held until the ledger acceptance settles.
 * Callers therefore receive one operation: a recipient cannot stop, restart,
 * delete, or change incarnation between being declared live and becoming a
 * durable delivery obligation.
 */
export async function acceptForLiveRecipients(
  request: LiveDeliveryRequest,
  deps: LiveDeliveryDependencies,
): Promise<LiveDeliveryResult> {
  const requestProblem = validateDeliveryAcceptIntent(request)
  if (requestProblem) {
    return { ok: false, error: { code: 'invalid-request', detail: requestProblem } }
  }
  const subject = request.destination.subject
  const parsed = parseSubject(subject)
  if (!parsed) {
    return { ok: false, error: { code: 'invalid-destination', subject } }
  }

  let replay: DeliveryAcceptResult | null
  try {
    replay = await deps.replayAcceptance(request)
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'ledger-failed',
        destinationKind: parsed.kind,
        subject,
        exclusions: [],
        detail: error instanceof Error ? error.message : String(error),
      },
    }
  }
  if (replay) {
    if (!replay.accepted) {
      return {
        ok: false,
        error: {
          code: 'ledger-rejected',
          destinationKind: parsed.kind,
          subject,
          exclusions: [],
          rejection: replay,
        },
      }
    }
    return {
      ok: true,
      destinationKind: parsed.kind,
      exclusions: [],
      acceptance: replay,
    }
  }

  const discovered = destinationSessions(
    parsed,
    subject,
    await deps.listSessions(),
  ).sort((left, right) => left.name.localeCompare(right.name))

  if (parsed.kind === 'dm' && discovered.length === 0) {
    return {
      ok: false,
      error: {
        code: 'recipient-unavailable',
        destinationKind: parsed.kind,
        subject,
        exclusions: [directMissingExclusion(parsed, deps)],
      },
    }
  }
  if (parsed.kind === 'dm' && discovered.length > 1) {
    return {
      ok: false,
      error: {
        code: 'ambiguous-recipient',
        destinationKind: parsed.kind,
        subject,
        sessionIds: discovered.map(session => session.name),
      },
    }
  }

  const leases: DeliveryRecipientLease[] = []
  const exclusions: RecipientExclusion[] = []
  const leased: { sessionId: string; lease: DeliveryRecipientLease }[] = []
  try {
    // No await in this loop: all candidate lifecycle leases are acquired as one
    // synchronous boundary before the first process probe can yield.
    for (const discoveredSession of discovered) {
      const sessionId = discoveredSession.name
      if (deps.isDeleting(sessionId)) {
        exclusions.push({ sessionId, reason: 'deleting' })
        continue
      }
      const initialStateProblem = stateExclusion(discoveredSession)
      if (initialStateProblem) {
        exclusions.push({ sessionId, reason: initialStateProblem })
        continue
      }
      const lease = deps.acquireLease(sessionId)
      if (!lease) {
        exclusions.push({ sessionId, reason: 'lifecycle-conflict' })
        continue
      }
      leases.push(lease)
      leased.push({ sessionId, lease })
    }

    const recipients: DeliveryLedgerRecipient[] = []
    for (const { sessionId, lease } of leased) {
      const current = deps.readSession(sessionId)
      if (!current) {
        exclusions.push({ sessionId, reason: 'missing' })
        continue
      }
      if (deps.isDeleting(sessionId)) {
        exclusions.push({ sessionId, reason: 'deleting' })
        continue
      }
      const currentStateProblem = stateExclusion(current)
      if (currentStateProblem) {
        exclusions.push({ sessionId, reason: currentStateProblem })
        continue
      }
      if (!subscribesTo(current, subject, parsed)) {
        exclusions.push({ sessionId, reason: 'not-subscribed' })
        continue
      }

      let processObservation:
        | { state: 'alive'; incarnation: string }
        | { state: 'dead' }
      try {
        processObservation = await deps.observeProcess(sessionId)
      } catch {
        exclusions.push({ sessionId, reason: 'liveness-check-failed' })
        continue
      }
      if (processObservation.state === 'dead') {
        exclusions.push({ sessionId, reason: 'process-dead' })
        continue
      }
      if (!deps.leaseIsCurrent(sessionId, lease.token)) {
        exclusions.push({ sessionId, reason: 'lifecycle-conflict' })
        continue
      }

      if (!processObservation.incarnation.trim()) {
        exclusions.push({ sessionId, reason: 'identity-unavailable' })
        continue
      }
      let providerId: string
      try {
        providerId = deps.providerIdFor(current)
      } catch {
        exclusions.push({ sessionId, reason: 'provider-unavailable' })
        continue
      }
      if (!providerId.trim()) {
        exclusions.push({ sessionId, reason: 'provider-unavailable' })
        continue
      }
      recipients.push({
        providerId,
        sessionId,
        incarnation: processObservation.incarnation,
      })
    }

    sortExclusions(exclusions)
    const leaseTokens = new Map(leased.map(({ sessionId, lease }) => [
      sessionId,
      lease.token,
    ]))
    for (let index = recipients.length - 1; index >= 0; index--) {
      const recipient = recipients[index]!
      const leaseToken = leaseTokens.get(recipient.sessionId)
      if (leaseToken && deps.leaseIsCurrent(recipient.sessionId, leaseToken)) continue
      recipients.splice(index, 1)
      exclusions.push({
        sessionId: recipient.sessionId,
        reason: 'lifecycle-conflict',
      })
    }
    sortExclusions(exclusions)
    if (recipients.length === 0) {
      return {
        ok: false,
        error: {
          code: parsed.kind === 'dm' ? 'recipient-unavailable' : 'empty-live-set',
          destinationKind: parsed.kind,
          subject,
          exclusions,
        },
      }
    }

    let acceptance: DeliveryAcceptResult
    try {
      acceptance = await deps.accept({ ...request, recipients })
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'ledger-failed',
          destinationKind: parsed.kind,
          subject,
          exclusions,
          detail: error instanceof Error ? error.message : String(error),
        },
      }
    }
    if (!acceptance.accepted) {
      return {
        ok: false,
        error: {
          code: 'ledger-rejected',
          destinationKind: parsed.kind,
          subject,
          exclusions,
          rejection: acceptance,
        },
      }
    }
    return {
      ok: true,
      destinationKind: parsed.kind,
      exclusions,
      acceptance,
    }
  } finally {
    for (let index = leases.length - 1; index >= 0; index--) {
      leases[index]!.release()
    }
  }
}
