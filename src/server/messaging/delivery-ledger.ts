import { randomUUID, createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { getConfigRoot } from '../configRoot'
import { backendSingletonOwner } from '../infra/lock'
import type { ProviderDeliveryRecipient } from '../providers/contract'

export const DELIVERY_LEDGER_SCHEMA_VERSION = 1
export const DELIVERY_LEDGER_FILE = 'delivery-ledger.json'
export const TERMINAL_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000
const MAX_TERMINAL_MESSAGES = 2_048
const MAX_OUTSTANDING_DELIVERIES = 10_000
const MAX_HISTORY_ENTRIES = 64
const MESSAGE_ID_ATTEMPTS = 16
const SESSION_REF_KEYS = new Set(['sessionId', 'incarnation'])
const RECIPIENT_KEYS = new Set(['providerId', 'sessionId', 'incarnation'])
const EVIDENCE_KEYS = new Set(['source', 'reference'])
const EVIDENCE_SOURCE_KEYS = new Set(['id', 'label'])
const STATE_EVENT_KEYS = new Set([
  'state', 'attempt', 'at', 'reason', 'retryAt', 'retryable', 'attemptRef', 'evidence',
])
const MESSAGE_KEYS = new Set([
  'id', 'requestId', 'requestFingerprint', 'acceptedAt',
  'sender', 'destination', 'text', 'deliveryIds',
])
const DESTINATION_KEYS = new Set(['subject'])
const DELIVERY_KEYS = new Set([
  'id', 'messageId', 'recipient', 'state', 'attempt', 'acceptedAt',
  'updatedAt', 'history', 'historyTruncated',
])

export interface DeliveryLedgerPaths {
  dir: string
  primary: string
  backup: string
  temp: string
  backupTemp: string
}

export function deliveryLedgerPaths(
  dir: string = getConfigRoot(),
): DeliveryLedgerPaths {
  const primary = join(dir, DELIVERY_LEDGER_FILE)
  const backup = join(dir, 'delivery-ledger.backup.json')
  return {
    dir,
    primary,
    backup,
    temp: `${primary}.tmp`,
    backupTemp: `${backup}.tmp`,
  }
}

export interface DeliverySessionRef {
  sessionId: string
  /** A session name is reusable. The incarnation fences a replacement process. */
  incarnation: string
}

export interface DeliveryLedgerRecipient extends ProviderDeliveryRecipient {
  incarnation: string
}

export interface DeliveryDestination {
  subject: string
}

export interface DeliveryAcceptInput {
  /** Stable caller identity. Replays return the original durable acceptance. */
  requestId: string
  sender: DeliverySessionRef
  destination: DeliveryDestination
  text: string
  recipients: readonly DeliveryLedgerRecipient[]
}

export type DeliveryState =
  | 'accepted'
  | 'pending'
  | 'in-flight'
  | 'delivered'
  | 'failed'

export interface DeliveryEvidence {
  source: { id: string; label: string }
  reference?: string
}

export interface DeliveryStateEvent {
  state: DeliveryState
  attempt: number
  at: string
  reason?: string
  retryAt?: string
  retryable?: boolean
  attemptRef?: string
  evidence?: DeliveryEvidence
}

export interface DeliveryMessage {
  id: string
  requestId: string
  /** Hash of normalized intent; persisted so request-ID reuse is detectable. */
  requestFingerprint: string
  acceptedAt: string
  sender: DeliverySessionRef
  destination: DeliveryDestination
  text: string
  deliveryIds: string[]
}

export interface DeliveryRecord {
  id: string
  messageId: string
  recipient: DeliveryLedgerRecipient
  state: DeliveryState
  attempt: number
  acceptedAt: string
  updatedAt: string
  /** Bounded normalized history. Provider-owned detail never enters the ledger. */
  history: DeliveryStateEvent[]
  /** The initial event is retained even when older intermediate events are pruned. */
  historyTruncated: boolean
}

export interface DeliveryEnvelope {
  message: DeliveryMessage
  deliveries: DeliveryRecord[]
}

export interface DeliveryAcceptanceReceipt {
  requestId: string
  messageId: string
  acceptedAt: string
  deliveryIds: string[]
}

export type DeliveryAcceptRejection =
  | 'invalid-request'
  | 'request-id-reuse'
  | 'message-id-collision'
  | 'capacity-exceeded'
  | 'faulted-read-only'
  | 'write-failed'
  | 'write-uncertain'

export type DeliveryAcceptResult =
  | ({
    accepted: true
    replayed: boolean
    wrote: boolean
    details: 'retained'
    receipt: DeliveryAcceptanceReceipt
  } & DeliveryEnvelope)
  | { accepted: false; reason: DeliveryAcceptRejection; detail?: string }

export interface DeliveryTransitionInput {
  deliveryId: string
  expected: { state: DeliveryState; attempt: number }
  next: Omit<DeliveryStateEvent, 'at'>
}

export type DeliveryTransitionRejection =
  | 'unknown-delivery'
  | 'stale-delivery'
  | 'invalid-transition'
  | 'faulted-read-only'
  | 'write-failed'
  | 'write-uncertain'

export type DeliveryTransitionResult =
  | { updated: true; wrote: true; delivery: DeliveryRecord }
  | { updated: false; reason: DeliveryTransitionRejection; detail?: string }

export type DeliveryLedgerHealth =
  | 'healthy'
  | 'recovered'
  | 'faulted-read-only'
  /** Rename landed but directory durability was not confirmed. Restart to reload. */
  | 'write-uncertain'

export interface DeliverySnapshotProblem {
  path: string
  kind: 'missing' | 'unparsable' | 'unknown-version' | 'malformed'
  detail: string
}

export interface DeliveryLedgerFault {
  primary?: DeliverySnapshotProblem
  backup?: DeliverySnapshotProblem
}

export interface DeliveryLedgerLoadOutcome {
  health: Exclude<DeliveryLedgerHealth, 'write-uncertain'>
  from: 'primary' | 'backup' | 'empty' | 'none'
  messages: DeliveryMessage[]
  deliveries: DeliveryRecord[]
  fault?: DeliveryLedgerFault
}

export type DeliveryLedgerWriteStep =
  | 'write-temp'
  | 'fsync-temp'
  | 'write-backup-temp'
  | 'rename-primary'
  | 'rename-backup'
  | 'fsync-dir'

export interface DeliveryLedgerIo {
  open(path: string, flags: 'w' | 'r'): number
  writeBuffer(fd: number, data: Buffer): number
  fsync(fd: number): void
  close(fd: number): void
  rename(from: string, to: string): void
  readFile(path: string): Buffer
}

export const nodeDeliveryLedgerIo: DeliveryLedgerIo = {
  open: (path, flags) => openSync(path, flags),
  writeBuffer: (fd, data) => writeSync(fd, data),
  fsync: fd => { fsyncSync(fd) },
  close: fd => { closeSync(fd) },
  rename: (from, to) => { renameSync(from, to) },
  readFile: path => readFileSync(path),
}

export interface DeliveryLedgerOptions {
  dir?: string
  lockPath?: string
  io?: DeliveryLedgerIo
  hooks?: {
    beforeStep?: (
      step: DeliveryLedgerWriteStep,
    ) => void | Promise<void>
  }
  now?: () => number
  createMessageId?: () => string
  retentionMs?: number
  maxTerminalMessages?: number
  maxOutstandingDeliveries?: number
  maxHistoryEntries?: number
}

interface DeliveryLedgerSnapshot {
  version: typeof DELIVERY_LEDGER_SCHEMA_VERSION
  messages: DeliveryMessage[]
  deliveries: DeliveryRecord[]
}

type SnapshotRead =
  | { ok: true; snapshot: DeliveryLedgerSnapshot }
  | { ok: false; problem: DeliverySnapshotProblem }

interface HydratedLedger {
  outcome: DeliveryLedgerLoadOutcome
  copiesSynchronized: boolean
}

class AtomicWriteFailure extends Error {
  constructor(
    message: string,
    readonly primaryReplaced: boolean,
  ) {
    super(message)
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function safeErrorMessage(error: unknown): string {
  try {
    if (error && typeof error === 'object' && 'message' in error) {
      const message = String((error as { message: unknown }).message)
      if (message.length > 0) return message
    }
    const rendered = String(error)
    return rendered.length > 0 ? rendered : 'unknown capture failure'
  } catch {
    return 'unknown capture failure'
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isState(value: unknown): value is DeliveryState {
  return value === 'accepted'
    || value === 'pending'
    || value === 'in-flight'
    || value === 'delivered'
    || value === 'failed'
}

function hasSessionRefFields(value: unknown): value is DeliverySessionRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Partial<DeliverySessionRef>
  return nonEmpty(ref.sessionId) && nonEmpty(ref.incarnation)
}

function isSessionRef(value: unknown): value is DeliverySessionRef {
  return hasSessionRefFields(value)
    && hasOnlyKeys(value, SESSION_REF_KEYS)
}

function hasRecipientFields(value: unknown): value is DeliveryLedgerRecipient {
  if (!value || typeof value !== 'object') return false
  const recipient = value as Partial<DeliveryLedgerRecipient>
  return nonEmpty(recipient.providerId)
    && nonEmpty(recipient.sessionId)
    && nonEmpty(recipient.incarnation)
}

function isRecipient(value: unknown): value is DeliveryLedgerRecipient {
  return hasRecipientFields(value)
    && hasOnlyKeys(value, RECIPIENT_KEYS)
}

function hasEvidenceFields(value: unknown): value is DeliveryEvidence {
  if (!value || typeof value !== 'object') return false
  const evidence = value as Partial<DeliveryEvidence>
  if (!evidence.source || typeof evidence.source !== 'object') return false
  const source = evidence.source as Partial<DeliveryEvidence['source']>
  return nonEmpty(source.id)
    && nonEmpty(source.label)
    && (evidence.reference === undefined || typeof evidence.reference === 'string')
}

function isEvidence(value: unknown): value is DeliveryEvidence {
  return hasEvidenceFields(value)
    && hasOnlyKeys(value, EVIDENCE_KEYS)
    && hasOnlyKeys(value.source, EVIDENCE_SOURCE_KEYS)
}

function isStateEvent(value: unknown): value is DeliveryStateEvent {
  if (!value || typeof value !== 'object') return false
  if (!hasOnlyKeys(value, STATE_EVENT_KEYS)) return false
  const event = value as Partial<DeliveryStateEvent>
  if (!isState(event.state)
    || !Number.isInteger(event.attempt)
    || (event.attempt ?? -1) < 0
    || !isIsoTimestamp(event.at)) return false
  if (event.reason !== undefined && typeof event.reason !== 'string') return false
  if (event.retryAt !== undefined && !isIsoTimestamp(event.retryAt)) return false
  if (event.retryable !== undefined && typeof event.retryable !== 'boolean') return false
  if (event.attemptRef !== undefined && typeof event.attemptRef !== 'string') return false
  if (event.evidence !== undefined && !isEvidence(event.evidence)) return false
  if (event.state === 'failed') {
    return nonEmpty(event.reason) && typeof event.retryable === 'boolean'
  }
  return event.retryable === undefined
}

function isMessage(value: unknown): value is DeliveryMessage {
  if (!value || typeof value !== 'object') return false
  if (!hasOnlyKeys(value, MESSAGE_KEYS)) return false
  const message = value as Partial<DeliveryMessage>
  if (message.destination
    && typeof message.destination === 'object'
    && !hasOnlyKeys(message.destination, DESTINATION_KEYS)) return false
  return nonEmpty(message.id)
    && nonEmpty(message.requestId)
    && typeof message.requestFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(message.requestFingerprint)
    && isIsoTimestamp(message.acceptedAt)
    && isSessionRef(message.sender)
    && !!message.destination
    && typeof message.destination === 'object'
    && nonEmpty((message.destination as Partial<DeliveryDestination>).subject)
    && typeof message.text === 'string'
    && message.text.length > 0
    && Array.isArray(message.deliveryIds)
    && message.deliveryIds.length > 0
    && message.deliveryIds.every(nonEmpty)
    && new Set(message.deliveryIds).size === message.deliveryIds.length
}

function isDelivery(value: unknown): value is DeliveryRecord {
  if (!value || typeof value !== 'object') return false
  if (!hasOnlyKeys(value, DELIVERY_KEYS)) return false
  const delivery = value as Partial<DeliveryRecord>
  if (!nonEmpty(delivery.id)
    || !nonEmpty(delivery.messageId)
    || !isRecipient(delivery.recipient)
    || !isState(delivery.state)
    || !Number.isInteger(delivery.attempt)
    || (delivery.attempt ?? -1) < 0
    || !isIsoTimestamp(delivery.acceptedAt)
    || !isIsoTimestamp(delivery.updatedAt)
    || !Array.isArray(delivery.history)
    || delivery.history.length < 1
    || !delivery.history.every(isStateEvent)
    || typeof delivery.historyTruncated !== 'boolean') return false
  const first = delivery.history[0]!
  const last = delivery.history[delivery.history.length - 1]!
  if (first.state !== 'accepted'
    || first.attempt !== 0
    || first.at !== delivery.acceptedAt
    || last.state !== delivery.state
    || last.attempt !== delivery.attempt
    || last.at !== delivery.updatedAt) return false

  for (let index = 1; index < delivery.history.length; index++) {
    const previous = delivery.history[index - 1]!
    const event = delivery.history[index]!
    if (Date.parse(event.at) < Date.parse(previous.at)) return false
    if (delivery.historyTruncated && index === 1) continue
    if (transitionProblem({
      state: previous.state,
      attempt: previous.attempt,
      history: [previous],
    }, event) !== null) return false
  }
  return first.attempt === 0
}

function validateSnapshotRelations(
  snapshot: DeliveryLedgerSnapshot,
): string | null {
  const messageIds = new Set<string>()
  const requestIds = new Set<string>()
  const deliveryIds = new Set<string>()
  const deliveriesById = new Map<string, DeliveryRecord>()
  for (const message of snapshot.messages) {
    if (messageIds.has(message.id)) return `duplicate message id: ${message.id}`
    if (requestIds.has(message.requestId)) {
      return `duplicate request id: ${message.requestId}`
    }
    messageIds.add(message.id)
    requestIds.add(message.requestId)
  }
  for (const delivery of snapshot.deliveries) {
    if (deliveryIds.has(delivery.id)) {
      return `duplicate delivery id: ${delivery.id}`
    }
    deliveryIds.add(delivery.id)
    deliveriesById.set(delivery.id, delivery)
  }

  const referenced = new Set<string>()
  for (const message of snapshot.messages) {
    for (const id of message.deliveryIds) {
      const delivery = deliveriesById.get(id)
      if (!delivery) return `message ${message.id} references unknown delivery ${id}`
      if (delivery.messageId !== message.id) {
        return `delivery ${id} belongs to ${delivery.messageId}, not ${message.id}`
      }
      if (delivery.acceptedAt !== message.acceptedAt) {
        return `delivery ${id} has a different acceptance time than ${message.id}`
      }
      if (referenced.has(id)) return `delivery ${id} is referenced more than once`
      referenced.add(id)
    }
    const recipients = message.deliveryIds.map(id => deliveriesById.get(id)!.recipient)
    const fingerprint = requestFingerprint({
      requestId: message.requestId,
      sender: {
        sessionId: message.sender.sessionId,
        incarnation: message.sender.incarnation,
      },
      destination: { subject: message.destination.subject },
      text: message.text,
      recipients: normalizeRecipients(recipients),
    })
    if (fingerprint !== message.requestFingerprint) {
      return `message ${message.id} does not match its request fingerprint`
    }
  }
  if (referenced.size !== snapshot.deliveries.length) {
    return 'snapshot contains an orphan delivery'
  }
  return null
}

function parseSnapshot(raw: string, path: string): SnapshotRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      problem: {
        path,
        kind: 'unparsable',
        detail: (error as Error).message,
      },
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      problem: { path, kind: 'malformed', detail: 'snapshot is not an object' },
    }
  }
  const candidate = parsed as Partial<DeliveryLedgerSnapshot>
  if (candidate.version !== DELIVERY_LEDGER_SCHEMA_VERSION) {
    return {
      ok: false,
      problem: {
        path,
        kind: 'unknown-version',
        detail: `expected version ${DELIVERY_LEDGER_SCHEMA_VERSION}, got ${String(candidate.version)}`,
      },
    }
  }
  if (!Array.isArray(candidate.messages)
    || !Array.isArray(candidate.deliveries)
    || !candidate.messages.every(isMessage)
    || !candidate.deliveries.every(isDelivery)) {
    return {
      ok: false,
      problem: {
        path,
        kind: 'malformed',
        detail: 'messages or deliveries contain an invalid record',
      },
    }
  }
  const snapshot: DeliveryLedgerSnapshot = {
    version: DELIVERY_LEDGER_SCHEMA_VERSION,
    messages: candidate.messages,
    deliveries: candidate.deliveries,
  }
  const relationProblem = validateSnapshotRelations(snapshot)
  if (relationProblem) {
    return {
      ok: false,
      problem: { path, kind: 'malformed', detail: relationProblem },
    }
  }
  return { ok: true, snapshot }
}

function readSnapshot(path: string, io: DeliveryLedgerIo): SnapshotRead {
  try {
    return parseSnapshot(io.readFile(path).toString('utf8'), path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        problem: { path, kind: 'missing', detail: 'file does not exist' },
      }
    }
    return {
      ok: false,
      problem: {
        path,
        kind: 'unparsable',
        detail: (error as Error).message,
      },
    }
  }
}

