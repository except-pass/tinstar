import { parseDecisionPayload, type DecisionPayload } from './decision'
import { isRecord, parsed, rejected, requiredString, type ParseResult } from './result'

export const NEEDS_YOU_TYPES = [
  'decision',
  'blocked',
  'failure',
  'schedule-drift',
  'contradiction',
  'review-ready',
] as const

export type NeedsYouType = (typeof NEEDS_YOU_TYPES)[number]

export const NEEDS_YOU_STATES = ['open', 'answered', 'resolved'] as const
export type NeedsYouState = (typeof NEEDS_YOU_STATES)[number]

export const EXECUTION_IMPACTS = ['continues', 'blocked', 'unknown'] as const
export type ExecutionImpact = (typeof EXECUTION_IMPACTS)[number]

export const REVIEW_KINDS = ['pr', 'plan', 'report', 'other'] as const
export type ReviewKind = (typeof REVIEW_KINDS)[number]

/** Absent ancestors are omitted. A missing id is not stored as an empty string. */
export interface NeedsYouProvenance {
  initiativeId?: string
  epicId?: string
  taskId?: string
  workerId?: string
  planId?: string
}

export interface NeedsYouResponse {
  revision: string
  at: string
  body: Record<string, unknown>
}

export interface BlockedPayload {
  needed: string
  why: string
  attempts: string[]
  unblockCondition: string
}

export interface FailurePayload {
  operation: string
  error: string
  evidence: string
  attempts: string[]
  proposedNextAction: string
}

export interface ScheduleDriftPayload {
  plannedMs: number
  elapsedMs: number
  activity: string
  /** Explicit unknown is not the same as an empty progress string. */
  lastProgress: string | { unknown: true }
  evidence: string
  explanation: string
  continues: true
}

export interface ContradictionSide {
  claim: string
  evidence: string
  source: string
}

export interface ContradictionPayload {
  a: ContradictionSide
  b: ContradictionSide
  impact: string
  /** Present as a boolean. Not defaulted. */
  blocking: boolean
}

export interface ReviewReadyPullRequest {
  repo: string
  number: number
  url: string
}

export interface ReviewReadyPayload {
  kind: ReviewKind
  summary: string
  target: string
  pr?: ReviewReadyPullRequest
}

export type NeedsYouPayload =
  | DecisionPayload
  | BlockedPayload
  | FailurePayload
  | ScheduleDriftPayload
  | ContradictionPayload
  | ReviewReadyPayload

export interface NeedsYouItem {
  id: string
  type: NeedsYouType
  headline: string
  state: NeedsYouState
  provenance: NeedsYouProvenance
  createdAt: string
  updatedAt: string
  revision: string
  executionImpact: ExecutionImpact
  payload: NeedsYouPayload
  response: NeedsYouResponse | null
}

const PROVENANCE_KEYS = ['initiativeId', 'epicId', 'taskId', 'workerId', 'planId'] as const

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], field: string): ParseResult<T> {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    return rejected(`${field} is not a known value`)
  }
  return parsed(raw as T)
}

function stringList(raw: unknown, field: string): ParseResult<string[]> {
  if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) {
    return rejected(`${field} must be an array of strings`)
  }
  return parsed([...raw])
}

function httpsUrl(raw: unknown, field: string): ParseResult<string> {
  if (typeof raw !== 'string') return rejected(`${field} must be an https URL`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return rejected(`${field} must be an https URL`)
  }
  if (url.protocol !== 'https:') return rejected(`${field} must be an https URL`)
  return parsed(raw)
}

function parseProvenance(raw: unknown): ParseResult<NeedsYouProvenance> {
  if (raw === undefined) return parsed({})
  if (!isRecord(raw)) return rejected('provenance must be an object')
  const provenance: NeedsYouProvenance = {}
  for (const key of PROVENANCE_KEYS) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') continue
    if (typeof raw[key] !== 'string') return rejected(`provenance.${key} must be a string`)
    provenance[key] = raw[key]
  }
  return parsed(provenance)
}

