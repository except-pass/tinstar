import { isRecord, parsed, rejected, requiredString, type ParseResult } from './result'

export const INTENT_SCHEMA = 'tinstar.v6.intent/1' as const
export const RECEIPT_SCHEMA = 'tinstar.v6.receipt/1' as const

export const INTENT_KINDS = [
  'thread.message',
  'portfolio.mutate',
  'column.mutate',
  'objective.set',
  'attention.answer',
  'launch.request',
  'schedule.acknowledge',
] as const

export type IntentKind = (typeof INTENT_KINDS)[number]

export const ANCHOR_TYPES = ['worker', 'epic', 'task', 'plan', 'needsyou', 'selection'] as const

export type AnchorType = (typeof ANCHOR_TYPES)[number]

export interface IntentAnchor {
  type: AnchorType
  ids: string[]
}

export interface IntentEnvelope {
  schema: typeof INTENT_SCHEMA
  kind: IntentKind
  requestId: string
  revision: string | null
  anchor: IntentAnchor
  body: Record<string, unknown>
}

export const RECEIPT_OUTCOMES = ['applied', 'rejected'] as const

export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number]

export interface AppliedReceipt {
  schema: typeof RECEIPT_SCHEMA
  requestId: string
  outcome: ReceiptOutcome
  detail: string
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], field: string): ParseResult<T> {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    return rejected(`${field} is not a known value`)
  }
  return parsed(raw as T)
}

export function parseIntentEnvelope(raw: unknown): ParseResult<IntentEnvelope> {
  if (!isRecord(raw)) return rejected('intent must be an object')
  if (raw.schema !== INTENT_SCHEMA) return rejected(`schema must be ${INTENT_SCHEMA}`)
  const kind = oneOf(raw.kind, INTENT_KINDS, 'kind')
  if (!kind.ok) return kind
  const requestId = requiredString(raw.requestId, 'requestId')
  if (!requestId.ok) return requestId
  if (raw.revision !== null && typeof raw.revision !== 'string') {
    return rejected('revision must be a string or null')
  }
  if (!isRecord(raw.anchor)) return rejected('anchor must be an object')
  const anchorType = oneOf(raw.anchor.type, ANCHOR_TYPES, 'anchor.type')
  if (!anchorType.ok) return anchorType
  if (!Array.isArray(raw.anchor.ids) || raw.anchor.ids.some(id => typeof id !== 'string' || id.length === 0)) {
    return rejected('anchor.ids must be non-empty strings')
  }
  if (!isRecord(raw.body)) return rejected('body must be an object')
  return parsed({
    schema: INTENT_SCHEMA,
    kind: kind.value,
    requestId: requestId.value,
    revision: raw.revision,
    anchor: { type: anchorType.value, ids: [...raw.anchor.ids] },
    body: raw.body,
  })
}

/** Human prose stays prose. Only this schema moves a row to applied or rejected. */
export function parseAppliedReceipt(raw: unknown): ParseResult<AppliedReceipt> {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      return rejected('reply is not a receipt')
    }
  }
  if (!isRecord(value)) return rejected('receipt must be an object')
  if (value.schema !== RECEIPT_SCHEMA) return rejected(`schema must be ${RECEIPT_SCHEMA}`)
  const requestId = requiredString(value.requestId, 'requestId')
  if (!requestId.ok) return requestId
  const outcome = oneOf(value.outcome, RECEIPT_OUTCOMES, 'outcome')
  if (!outcome.ok) return outcome
  if (typeof value.detail !== 'string') return rejected('detail must be a string')
  return parsed({
    schema: RECEIPT_SCHEMA,
    requestId: requestId.value,
    outcome: outcome.value,
    detail: value.detail,
  })
}
