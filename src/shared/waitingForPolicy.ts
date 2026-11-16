import { checkInTime } from './checkIn'
import { isJiraCard } from './workIdentity'

/** One Waiting For policy for writes and read-side diagnostics.
 * Waiting For is an independent blocker. Queue position and a missing worker stay Queued. */
export const waitingForTypes = ['Actor', 'Event', 'Work'] as const
export type WaitingForType = typeof waitingForTypes[number]
export type SourceCoverage = 'complete' | 'partial' | 'unknown'

export interface WaitIssue { code: string; field: string; message: string }
export interface WaitingForException {
  card_id: string
  field: string
  reason: string
  observed_at: string | null
  coverage: SourceCoverage
}

const NOTION_ID = /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i
const DISPATCH = [
  /\b(waiting for|wait for|pending)\b.{0,80}\b(worker|mate|first\s*mate|hilda|pickup|pick up)\b/i,
  /\b(hilda|first\s*mate|firstmate)\b.{0,60}\b(start|attach|pick(?:ing)?\s*up|pickup|assign)\b/i,
  /\b(worker|mate)\b.{0,40}\b(start(?:ing|ed)?|attach(?:ing|ed)?|pick(?:ing)?\s*up|pickup|assign(?:ed|ing)?)\b/i,
  /\bqueued behind\b/i,
  /\bbehind other (?:tasks|work|cards|items)\b/i,
  /\bfirst\s*mate to pick up\b/i,
  /\bwaiting for (?:a |the )?worker\b/i,
]
const PLACEHOLDER = /^(?:first\s*mate|firstmate|hilda(?:\s+mate)?|a worker|the worker|worker|mate|tbd|n\/a|na|unknown|none|pending|waiting|todo|queue|queued)$/i
const SCHEDULE_WORD = /\b(next|check-?in|check|in|on|at|date|the|a|an|waiting|wait|for|until|by|scheduled|arbitrary|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|et|eastern)\b/gi

export const DISPATCH_WAIT_REASON = 'Waiting For must name an independent blocker: a person, team, vendor, an event that happens on its own, or another unfinished card. Waiting for a worker to be assigned, started, or attached, for First Mate to pick up, for a place in the queue, or for a check-in date alone does not qualify.'

export function canonicalWorkId(id: string): string | null {
  if (isJiraCard(id)) return id
  return NOTION_ID.test(id) ? id.replaceAll('-', '').toLowerCase() : null
}

export function coverageFromObservation(status?: string, coverage?: string): SourceCoverage {
  if (status === 'fresh' && coverage === 'complete') return 'complete'
  if (status === 'fresh' && coverage === 'partial') return 'partial'
  return 'unknown'
}

const entryText = (text: string) => /[\r\n]/.test(text) ? JSON.stringify(text) : text

/** The exact Waiting For line a later resolve must match. */
export function waitLine(value: { dependency: string; unblocks_when: string; follow_up_by: string; type: string; id: string }): string {
  return `Dependency: ${entryText(value.dependency)} | Unblocks when: ${entryText(value.unblocks_when)} | Follow-up: ${entryText(value.follow_up_by)} | Type: ${value.type} | ID: ${entryText(value.id)}`
}

export function parseWaitLine(line: string): { type: WaitingForType; id: string } | null {
  const match = / \| Type: (Actor|Event|Work) \| ID: ([\s\S]*)$/.exec(line)
  if (!match) return null
  const id = match[2]!.startsWith('"') ? (() => { try { const parsed = JSON.parse(match[2]!) ; return typeof parsed === 'string' ? parsed : match[2]! } catch { return match[2]! } })() : match[2]!
  return { type: match[1] as WaitingForType, id }
}

function scheduleOnly(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (!/\b(?:check-?\s*in|checkpoint)\b/i.test(trimmed) && !/^\d{4}-\d{2}-\d{2}(?:[t ]|\b)/i.test(trimmed)) return false
  const residue = trimmed.replace(SCHEDULE_WORD, ' ').replace(/\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:z|[+-]\d{2}:?\d{2})?)?/gi, ' ').replace(/\b\d{1,2}(?::\d{2})?\b/g, ' ').replace(/[^a-z]+/gi, ' ').trim()
  return residue.length === 0
}

/** True when the text gives no independent prerequisite. Follow-up owner is not part of this check. */
export function dispatchOnlyWait(dependency: string, unblocksWhen: string, id: string): boolean {
  const text = `${dependency}\n${unblocksWhen}`
  void id
  return DISPATCH.some(pattern => pattern.test(text)) || scheduleOnly(dependency) || scheduleOnly(unblocksWhen)
}

export function independentWaitIssue(wait: { type: string; id: string; dependency: string; unblocks_when: string }): WaitIssue | null {
  const dependency = wait.dependency.trim(), id = wait.id.trim()
  if (PLACEHOLDER.test(dependency) || PLACEHOLDER.test(id)) {
    return { code: 'placeholder-blocker', field: PLACEHOLDER.test(dependency) ? 'dependency' : 'id', message: `${DISPATCH_WAIT_REASON} “${PLACEHOLDER.test(dependency) ? dependency : id}” is a placeholder, not that blocker.` }
  }
  if (dispatchOnlyWait(wait.dependency, wait.unblocks_when, wait.id)) {
    return { code: 'not-independent', field: 'dependency', message: DISPATCH_WAIT_REASON }
  }
  return null
}