function hydrate(
  paths: DeliveryLedgerPaths,
  io: DeliveryLedgerIo,
): HydratedLedger {
  const primary = readSnapshot(paths.primary, io)
  const backup = readSnapshot(paths.backup, io)
  if ((!primary.ok && primary.problem.kind === 'unknown-version')
    || (!backup.ok && backup.problem.kind === 'unknown-version')) {
    return {
      copiesSynchronized: false,
      outcome: {
        health: 'faulted-read-only',
        from: 'none',
        messages: [],
        deliveries: [],
        fault: {
          ...(!primary.ok ? { primary: primary.problem } : {}),
          ...(!backup.ok ? { backup: backup.problem } : {}),
        },
      },
    }
  }
  if (primary.ok) {
    const copiesSynchronized = backup.ok
      && serialize(primary.snapshot) === serialize(backup.snapshot)
    return {
      copiesSynchronized,
      outcome: {
        health: copiesSynchronized ? 'healthy' : 'recovered',
        from: 'primary',
        messages: primary.snapshot.messages,
        deliveries: primary.snapshot.deliveries,
      },
    }
  }
  if (backup.ok) {
    return {
      copiesSynchronized: false,
      outcome: {
        health: 'recovered',
        from: 'backup',
        messages: backup.snapshot.messages,
        deliveries: backup.snapshot.deliveries,
      },
    }
  }
  if (primary.problem.kind === 'missing' && backup.problem.kind === 'missing') {
    return {
      copiesSynchronized: false,
      outcome: {
        health: 'healthy',
        from: 'empty',
        messages: [],
        deliveries: [],
      },
    }
  }
  return {
    copiesSynchronized: false,
    outcome: {
      health: 'faulted-read-only',
      from: 'none',
      messages: [],
      deliveries: [],
      fault: { primary: primary.problem, backup: backup.problem },
    },
  }
}

