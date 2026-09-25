import {
  INTENT_SCHEMA,
  type AppliedReceipt,
  type IntentEnvelope,
  type IntentKind,
} from '../contract/intent'
import {
  parseNeedsYouItem,
  type ExecutionImpact,
  type NeedsYouItem,
  type NeedsYouState,
  type NeedsYouType,
} from '../contract/needsyou'
import { isRecord } from '../contract/result'
import type { DecisionPayload, ScaleWord } from '../contract/decision'

export const NEEDS_YOU_STORE_SCHEMA = 'tinstar.v6.needsyou/1' as const

export const DELIVERIES = [
  'unanswered',
  'queued',
  'saved-unannounced',
  'not-receivable',
  'applied',
  'rejected',
  'failed',
] as const

export type Delivery = (typeof DELIVERIES)[number]

export const TYPE_LABEL: Record<NeedsYouType, string> = {
  decision: 'Decision',
  blocked: 'Blocked',
  failure: 'Failure',
  'schedule-drift': 'Schedule drift',
  contradiction: 'Contradiction',
  'review-ready': 'Review ready',
}

/** Transport result from the shell inbox client. A note is never applied. */
export interface InboxSubmission {
  requestId: string
  noteId: string | null
  disposition: 'queued' | 'saved-unannounced' | 'not-receivable' | 'failed'
  applied: false
  detail: string
}

export interface AttentionAcknowledgement {
  requestId: string
  at: string
  delivery: Exclude<Delivery, 'unanswered'>
}

export interface AttentionRow {
  fixture: boolean
  ci?: string
  /** Parsed item. Scale words are objects; do not run this through the parser again. */
  item: NeedsYouItem
  /** Wire item as submitted. This is what the browser parses. */
  wire: Record<string, unknown>
  delivery: Delivery
  answerRequestId: string | null
  spentRequestIds: string[]
  lastError: string | null
  receiptDetail: string | null
  acknowledgement: AttentionAcknowledgement | null
}

export type RailEntry =
  | { kind: 'item'; row: AttentionRow }
  | { kind: 'diagnostic'; id: string; fixture: boolean; diagnostic: string }

export type AnswerKind = Extract<IntentKind, 'attention.answer' | 'schedule.acknowledge'>

const REFUSED_BODY_KEYS = new Set(['command', 'shell', 'argv', 'tmux'])

export function requestIdAllowed(id: string): boolean {
  if (id.length === 0 || id.length > 128 || id.startsWith('.')) return false
  return /^[A-Za-z0-9._:-]+$/.test(id)
}

export function newRequestId(): string {
  return `ny-${crypto.randomUUID()}`
}

export function emptyRow(item: NeedsYouItem, fixture: boolean, ci?: string, wire?: Record<string, unknown>): AttentionRow {
  const row: AttentionRow = {
    fixture,
    item,
    wire: { ...(wire ?? {}) },
    delivery: 'unanswered',
    answerRequestId: null,
    spentRequestIds: [],
    lastError: null,
    receiptDetail: null,
    acknowledgement: null,
  }
  if (ci !== undefined) row.ci = ci
  return row
}

function syncWire(wire: Record<string, unknown>, item: NeedsYouItem): Record<string, unknown> {
  return {
    ...wire,
    state: item.state,
    updatedAt: item.updatedAt,
    revision: item.revision,
    headline: item.headline,
    response: item.response,
  }
}

function readCi(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.ci === 'string') return raw.ci
  if (isRecord(raw.payload) && typeof raw.payload.ci === 'string') return raw.payload.ci
  if (isRecord(raw.item) && isRecord(raw.item.payload) && typeof raw.item.payload.ci === 'string') {
    return raw.item.payload.ci
  }
  return undefined
}

function asDelivery(raw: unknown): Delivery {
  return typeof raw === 'string' && (DELIVERIES as readonly string[]).includes(raw) ? raw as Delivery : 'unanswered'
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}