function parseSide(raw: unknown, field: string): ParseResult<ContradictionSide> {
  if (!isRecord(raw)) return rejected(`${field} must be an object`)
  const claim = requiredString(raw.claim, `${field}.claim`)
  if (!claim.ok) return claim
  const evidence = requiredString(raw.evidence, `${field}.evidence`)
  if (!evidence.ok) return evidence
  const source = requiredString(raw.source, `${field}.source`)
  if (!source.ok) return source
  return parsed({ claim: claim.value, evidence: evidence.value, source: source.value })
}

function parseBlocked(raw: unknown): ParseResult<BlockedPayload> {
  if (!isRecord(raw)) return rejected('blocked payload must be an object')
  const needed = requiredString(raw.needed, 'needed')
  if (!needed.ok) return needed
  const why = requiredString(raw.why, 'why')
  if (!why.ok) return why
  const attempts = stringList(raw.attempts, 'attempts')
  if (!attempts.ok) return attempts
  const unblockCondition = requiredString(raw.unblockCondition, 'unblockCondition')
  if (!unblockCondition.ok) return unblockCondition
  return parsed({
    needed: needed.value,
    why: why.value,
    attempts: attempts.value,
    unblockCondition: unblockCondition.value,
  })
}

function parseFailure(raw: unknown): ParseResult<FailurePayload> {
  if (!isRecord(raw)) return rejected('failure payload must be an object')
  const operation = requiredString(raw.operation, 'operation')
  if (!operation.ok) return operation
  const error = requiredString(raw.error, 'error')
  if (!error.ok) return error
  const evidence = requiredString(raw.evidence, 'evidence')
  if (!evidence.ok) return evidence
  const attempts = stringList(raw.attempts, 'attempts')
  if (!attempts.ok) return attempts
  const proposedNextAction = requiredString(raw.proposedNextAction, 'proposedNextAction')
  if (!proposedNextAction.ok) return proposedNextAction
  return parsed({
    operation: operation.value,
    error: error.value,
    evidence: evidence.value,
    attempts: attempts.value,
    proposedNextAction: proposedNextAction.value,
  })
}

function parseScheduleDrift(raw: unknown): ParseResult<ScheduleDriftPayload> {
  if (!isRecord(raw)) return rejected('schedule-drift payload must be an object')
  if (typeof raw.plannedMs !== 'number' || !Number.isFinite(raw.plannedMs)) {
    return rejected('plannedMs must be a finite number')
  }
  if (typeof raw.elapsedMs !== 'number' || !Number.isFinite(raw.elapsedMs)) {
    return rejected('elapsedMs must be a finite number')
  }
  const activity = requiredString(raw.activity, 'activity')
  if (!activity.ok) return activity
  let lastProgress: ScheduleDriftPayload['lastProgress']
  if (isRecord(raw.lastProgress) && raw.lastProgress.unknown === true) {
    lastProgress = { unknown: true }
  } else if (typeof raw.lastProgress === 'string' && raw.lastProgress.length > 0) {
    lastProgress = raw.lastProgress
  } else {
    return rejected('lastProgress must be text or { unknown: true }')
  }
  const evidence = requiredString(raw.evidence, 'evidence')
  if (!evidence.ok) return evidence
  const explanation = requiredString(raw.explanation, 'explanation')
  if (!explanation.ok) return explanation
  if (raw.continues !== true) return rejected('schedule-drift continues must be true')
  return parsed({
    plannedMs: raw.plannedMs,
    elapsedMs: raw.elapsedMs,
    activity: activity.value,
    lastProgress,
    evidence: evidence.value,
    explanation: explanation.value,
    continues: true,
  })
}

function parseContradiction(raw: unknown): ParseResult<ContradictionPayload> {
  if (!isRecord(raw)) return rejected('contradiction payload must be an object')
  const a = parseSide(raw.a, 'a')
  if (!a.ok) return a
  const b = parseSide(raw.b, 'b')
  if (!b.ok) return b
  const impact = requiredString(raw.impact, 'impact')
  if (!impact.ok) return impact
  if (typeof raw.blocking !== 'boolean') return rejected('blocking must be a boolean')
  return parsed({ a: a.value, b: b.value, impact: impact.value, blocking: raw.blocking })
}