function recipientKey(
  recipient: Pick<DeliveryLedgerRecipient, 'providerId' | 'sessionId'>,
): string {
  return JSON.stringify([recipient.providerId, recipient.sessionId])
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function normalizeRecipients(
  recipients: readonly DeliveryLedgerRecipient[],
): DeliveryLedgerRecipient[] {
  return recipients
    .map(recipient => ({
      providerId: recipient.providerId,
      sessionId: recipient.sessionId,
      incarnation: recipient.incarnation,
    }))
    .sort((a, b) => compareCodeUnits(recipientKey(a), recipientKey(b))
      || compareCodeUnits(a.incarnation, b.incarnation))
}

function requestFingerprint(
  input: Omit<DeliveryAcceptInput, 'recipients'> & {
    recipients: DeliveryLedgerRecipient[]
  },
): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
}

function acceptanceReceipt(message: DeliveryMessage): DeliveryAcceptanceReceipt {
  return {
    requestId: message.requestId,
    messageId: message.id,
    acceptedAt: message.acceptedAt,
    deliveryIds: [...message.deliveryIds],
  }
}

function validateAcceptInput(input: DeliveryAcceptInput): string | null {
  if (!input || typeof input !== 'object') return 'request must be an object'
  if (!nonEmpty(input.requestId)) return 'requestId must not be empty'
  if (!hasSessionRefFields(input.sender)) {
    return 'sender must name a session and incarnation'
  }
  if (!input.destination || !nonEmpty(input.destination.subject)) {
    return 'destination subject must not be empty'
  }
  if (typeof input.text !== 'string' || input.text.length < 1) {
    return 'text must not be empty'
  }
  if (!Array.isArray(input.recipients) || input.recipients.length < 1) {
    return 'at least one recipient is required'
  }
  if (!input.recipients.every(hasRecipientFields)) {
    return 'every recipient must be complete'
  }
  const keys = input.recipients.map(recipientKey)
  if (new Set(keys).size !== keys.length) {
    return 'recipient provider/session pairs must be unique'
  }
  return null
}