function rowFromStored(raw: Record<string, unknown>, item: NeedsYouItem, fixture: boolean): AttentionRow {
  const ci = readCi(raw)
  const acknowledgement = isRecord(raw.acknowledgement)
    && typeof raw.acknowledgement.requestId === 'string'
    && typeof raw.acknowledgement.at === 'string'
    ? {
        requestId: raw.acknowledgement.requestId,
        at: raw.acknowledgement.at,
        delivery: asDelivery(raw.acknowledgement.delivery) === 'unanswered'
          ? 'failed' as const
          : asDelivery(raw.acknowledgement.delivery) as Exclude<Delivery, 'unanswered'>,
      }
    : null
  const wire = isRecord(raw.wire) ? raw.wire : isRecord(raw.item) ? raw.item : {}
  const row: AttentionRow = {
    fixture,
    item,
    wire,
    delivery: asDelivery(raw.delivery),
    answerRequestId: typeof raw.answerRequestId === 'string' ? raw.answerRequestId : null,
    spentRequestIds: stringList(raw.spentRequestIds),
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    receiptDetail: typeof raw.receiptDetail === 'string' ? raw.receiptDetail : null,
    acknowledgement,
  }
  if (ci !== undefined) row.ci = ci
  return row
}

/** Fail closed. A decision with fewer than two options becomes a diagnostic. */
export function readEntry(raw: unknown, index = 0): RailEntry {
  if (!isRecord(raw)) {
    return { kind: 'diagnostic', id: `malformed-${index}`, fixture: false, diagnostic: 'needs you item must be an object' }
  }
  const fixture = raw.fixture === true
  if (isRecord(raw.item) && typeof raw.delivery === 'string') {
    const parsed = parseNeedsYouItem(raw.item)
    if (!parsed.ok) {
      const id = typeof raw.item.id === 'string' ? raw.item.id : `malformed-${index}`
      return { kind: 'diagnostic', id, fixture, diagnostic: parsed.diagnostic }
    }
    return { kind: 'item', row: rowFromStored(raw, parsed.value, fixture) }
  }
  const parsed = parseNeedsYouItem(raw)
  if (!parsed.ok) {
    const id = typeof raw.id === 'string' ? raw.id : `malformed-${index}`
    return { kind: 'diagnostic', id, fixture, diagnostic: parsed.diagnostic }
  }
  return { kind: 'item', row: emptyRow(parsed.value, fixture, readCi(raw), raw) }
}

export function visibleStatus(row: Pick<AttentionRow, 'item' | 'delivery'>): string {
  if (row.item.state === 'resolved') return 'resolved'
  switch (row.delivery) {
    case 'unanswered':
      return 'unanswered'
    case 'queued':
      return 'queued'
    case 'saved-unannounced':
      return 'saved, not announced'
    case 'not-receivable':
      return 'not receivable'
    case 'applied':
      return 'applied'
    case 'rejected':
      return 'rejected'
    case 'failed':
      return 'failed'
  }
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown'
  const sign = ms < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(ms))
  const hours = Math.floor(abs / 3_600_000)
  const minutes = Math.floor((abs % 3_600_000) / 60_000)
  if (hours > 0) return `${sign}${hours}h ${minutes}m`
  return `${sign}${minutes}m`
}

export function scaleText(word: ScaleWord | null, label: string): { text: string; known: boolean | null } {
  if (!word) return { text: `${label}: not set`, known: null }
  if (!word.known) return { text: `${label}: ${word.value} (unknown)`, known: false }
  return { text: `${label}: ${word.value}`, known: true }
}

function refusedKey(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) {
    if (REFUSED_BODY_KEYS.has(key)) return key
  }
  return null
}

export type PreparedAnswer =
  | { ok: true; envelope: IntentEnvelope }
  | { ok: false; applied: false; diagnostic: string }

function reject(diagnostic: string): PreparedAnswer {
  return { ok: false, applied: false, diagnostic }
}

function envelope(kind: AnswerKind, requestId: string, revision: string, itemId: string, body: Record<string, unknown>): PreparedAnswer {
  return {
    ok: true,
    envelope: {
      schema: INTENT_SCHEMA,
      kind,
      requestId,
      revision,
      anchor: { type: 'needsyou', ids: [itemId] },
      body,
    },
  }
}