function parseReviewReady(raw: unknown): ParseResult<ReviewReadyPayload> {
  if (!isRecord(raw)) return rejected('review-ready payload must be an object')
  const kind = oneOf(raw.kind, REVIEW_KINDS, 'kind')
  if (!kind.ok) return kind
  const summary = requiredString(raw.summary, 'summary')
  if (!summary.ok) return summary
  const target = requiredString(raw.target, 'target')
  if (!target.ok) return target
  if (kind.value !== 'pr') {
    return parsed({ kind: kind.value, summary: summary.value, target: target.value })
  }
  if (!isRecord(raw.pr)) return rejected('a pull request review needs pr.repo, pr.number, and pr.url')
  const repo = requiredString(raw.pr.repo, 'pr.repo')
  if (!repo.ok) return repo
  if (typeof raw.pr.number !== 'number' || !Number.isInteger(raw.pr.number) || raw.pr.number <= 0) {
    return rejected('pr.number must be a positive integer')
  }
  const url = httpsUrl(raw.pr.url, 'pr.url')
  if (!url.ok) return url
  return parsed({
    kind: 'pr',
    summary: summary.value,
    target: target.value,
    pr: { repo: repo.value, number: raw.pr.number, url: url.value },
  })
}

function parsePayload(type: NeedsYouType, raw: unknown): ParseResult<NeedsYouPayload> {
  switch (type) {
    case 'decision':
      return parseDecisionPayload(raw)
    case 'blocked':
      return parseBlocked(raw)
    case 'failure':
      return parseFailure(raw)
    case 'schedule-drift':
      return parseScheduleDrift(raw)
    case 'contradiction':
      return parseContradiction(raw)
    case 'review-ready':
      return parseReviewReady(raw)
  }
}

export function parseNeedsYouItem(raw: unknown): ParseResult<NeedsYouItem> {
  if (!isRecord(raw)) return rejected('needs you item must be an object')
  const id = requiredString(raw.id, 'id')
  if (!id.ok) return id
  const type = oneOf(raw.type, NEEDS_YOU_TYPES, 'type')
  if (!type.ok) return type
  const headline = requiredString(raw.headline, 'headline')
  if (!headline.ok) return headline
  const state = oneOf(raw.state, NEEDS_YOU_STATES, 'state')
  if (!state.ok) return state
  const provenance = parseProvenance(raw.provenance)
  if (!provenance.ok) return provenance
  const createdAt = requiredString(raw.createdAt, 'createdAt')
  if (!createdAt.ok) return createdAt
  const updatedAt = requiredString(raw.updatedAt, 'updatedAt')
  if (!updatedAt.ok) return updatedAt
  const revision = requiredString(raw.revision, 'revision')
  if (!revision.ok) return revision
  const executionImpact = oneOf(raw.executionImpact, EXECUTION_IMPACTS, 'executionImpact')
  if (!executionImpact.ok) return executionImpact
  const payload = parsePayload(type.value, raw.payload)
  if (!payload.ok) return payload
  let response: NeedsYouResponse | null = null
  if (raw.response !== undefined && raw.response !== null) {
    if (!isRecord(raw.response)) return rejected('response must be an object')
    const responseRevision = requiredString(raw.response.revision, 'response.revision')
    if (!responseRevision.ok) return responseRevision
    const at = requiredString(raw.response.at, 'response.at')
    if (!at.ok) return at
    if (!isRecord(raw.response.body)) return rejected('response.body must be an object')
    response = { revision: responseRevision.value, at: at.value, body: raw.response.body }
  }
  return parsed({
    id: id.value,
    type: type.value,
    headline: headline.value,
    state: state.value,
    provenance: provenance.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    revision: revision.value,
    executionImpact: executionImpact.value,
    payload: payload.value,
    response,
  })
}

/** Answered is not resolved. A link click is not a response. */
export function isNeedsYouResolved(item: Pick<NeedsYouItem, 'state'>): boolean {
  return item.state === 'resolved'
}