function validateTransitionInput(input: DeliveryTransitionInput): string | null {
  if (!input || typeof input !== 'object') return 'transition must be an object'
  if (!nonEmpty(input.deliveryId)) return 'deliveryId must not be empty'
  if (!input.expected || typeof input.expected !== 'object'
    || !isState(input.expected.state)
    || !Number.isInteger(input.expected.attempt)
    || input.expected.attempt < 0) return 'expected state or attempt is invalid'
  if (!input.next || typeof input.next !== 'object') return 'next event is required'
  if (input.next.reason !== undefined && typeof input.next.reason !== 'string') {
    return 'reason must be a string'
  }
  if (input.next.evidence !== undefined && !hasEvidenceFields(input.next.evidence)) {
    return 'evidence is malformed'
  }
  return null
}

function lastEvent(
  delivery: Pick<DeliveryRecord, 'history'>,
): DeliveryStateEvent {
  return delivery.history[delivery.history.length - 1]!
}

function isFinal(delivery: DeliveryRecord): boolean {
  if (delivery.state === 'delivered') return true
  return delivery.state === 'failed' && lastEvent(delivery).retryable === false
}

function transitionProblem(
  current: Pick<DeliveryRecord, 'state' | 'attempt' | 'history'>,
  next: Omit<DeliveryStateEvent, 'at'>,
): string | null {
  if (!isState(next.state)
    || !Number.isInteger(next.attempt)
    || next.attempt < 0) return 'next state or attempt is invalid'
  if (current.state === 'delivered') return 'delivered records are terminal'
  if (current.state === 'failed' && lastEvent(current).retryable === false) {
    return 'non-retryable failures are terminal'
  }
  const delta = next.attempt - current.attempt
  if (delta < 0 || delta > 1) return 'attempt must stay current or increment by one'
  if (delta === 1 && next.state !== 'in-flight') {
    return 'a new attempt must begin in-flight'
  }
  if (delta === 0
    && next.state === current.state
    && next.reason === lastEvent(current).reason
    && next.retryAt === lastEvent(current).retryAt) {
    return 'transition must change state or attempt metadata'
  }
  if ((next.state === 'in-flight' || next.state === 'delivered')
    && next.attempt < 1) return `${next.state} requires an attempt`
  if (next.state === 'accepted' && next.attempt < 1) {
    return 'provider acceptance requires an attempt'
  }
  if (next.state === 'failed') {
    if (!nonEmpty(next.reason) || typeof next.retryable !== 'boolean') {
      return 'failed transitions require reason and retryable'
    }
  } else if (next.retryable !== undefined) {
    return 'retryable is valid only on failed transitions'
  }
  if (next.retryAt !== undefined && !isIsoTimestamp(next.retryAt)) {
    return 'retryAt must be an ISO timestamp'
  }
  if (next.attemptRef !== undefined && typeof next.attemptRef !== 'string') {
    return 'attemptRef must be a string'
  }
  if (next.evidence !== undefined && !isEvidence(next.evidence)) {
    return 'evidence is malformed'
  }
  return null
}