function decisionBody(item: NeedsYouItem, body: Record<string, unknown>): PreparedAnswer | { fields: Record<string, unknown> } {
  const payload = item.payload as DecisionPayload
  if (!('options' in payload) || !Array.isArray(payload.options)) return reject('decision payload is missing options')
  const optionId = body.optionId
  if (typeof optionId !== 'string' || optionId.length === 0) return reject('optionId must be one of the offered options')
  if (!payload.options.some(option => option.id === optionId)) {
    return reject(`optionId ${optionId} is not an offered option`)
  }
  if (body.comment !== undefined && typeof body.comment !== 'string') return reject('comment must be a string')
  return { fields: { optionId, comment: typeof body.comment === 'string' ? body.comment : '' } }
}

/**
 * Build an inbox envelope for the revision the caller saw.
 * A mismatch is rejected here, before any note is written.
 */
export function prepareAnswer(input: {
  item: NeedsYouItem
  seenRevision: string
  requestId: string
  kind: AnswerKind
  body: Record<string, unknown>
}): PreparedAnswer {
  if (!isRecord(input.body)) return reject('body must be an object')
  const refused = refusedKey(input.body)
  if (refused) return reject(`${refused} is not accepted`)
  if (!requestIdAllowed(input.requestId)) return reject('requestId is not a valid inbox request id')
  if (input.seenRevision !== input.item.revision) {
    return reject('revision mismatch')
  }
  if (input.kind === 'schedule.acknowledge') {
    if (input.item.type !== 'schedule-drift') return reject('schedule.acknowledge applies to schedule drift')
    return envelope(input.kind, input.requestId, input.seenRevision, input.item.id, { acknowledge: true })
  }
  if (input.item.type === 'review-ready') return reject('opening a review is not an answer')
  if (input.item.type === 'schedule-drift') return reject('schedule drift uses schedule.acknowledge')
  let body: Record<string, unknown>
  if (input.item.type === 'decision') {
    const built = decisionBody(input.item, input.body)
    if ('ok' in built) return built
    body = built.fields
  } else if (input.item.type === 'blocked') {
    if (typeof input.body.supplied !== 'string' || input.body.supplied.trim().length === 0) {
      return reject('supplied must be a non-empty string')
    }
    body = { supplied: input.body.supplied }
  } else if (input.item.type === 'failure') {
    if (input.body.action !== 'retry') return reject('failure recovery action must be retry')
    const payload = input.item.payload as { operation: string; proposedNextAction: string }
    body = { action: 'retry', operation: payload.operation, proposedNextAction: payload.proposedNextAction }
  } else if (input.item.type === 'contradiction') {
    if (typeof input.body.judgment !== 'string' || input.body.judgment.trim().length === 0) {
      return reject('judgment must be a non-empty string')
    }
    body = { judgment: input.body.judgment }
  } else {
    return reject('this attention type has no answer')
  }
  return envelope('attention.answer', input.requestId, input.seenRevision, input.item.id, body)
}

function mapDelivery(disposition: InboxSubmission['disposition']): Exclude<Delivery, 'unanswered' | 'applied' | 'rejected'> {
  if (disposition === 'queued') return 'queued'
  if (disposition === 'saved-unannounced') return 'saved-unannounced'
  if (disposition === 'not-receivable') return 'not-receivable'
  return 'failed'
}

/** Project a submission onto a row. Receipts, not this function, mark applied. */
export function projectSubmission(row: AttentionRow, prepared: Extract<PreparedAnswer, { ok: true }>, submission: InboxSubmission, at: string): AttentionRow {
  const requestId = submission.requestId || prepared.envelope.requestId
  const saved = typeof submission.noteId === 'string' && submission.noteId.length > 0 && submission.disposition !== 'failed'
  if (!saved) {
    return {
      ...row,
      answerRequestId: requestId,
      delivery: 'failed',
      lastError: submission.detail || 'nothing saved',
    }
  }
  const delivery = mapDelivery(submission.disposition)
  if (prepared.envelope.kind === 'schedule.acknowledge') {
    return {
      ...row,
      lastError: delivery === 'queued' ? null : submission.detail,
      acknowledgement: { requestId, at, delivery },
    }
  }
  const item: NeedsYouItem = {
    ...row.item,
    state: 'answered',
    updatedAt: at,
    response: {
      revision: prepared.envelope.revision ?? row.item.revision,
      at,
      body: prepared.envelope.body,
    },
  }
  return {
    ...row,
    lastError: delivery === 'queued' ? null : submission.detail,
    delivery,
    answerRequestId: requestId,
    item,
    wire: syncWire(row.wire, item),
  }
}