export function workIdShape(cardId: string, workId: string): WaitIssue | null {
  const canonical = canonicalWorkId(workId)
  if (!canonical || isJiraCard(cardId) !== isJiraCard(workId)) {
    return { code: 'invalid-work-id', field: 'id', message: `Waiting For ID is not a valid ${isJiraCard(cardId) ? 'Jira' : 'Notion'} Work card identifier.` }
  }
  if (canonical === canonicalWorkId(cardId)) return { code: 'work-self', field: 'id', message: 'Waiting For ID references this same Work card.' }
  return null
}

/** Read-side field check. An id missing from the loaded set needs verification; it is not proof the card is gone. */
export function waitingForFieldIssue(input: { cardId: string; status: string; type: string; id: string; knownWorkIds: readonly string[] }): string | null {
  if (input.status !== 'Waiting For') return null
  const type = input.type.trim(), id = input.id.trim()
  if (!type) return 'Waiting For Type is missing.'
  if (!waitingForTypes.includes(type as WaitingForType)) return `Waiting For Type “${type}” is not Work, Actor or Event.`
  if (!id) return 'Waiting For ID is missing.'
  if (type === 'Work') {
    const shape = workIdShape(input.cardId, id)
    if (shape) return shape.message
    const known = new Set(input.knownWorkIds.flatMap(value => { const canonical = canonicalWorkId(value); return canonical ? [canonical] : [] }))
    if (!known.has(canonicalWorkId(id)!)) return 'Waiting For ID does not resolve to a Work card in the loaded source. The reference needs verification.'
  }
  return null
}

/** Structural and dispatch-only problems on a card Tin Star did not rewrite.
 * Work-id membership in a filtered result is intentionally not treated as absence. */
export function waitingForException(input: {
  cardId: string; status: string; type: string; id: string; waitingFor: string; nextCheckIn?: { start?: string; time_zone?: string } | null; knownWork?: readonly { id: string; status: string; archived?: boolean; in_trash?: boolean }[]; observedAt: string | null; coverage: SourceCoverage
}): WaitingForException | null {
  if (input.status === 'Waiting for Prod Release') return null
  const base = { card_id: input.cardId, observed_at: input.observedAt, coverage: input.coverage }
  if (input.status === 'Waiting For') {
    const reason = waitingForFieldIssue({ ...input, knownWorkIds: (input.knownWork ?? []).map(card => card.id) })
    if (reason) {
      const field = reason.startsWith('Waiting For Type') ? 'Waiting For Type' : reason.startsWith('Waiting For ID') ? 'Waiting For ID' : 'Waiting For'
      return { ...base, field, reason }
    }
    if (input.type === 'Work') {
      const work = input.knownWork?.find(card => canonicalWorkId(card.id) === canonicalWorkId(input.id))
      if (work && (work.archived || work.in_trash || ['Done', 'Archived'].includes(work.status))) return { ...base, field: 'Waiting For ID', reason: 'Waiting For Work reference is completed, archived or deleted; it is not an unfinished blocker.' }
    }
    for (const line of input.waitingFor.split('\n').filter(line => line.trim())) {
      const match = /^Dependency: (.+) \| Unblocks when: (.+) \| Follow-up: (.+) \| Type: (Actor|Event|Work) \| ID: (.+)$/.exec(line)
      if (!match || match.slice(1).some(value => !value.trim() || value === '""')) return { ...base, field: 'Waiting For', reason: 'Waiting For requires dependency, unblock condition, follow-up owner and typed identity on every active wait.' }
      const issue = independentWaitIssue({ dependency: match[1]!, unblocks_when: match[2]!, type: match[4]!, id: match[5]! })
      if (issue) return { ...base, field: 'Waiting For', reason: issue.message }
    }
    if (!input.waitingFor.trim()) return { ...base, field: 'Waiting For', reason: 'Waiting For dependency, unblock condition and follow-up owner are missing.' }
    if (!Number.isFinite(checkInTime(input.nextCheckIn?.start ?? null, input.nextCheckIn?.time_zone))) return { ...base, field: 'Next check-in', reason: 'Next check-in is missing or invalid.' }
    if (dispatchOnlyWait(input.waitingFor, '', input.id)) return { ...base, field: 'Waiting For', reason: DISPATCH_WAIT_REASON }
    return null
  }
  if (['Queued', 'Todo', 'Backlog', 'In Progress'].includes(input.status) && input.waitingFor.trim() && dispatchOnlyWait(input.waitingFor, '', input.id)) {
    return { ...base, field: 'Waiting For', reason: `${DISPATCH_WAIT_REASON} Status is ${input.status}; this text was not rewritten.` }
  }
  return null
}