function terminalUpdatedAt(
  message: DeliveryMessage,
  deliveries: Map<string, DeliveryRecord>,
): number | null {
  const records = message.deliveryIds.map(id => deliveries.get(id))
  if (records.some(record => !record || !isFinal(record))) return null
  return Math.max(...records.map(record => Date.parse(record!.updatedAt)))
}

function pruneTerminal(
  messages: Map<string, DeliveryMessage>,
  deliveries: Map<string, DeliveryRecord>,
  now: number,
  retentionMs: number,
  maxTerminalMessages: number,
): void {
  const terminal = [...messages.values()]
    .map(message => ({
      message,
      updatedAt: terminalUpdatedAt(message, deliveries),
    }))
    .filter((entry): entry is { message: DeliveryMessage; updatedAt: number } =>
      entry.updatedAt !== null)

  const remove = new Set(
    terminal
      .filter(entry => now - entry.updatedAt > retentionMs)
      .map(entry => entry.message.id),
  )
  const retained = terminal
    .filter(entry => !remove.has(entry.message.id))
    .sort((a, b) => a.updatedAt - b.updatedAt
      || a.message.id.localeCompare(b.message.id))
  for (let i = 0; i < retained.length - maxTerminalMessages; i++) {
    remove.add(retained[i]!.message.id)
  }
  for (const messageId of remove) {
    const message = messages.get(messageId)
    if (!message) continue
    for (const deliveryId of message.deliveryIds) deliveries.delete(deliveryId)
    messages.delete(messageId)
  }
}

function copyTransitionNext(
  next: Omit<DeliveryStateEvent, 'at'>,
): Omit<DeliveryStateEvent, 'at'> {
  const owned: Omit<DeliveryStateEvent, 'at'> = {
    state: next.state,
    attempt: next.attempt,
  }
  if (next.reason !== undefined) owned.reason = next.reason
  if (next.retryAt !== undefined) owned.retryAt = next.retryAt
  if (next.retryable !== undefined) owned.retryable = next.retryable
  if (next.attemptRef !== undefined) owned.attemptRef = next.attemptRef
  if (next.evidence !== undefined) {
    owned.evidence = {
      source: {
        id: next.evidence.source.id,
        label: next.evidence.source.label,
      },
      ...(next.evidence.reference !== undefined
        ? { reference: next.evidence.reference }
        : {}),
    }
  }
  return owned
}

function copyAcceptInput(input: DeliveryAcceptInput): DeliveryAcceptInput {
  return {
    requestId: input.requestId,
    sender: {
      sessionId: input.sender.sessionId,
      incarnation: input.sender.incarnation,
    },
    destination: { subject: input.destination.subject },
    text: input.text,
    recipients: input.recipients.map(recipient => ({
      providerId: recipient.providerId,
      sessionId: recipient.sessionId,
      incarnation: recipient.incarnation,
    })),
  }
}

function copyTransitionInput(input: DeliveryTransitionInput): DeliveryTransitionInput {
  return {
    deliveryId: input.deliveryId,
    expected: {
      state: input.expected.state,
      attempt: input.expected.attempt,
    },
    next: copyTransitionNext(input.next),
  }
}

function serialize(snapshot: DeliveryLedgerSnapshot): string {
  return JSON.stringify(snapshot, null, 2)
}