export function mergeObservation(prev: AttentionRow | undefined, next: AttentionRow): AttentionRow {
  if (!prev) return next
  if (prev.item.revision !== next.item.revision) {
    return {
      ...next,
      spentRequestIds: prev.spentRequestIds,
      delivery: 'unanswered',
      answerRequestId: null,
      lastError: null,
      receiptDetail: null,
      acknowledgement: null,
    }
  }
  const fixture = next.fixture || prev.fixture
  const ci = next.ci ?? prev.ci
  if (next.item.state === 'resolved' || next.item.response) {
    const row: AttentionRow = {
      ...next,
      fixture,
      spentRequestIds: prev.spentRequestIds,
      answerRequestId: prev.answerRequestId,
      acknowledgement: prev.acknowledgement,
      receiptDetail: prev.receiptDetail,
      delivery: next.item.state === 'resolved' ? 'unanswered' : prev.delivery,
    }
    if (ci !== undefined) row.ci = ci
    return row
  }
  if (prev.item.response) {
    const item: NeedsYouItem = {
      ...next.item,
      state: prev.item.state,
      response: prev.item.response,
      updatedAt: prev.item.updatedAt,
    }
    const row: AttentionRow = {
      ...next,
      fixture,
      spentRequestIds: prev.spentRequestIds,
      delivery: prev.delivery,
      answerRequestId: prev.answerRequestId,
      lastError: prev.lastError,
      receiptDetail: prev.receiptDetail,
      acknowledgement: prev.acknowledgement,
      item,
      wire: syncWire(next.wire, item),
    }
    if (ci !== undefined) row.ci = ci
    return row
  }
  const row: AttentionRow = {
    ...next,
    fixture,
    spentRequestIds: prev.spentRequestIds,
    acknowledgement: prev.acknowledgement,
  }
  if (ci !== undefined) row.ci = ci
  return row
}

export function upsertRow(items: readonly AttentionRow[], next: AttentionRow): AttentionRow[] {
  const index = items.findIndex(row => row.item.id === next.item.id)
  if (index < 0) return [...items, next]
  const copy = items.slice()
  copy[index] = mergeObservation(items[index], next)
  return copy
}

export function applyReceipt(items: readonly AttentionRow[], receipt: AppliedReceipt): { items: AttentionRow[]; changed: boolean; detail: string } {
  const index = items.findIndex(row => row.answerRequestId === receipt.requestId)
  if (index < 0) return { items: [...items], changed: false, detail: 'no matching answer' }
  const row = items[index]
  if (!row) return { items: [...items], changed: false, detail: 'no matching answer' }
  if (row.spentRequestIds.includes(receipt.requestId) || row.delivery === 'applied' || row.delivery === 'rejected') {
    return { items: [...items], changed: false, detail: 'already applied' }
  }
  const copy = items.slice()
  copy[index] = {
    ...row,
    delivery: receipt.outcome,
    spentRequestIds: [...row.spentRequestIds, receipt.requestId],
    receiptDetail: receipt.detail,
    lastError: receipt.outcome === 'rejected' ? receipt.detail : null,
  }
  return { items: copy, changed: true, detail: receipt.detail }
}

export function originParts(item: NeedsYouItem): string[] {
  const provenance = item.provenance
  const parts: string[] = []
  if (provenance.initiativeId) parts.push(`initiative ${provenance.initiativeId}`)
  if (provenance.epicId) parts.push(`epic ${provenance.epicId}`)
  if (provenance.taskId) parts.push(`task ${provenance.taskId}`)
  if (provenance.workerId) parts.push(`worker ${provenance.workerId}`)
  if (provenance.planId) parts.push(`plan ${provenance.planId}`)
  return parts
}

export function impactLabel(impact: ExecutionImpact): string {
  if (impact === 'continues') return 'impact continues'
  if (impact === 'blocked') return 'impact blocked'
  return 'impact unknown'
}

export type { NeedsYouState }
