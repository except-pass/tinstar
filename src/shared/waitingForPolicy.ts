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

const entryText = (text: string) => /[\r\n]/.test(text) || text.startsWith('"') ? JSON.stringify(text) : text

/** The exact Waiting For line a later resolve must match. */
export function waitLine(value: { dependency: string; unblocks_when: string; follow_up_by: string; type: string; id: string }): string {
  return `Dependency: ${entryText(value.dependency)} | Unblocks when: ${entryText(value.unblocks_when)} | Follow-up: ${entryText(value.follow_up_by)} | Type: ${value.type} | ID: ${entryText(value.id)}`
}

export function parseWaitLine(line: string): { type: WaitingForType; id: string; dependency: string; unblocks_when: string; follow_up_by: string } | null {
  const match = /^Dependency: (.+) \| Unblocks when: (.+) \| Follow-up: (.+) \| Type: (Actor|Event|Work) \| ID: (.+)$/.exec(line)
  if (!match) return null
  const decode = (text: string) => {
    if (!text.startsWith('"')) return text
    try { const value: unknown = JSON.parse(text); return typeof value === 'string' ? value : text } catch { return text }
  }
  const value = { dependency: decode(match[1]!), unblocks_when: decode(match[2]!), follow_up_by: decode(match[3]!), type: match[4] as WaitingForType, id: decode(match[5]!) }
  return Object.values(value).every(field => field.trim()) ? value : null
}

function scheduleOnly(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (!/\b(?:check-?\s*in|checkpoint)\b/i.test(trimmed) && !/^\d{4}-\d{2}-\d{2}(?:[t ]|\b)/i.test(trimmed)) return false
  const residue = trimmed.replace(SCHEDULE_WORD, ' ').replace(/\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:z|[+-]\d{2}:?\d{2})?)?/gi, ' ').replace(/\b\d{1,2}(?::\d{2})?\b/g, ' ').replace(/[^a-z]+/gi, ' ').trim()
  return residue.length === 0
}

/** True when the text gives no independent prerequisite. Follow-up owner is not part of this check. */
export function dispatchOnlyWait(dependency: string, unblocksWhen: string): boolean {
  const outcome = unblocksWhen.trim()
  const text = !outcome || /^(?:when )?(?:that|this|it) happens[.!]?$/i.test(outcome) ? dependency.trim() : outcome
  return scheduleOnly(text) || [
    /^(?:(?:waiting|wait) for |pending |when |once |after )?(?:a |the |this |our )?worker(?: to be| is| gets| has been| to)? (?:assign(?:ed|ment)|start(?:ed|s|ing)?|attach(?:ed|es|ing)?)(?:\b|$)/i,
    /^(?:(?:waiting|wait) for |pending |when |once |after )?.+? (?:to |is |will |can )?(?:start(?:s|ing)?(?:\/attach)?|attach(?:es|ing)?|assign(?:s|ing)?) (?:a |the |this |our )?worker\b/i,
    /^(?:(?:waiting|wait) for |pending |when |once |after )?(?:first\s*mate|hilda(?: mate)?) (?:to |is |will |can )?pick(?:s|ing)?\s*(?:(?:it|this card)\s+)?up\b/i,
    /^(?:queued behind|behind other) (?:other )?(?:tasks|work|cards|items)\b/i,
  ].some(phrase => phrase.test(text))
}

export function independentWaitIssue(wait: { type: string; id: string; dependency: string; unblocks_when: string }): WaitIssue | null {
  if (!wait.dependency.trim() || !wait.unblocks_when.trim()) {
    return { code: 'placeholder-blocker', field: 'dependency', message: `${DISPATCH_WAIT_REASON} Supply a dependency and its unblock outcome.` }
  }
  if (dispatchOnlyWait(wait.dependency, wait.unblocks_when)) return { code: 'not-independent', field: 'unblocks_when', message: DISPATCH_WAIT_REASON }
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

export function hasActiveTypedWait(input: { type: string; id: string; waitingFor: string }): boolean {
  return !!input.type.trim() || !!input.id.trim() || input.waitingFor.split('\n').some(line => parseWaitLine(line) !== null)
}

/** Structural and dispatch-only problems on a card Tin Star did not rewrite.
 * Work-id membership in a filtered result is intentionally not treated as absence. */
export function waitingForException(input: {
  cardId: string; status: string; type: string; id: string; waitingFor: string; nextCheckIn?: { start?: string; time_zone?: string } | null; knownWork?: readonly { id: string; status: string; archived?: boolean; in_trash?: boolean }[]; observedAt: string | null; coverage: SourceCoverage
}): WaitingForException | null {
  if (input.status === 'Waiting for Prod Release') return null
  const base = { card_id: input.cardId, observed_at: input.observedAt, coverage: input.coverage }
  if (input.status === 'Waiting For') {
    const referenceIssue = (type: string, id: string): WaitingForException | null => {
      const reason = waitingForFieldIssue({ ...input, type, id, knownWorkIds: (input.knownWork ?? []).map(card => card.id) })
      if (reason) return { ...base, field: reason.startsWith('Waiting For Type') ? 'Waiting For Type' : 'Waiting For ID', reason }
      if (type === 'Work') {
        const work = input.knownWork?.find(card => canonicalWorkId(card.id) === canonicalWorkId(id))
        if (input.coverage !== 'complete') return { ...base, field: 'Waiting For ID', reason: 'Waiting For Work reference needs verification from a fresh, complete source.' }
        if (work && (work.archived || work.in_trash || ['Done', 'Archived'].includes(work.status))) return { ...base, field: 'Waiting For ID', reason: 'Waiting For Work reference is completed, archived or deleted; it is not an unfinished blocker.' }
      }
      return null
    }
    const primary = referenceIssue(input.type, input.id)
    if (primary) return primary
    const waits = input.waitingFor.split('\n').filter(line => line.trim()).map(parseWaitLine)
    for (const wait of waits) {
      if (!wait) return { ...base, field: 'Waiting For', reason: 'Waiting For requires dependency, unblock condition, follow-up owner and typed identity on every active wait.' }
      const reference = referenceIssue(wait.type, wait.id)
      if (reference) return reference
      const issue = independentWaitIssue(wait)
      if (issue) return { ...base, field: 'Waiting For', reason: issue.message }
    }
    if (waits.length && !waits.some(wait => wait?.type === input.type && wait.id === input.id)) return { ...base, field: 'Waiting For ID', reason: 'Active blocker metadata must match a remaining wait.' }
    if (!input.waitingFor.trim()) return { ...base, field: 'Waiting For', reason: 'Waiting For dependency, unblock condition and follow-up owner are missing.' }
    if (!Number.isFinite(checkInTime(input.nextCheckIn?.start ?? null, input.nextCheckIn?.time_zone))) return { ...base, field: 'Next check-in', reason: 'Next check-in is missing or invalid.' }
    return null
  }
  if (['Queued', 'Todo', 'Backlog', 'In Progress'].includes(input.status)) {
    if (hasActiveTypedWait(input)) return { ...base, field: 'Waiting For', reason: `Status is ${input.status}, but an unresolved typed blocker remains. Resolve the exact active wait or restore Waiting For; no fields were rewritten.` }
    for (const line of input.waitingFor.split('\n').filter(line => line.trim())) {
      const wait = parseWaitLine(line)
      if (dispatchOnlyWait(wait?.dependency ?? line, wait?.unblocks_when ?? '')) return { ...base, field: 'Waiting For', reason: `${DISPATCH_WAIT_REASON} Status is ${input.status}; this text was not rewritten.` }
    }
  }
  return null
}