export class DeliveryLedger {
  private readonly paths: DeliveryLedgerPaths
  private readonly io: DeliveryLedgerIo
  private readonly hooks: DeliveryLedgerOptions['hooks']
  private readonly clock: () => number
  private readonly createId: () => string
  private readonly retentionMs: number
  private readonly maxTerminalMessages: number
  private readonly maxOutstandingDeliveries: number
  private readonly maxHistoryEntries: number
  private readonly loadOutcome: DeliveryLedgerLoadOutcome
  private currentHealth: DeliveryLedgerHealth
  private copiesSynchronized: boolean
  private messagesByRequestId = new Map<string, DeliveryMessage>()
  private acceptedMessageIds = new Set<string>()
  private messages = new Map<string, DeliveryMessage>()
  private deliveries = new Map<string, DeliveryRecord>()
  private lastSerialized: string | null = null
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(options: DeliveryLedgerOptions) {
    const dir = options.dir ?? getConfigRoot()
    const lockPath = options.lockPath ?? join(dir, 'server.lock')
    const owner = backendSingletonOwner(lockPath)
    if (owner === null) {
      throw new Error(
        `refusing to open the delivery ledger in ${dir}: `
        + `the backend singleton at ${lockPath} is not held`,
      )
    }
    if (owner !== process.pid) {
      throw new Error(
        `another tinstar backend is already running on ${dir} (pid ${owner})`,
      )
    }
    if ((options.retentionMs ?? TERMINAL_DELIVERY_RETENTION_MS) < 0) {
      throw new Error('delivery retention may not be negative')
    }
    if ((options.maxTerminalMessages ?? MAX_TERMINAL_MESSAGES) < 0) {
      throw new Error('terminal delivery count may not be negative')
    }
    if ((options.maxOutstandingDeliveries ?? MAX_OUTSTANDING_DELIVERIES) < 1) {
      throw new Error('outstanding delivery capacity must be at least one')
    }
    if ((options.maxHistoryEntries ?? MAX_HISTORY_ENTRIES) < 2) {
      throw new Error('delivery history must retain at least two entries')
    }

    this.paths = deliveryLedgerPaths(dir)
    this.io = options.io ?? nodeDeliveryLedgerIo
    this.hooks = options.hooks
    this.clock = options.now ?? Date.now
    this.createId = options.createMessageId ?? (() => `msg-${randomUUID()}`)
    this.retentionMs = options.retentionMs ?? TERMINAL_DELIVERY_RETENTION_MS
    this.maxTerminalMessages = options.maxTerminalMessages ?? MAX_TERMINAL_MESSAGES
    this.maxOutstandingDeliveries = options.maxOutstandingDeliveries
      ?? MAX_OUTSTANDING_DELIVERIES
    this.maxHistoryEntries = options.maxHistoryEntries ?? MAX_HISTORY_ENTRIES

    mkdirSync(dir, { recursive: true })
    const loaded = hydrate(this.paths, this.io)
    this.loadOutcome = loaded.outcome
    this.currentHealth = loaded.outcome.health
    this.copiesSynchronized = loaded.copiesSynchronized
    if (loaded.outcome.from === 'primary' || loaded.outcome.from === 'backup') {
      this.install({
        version: DELIVERY_LEDGER_SCHEMA_VERSION,
        messages: loaded.outcome.messages,
        deliveries: loaded.outcome.deliveries,
      })
    }
  }

  static open(options: DeliveryLedgerOptions = {}): DeliveryLedger {
    return new DeliveryLedger(options)
  }

  get health(): DeliveryLedgerHealth {
    return this.currentHealth
  }

  get outcome(): DeliveryLedgerLoadOutcome {
    return clone(this.loadOutcome)
  }

  get fault(): DeliveryLedgerFault | undefined {
    return this.loadOutcome.fault ? clone(this.loadOutcome.fault) : undefined
  }

  getMessage(messageId: string): DeliveryEnvelope | undefined {
    const message = this.messages.get(messageId)
    if (!message) return undefined
    const deliveries = message.deliveryIds
      .map(id => this.deliveries.get(id))
      .filter((delivery): delivery is DeliveryRecord => !!delivery)
    return clone({ message, deliveries })
  }

  getDelivery(deliveryId: string): DeliveryRecord | undefined {
    const delivery = this.deliveries.get(deliveryId)
    return delivery ? clone(delivery) : undefined
  }

  listRecoverable(): DeliveryRecord[] {
    return [...this.deliveries.values()]
      .filter(delivery => !isFinal(delivery))
      .sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt)
        || a.id.localeCompare(b.id))
      .map(clone)
  }

  accept(input: DeliveryAcceptInput): Promise<DeliveryAcceptResult> {
    let captured: DeliveryAcceptInput | undefined
    let captureProblem: string | null = null
    try {
      captureProblem = validateAcceptInput(input)
      if (!captureProblem) captured = copyAcceptInput(input)
    } catch (error) {
      captureProblem = `request could not be captured: ${safeErrorMessage(error)}`
    }
    return this.enqueue(async () => {
      const health = this.mutationHealthRejection()
      if (health) return { accepted: false, ...health }
      if (captureProblem || !captured) {
        return {
          accepted: false,
          reason: 'invalid-request',
          detail: captureProblem ?? 'request could not be captured',
        }
      }
      return this.runAccept(captured)
    })
  }

  transition(input: DeliveryTransitionInput): Promise<DeliveryTransitionResult> {
    let captured: DeliveryTransitionInput | undefined
    let captureProblem: string | null = null
    try {
      captureProblem = validateTransitionInput(input)
      if (!captureProblem) captured = copyTransitionInput(input)
    } catch (error) {
      captureProblem = `transition could not be captured: ${safeErrorMessage(error)}`
    }
    return this.enqueue(async () => {
      const health = this.mutationHealthRejection()
      if (health) return { updated: false, ...health }
      if (captureProblem || !captured) {
        return {
          updated: false,
          reason: 'invalid-transition',
          detail: captureProblem ?? 'transition could not be captured',
        }
      }
      return this.runTransition(captured)
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private mutationHealthRejection():
    | { reason: 'faulted-read-only' | 'write-uncertain' }
    | null {
    if (this.currentHealth === 'faulted-read-only') {
      return { reason: 'faulted-read-only' }
    }
    if (this.currentHealth === 'write-uncertain') {
      return { reason: 'write-uncertain' }
    }
    return null
  }

  private async runAccept(input: DeliveryAcceptInput): Promise<DeliveryAcceptResult> {
    const health = this.mutationHealthRejection()
    if (health) return { accepted: false, ...health }
    const invalid = validateAcceptInput(input)
    if (invalid) return { accepted: false, reason: 'invalid-request', detail: invalid }

    const recipients = normalizeRecipients(input.recipients)
    const normalized = {
      requestId: input.requestId,
      sender: {
        sessionId: input.sender.sessionId,
        incarnation: input.sender.incarnation,
      },
      destination: { subject: input.destination.subject },
      text: input.text,
      recipients,
    }
    const fingerprint = requestFingerprint(normalized)
    const prior = this.messagesByRequestId.get(input.requestId)
    if (prior) {
      if (prior.requestFingerprint !== fingerprint) {
        return {
          accepted: false,
          reason: 'request-id-reuse',
          detail: `request ${input.requestId} already belongs to message ${prior.id}`,
        }
      }
      let wrote = false
      if (!this.copiesSynchronized) {
        const persisted = await this.persist(this.snapshot())
        if (!persisted.ok) return { accepted: false, ...persisted.rejection }
        wrote = true
      }
      const envelope = this.getMessage(prior.id)
      if (!envelope) {
        this.currentHealth = 'faulted-read-only'
        return {
          accepted: false,
          reason: 'faulted-read-only',
          detail: `request ${prior.requestId} references a missing message`,
        }
      }
      return {
        accepted: true,
        replayed: true,
        wrote,
        details: 'retained',
        receipt: acceptanceReceipt(prior),
        ...envelope,
      }
    }

    const outstanding = [...this.deliveries.values()]
      .filter(delivery => !isFinal(delivery)).length
    if (outstanding + recipients.length > this.maxOutstandingDeliveries) {
      return {
        accepted: false,
        reason: 'capacity-exceeded',
        detail: `accepting ${recipients.length} recipient(s) would exceed `
          + `the ${this.maxOutstandingDeliveries} outstanding-delivery limit`,
      }
    }

    const messageId = this.allocateMessageId()
    if (!messageId) {
      return {
        accepted: false,
        reason: 'message-id-collision',
        detail: `could not allocate a unique message ID after ${MESSAGE_ID_ATTEMPTS} attempts`,
      }
    }
    const acceptedAt = new Date(this.clock()).toISOString()
    const deliveryRecords = recipients.map((recipient, index): DeliveryRecord => ({
      id: `${messageId}/d/${index + 1}`,
      messageId,
      recipient,
      state: 'accepted',
      attempt: 0,
      acceptedAt,
      updatedAt: acceptedAt,
      history: [{ state: 'accepted', attempt: 0, at: acceptedAt }],
      historyTruncated: false,
    }))
    const message: DeliveryMessage = {
      id: messageId,
      requestId: input.requestId,
      requestFingerprint: fingerprint,
      acceptedAt,
      sender: normalized.sender,
      destination: normalized.destination,
      text: normalized.text,
      deliveryIds: deliveryRecords.map(delivery => delivery.id),
    }
    const nextMessages = new Map(this.messages)
    const nextDeliveries = new Map(this.deliveries)
    nextMessages.set(message.id, message)
    for (const delivery of deliveryRecords) {
      nextDeliveries.set(delivery.id, delivery)
    }
    pruneTerminal(
      nextMessages,
      nextDeliveries,
      this.clock(),
      this.retentionMs,
      this.maxTerminalMessages,
    )
    const candidate = this.snapshot(nextMessages, nextDeliveries)
    const persisted = await this.persist(candidate)
    if (!persisted.ok) return { accepted: false, ...persisted.rejection }
    this.install(candidate, persisted.serialized)
    return {
      accepted: true,
      replayed: false,
      wrote: true,
      details: 'retained',
      receipt: acceptanceReceipt(message),
      message: clone(message),
      deliveries: clone(deliveryRecords),
    }
  }

  private async runTransition(
    input: DeliveryTransitionInput,
  ): Promise<DeliveryTransitionResult> {
    const health = this.mutationHealthRejection()
    if (health) return { updated: false, ...health }
    const shapeProblem = validateTransitionInput(input)
    if (shapeProblem) {
      return { updated: false, reason: 'invalid-transition', detail: shapeProblem }
    }
    const owned = copyTransitionInput(input)
    const current = this.deliveries.get(owned.deliveryId)
    if (!current) return { updated: false, reason: 'unknown-delivery' }
    if (current.state !== owned.expected.state
      || current.attempt !== owned.expected.attempt) {
      return {
        updated: false,
        reason: 'stale-delivery',
        detail: `expected ${owned.expected.state}/${owned.expected.attempt}, `
          + `found ${current.state}/${current.attempt}`,
      }
    }
    const invalid = transitionProblem(current, owned.next)
    if (invalid) {
      return { updated: false, reason: 'invalid-transition', detail: invalid }
    }

    const at = new Date(this.clock()).toISOString()
    const event: DeliveryStateEvent = { ...owned.next, at }
    const history = [...current.history, event]
    const truncated = history.length > this.maxHistoryEntries
    const boundedHistory = !truncated
      ? history
      : [history[0]!, ...history.slice(-(this.maxHistoryEntries - 1))]
    const updated: DeliveryRecord = {
      ...current,
      state: input.next.state,
      attempt: input.next.attempt,
      updatedAt: at,
      history: boundedHistory,
      historyTruncated: current.historyTruncated || truncated,
    }
    const nextMessages = new Map(this.messages)
    const nextDeliveries = new Map(this.deliveries)
    nextDeliveries.set(updated.id, updated)
    pruneTerminal(
      nextMessages,
      nextDeliveries,
      this.clock(),
      this.retentionMs,
      this.maxTerminalMessages,
    )
    const candidate = this.snapshot(nextMessages, nextDeliveries)
    const persisted = await this.persist(candidate)
    if (!persisted.ok) return { updated: false, ...persisted.rejection }
    this.install(candidate, persisted.serialized)
    return { updated: true, wrote: true, delivery: clone(updated) }
  }

  private allocateMessageId(): string | null {
    for (let attempt = 0; attempt < MESSAGE_ID_ATTEMPTS; attempt++) {
      const candidate = this.createId()
      if (nonEmpty(candidate) && !this.acceptedMessageIds.has(candidate)) return candidate
    }
    return null
  }

  private snapshot(
    messages: Map<string, DeliveryMessage> = this.messages,
    deliveries: Map<string, DeliveryRecord> = this.deliveries,
  ): DeliveryLedgerSnapshot {
    return {
      version: DELIVERY_LEDGER_SCHEMA_VERSION,
      messages: [...messages.values()],
      deliveries: [...deliveries.values()],
    }
  }

  private install(
    snapshot: DeliveryLedgerSnapshot,
    serialized: string = serialize(snapshot),
  ): void {
    this.messagesByRequestId = new Map(snapshot.messages.map(message => [
      message.requestId,
      message,
    ]))
    this.acceptedMessageIds = new Set(snapshot.messages.map(message => message.id))
    this.messages = new Map(snapshot.messages.map(message => [message.id, message]))
    this.deliveries = new Map(snapshot.deliveries.map(delivery => [delivery.id, delivery]))
    this.lastSerialized = serialized
  }

  private async persist(snapshot: DeliveryLedgerSnapshot): Promise<{
    ok: true
    serialized: string
  } | {
    ok: false
    rejection: {
      reason: 'write-failed' | 'write-uncertain'
      detail: string
    }
  }> {
    let serialized: string
    try {
      serialized = serialize(snapshot)
      const reparsed = parseSnapshot(serialized, '<candidate>')
      if (!reparsed.ok) {
        return {
          ok: false,
          rejection: { reason: 'write-failed', detail: reparsed.problem.detail },
        }
      }
    } catch (error) {
      return {
        ok: false,
        rejection: { reason: 'write-failed', detail: (error as Error).message },
      }
    }

    if (this.copiesSynchronized && serialized === this.lastSerialized) {
      return { ok: true, serialized }
    }
    try {
      await this.writeAtomically(serialized)
      this.copiesSynchronized = true
      this.currentHealth = 'healthy'
      this.lastSerialized = serialized
      return { ok: true, serialized }
    } catch (error) {
      const failure = error instanceof AtomicWriteFailure
        ? error
        : new AtomicWriteFailure((error as Error).message, false)
      if (failure.primaryReplaced) {
        this.currentHealth = 'write-uncertain'
        return {
          ok: false,
          rejection: { reason: 'write-uncertain', detail: failure.message },
        }
      }
      return {
        ok: false,
        rejection: { reason: 'write-failed', detail: failure.message },
      }
    }
  }

  private async writeAtomically(serialized: string): Promise<void> {
    let primaryReplaced = false
    try {
      await this.step('write-temp')
      const fd = this.io.open(this.paths.temp, 'w')
      try {
        this.writeAll(fd, Buffer.from(serialized))
        await this.step('fsync-temp')
        this.io.fsync(fd)
      } finally {
        this.io.close(fd)
      }

      await this.step('write-backup-temp')
      const backupFd = this.io.open(this.paths.backupTemp, 'w')
      try {
        this.writeAll(backupFd, Buffer.from(serialized))
        this.io.fsync(backupFd)
      } finally {
        this.io.close(backupFd)
      }

      await this.step('rename-primary')
      this.io.rename(this.paths.temp, this.paths.primary)
      primaryReplaced = true

      await this.step('rename-backup')
      this.io.rename(this.paths.backupTemp, this.paths.backup)

      await this.step('fsync-dir')
      this.fsyncDirectory()
    } catch (error) {
      throw new AtomicWriteFailure((error as Error).message, primaryReplaced)
    }
  }

  private writeAll(fd: number, data: Buffer): void {
    let offset = 0
    while (offset < data.length) {
      const remaining = data.subarray(offset)
      const written = this.io.writeBuffer(fd, remaining)
      if (!Number.isInteger(written) || written < 1 || written > remaining.length) {
        throw new Error(`filesystem write made invalid progress: ${String(written)}`)
      }
      offset += written
    }
  }

  private fsyncDirectory(): void {
    let fd: number | undefined
    try {
      fd = this.io.open(this.paths.dir, 'r')
      this.io.fsync(fd)
    } catch (error) {
      if (process.platform !== 'win32') throw error
    } finally {
      if (fd !== undefined) {
        try { this.io.close(fd) } catch { /* already closed */ }
      }
    }
  }

  private async step(step: DeliveryLedgerWriteStep): Promise<void> {
    await this.hooks?.beforeStep?.(step)
  }
}
