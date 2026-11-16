import { z } from 'zod'
import type { WorkCard } from './workReader'
import { parseWorkerLinks, FIRST_MATE_TASKS } from './workerLinks'
import { decisionRequests, workflowReceipt } from '../../shared/workflowRequests'

export const willActions = ['Decision', 'Do', 'Merge', 'Elevated command'] as const
export const claimFilters = {
  will_action: z.enum(willActions).optional(),
  initiative: z.string().trim().min(1).max(200).optional(),
  area: z.string().trim().min(1).max(200).optional(),
  max_age_days: z.number().finite().nonnegative().optional(),
}
export const claimFilterSchema = z.object(claimFilters)
export type ClaimFilters = z.infer<typeof claimFilterSchema>
const value = (card: WorkCard, name: string) => card.properties[name]?.value
export function needsWillIssues(card: WorkCard): string[] {
  const issues: string[] = []
  for (const [field, expected] of [['Owner', 'Will'], ['Status', 'Waiting For'], ['Waiting For Type', 'Actor'], ['Waiting For ID', 'Will']] as const) {
    if (value(card, field) !== expected || card.properties[field]?.hasMore) issues.push(`${field} must be ${expected}`)
  }
  const actions = value(card, 'Will action')
  if (!Array.isArray(actions) || !actions.some(action => willActions.includes(action as typeof willActions[number])) || card.properties['Will action']?.hasMore) issues.push('Will action must include Decision, Do, Merge or Elevated command')
  if (typeof value(card, 'Waiting For') !== 'string' || !String(value(card, 'Waiting For')).startsWith('Will:') || card.properties['Waiting For']?.hasMore) issues.push('Waiting For must start Will:')
  return issues
}
export function currentWillRequests(notes: Parameters<typeof decisionRequests>[0], actions: unknown) {
  const tags = (Array.isArray(actions) ? actions : [actions]).filter((action): action is string => typeof action === 'string').map(action => action.trim().toLowerCase())
  return decisionRequests(notes).filter(request => request.requestedFrom?.trim().toLowerCase() === 'will' && tags.includes(request.action.trim().toLowerCase()))
}
export function oldestOpenRequestSince(requests: ReturnType<typeof decisionRequests>) {
  return requests.filter(request => !request.answered).flatMap(request => request.since && Number.isFinite(Date.parse(request.since)) ? [request.since] : []).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null
}
export const strictlyNeedsWill = (card: WorkCard) => !card.archived && !card.in_trash && needsWillIssues(card).length === 0
export function matchesClaimFilters(card: WorkCard, filters: ClaimFilters, requestSince: string | null = null, now = Date.now()) {
  const matches = (name: string, expected?: string) => expected === undefined || (Array.isArray(value(card, name)) ? (value(card, name) as unknown[]).includes(expected) : value(card, name) === expected)
  const since = requestSince ? Date.parse(requestSince) : NaN
  return strictlyNeedsWill(card) && matches('Will action', filters.will_action) && matches('Initiative', filters.initiative) && matches('Area', filters.area) &&
    (filters.max_age_days === undefined || Number.isFinite(since) && since <= now && now - since <= filters.max_age_days * 86400_000)
}
/** Exact declarations only. Unknown ownership remains visible for Firstmate to reconcile. */
export function responsibleMate(card: WorkCard, notes: Array<{ text: string }> = []): { owner: string; id: string; tasks: Array<{ fm_home: string; task_id: string }> } | null {
  const links = parseWorkerLinks(value(card, FIRST_MATE_TASKS))
  if (links.status === 'valid' && links.tasks.length) return { owner: 'Firstmate', id: links.tasks.map(task => `${task.fm_home}/${task.task_id}`).join(', '), tasks: links.tasks }
  const actors = [value(card, 'Last touched by'), ...[...notes].reverse().flatMap(note => {
    const receipt = workflowReceipt(note)
    return receipt ? [JSON.parse(receipt.slice('Tin Star operation: '.length))[0] as unknown] : []
  })]
  for (const actor of actors) if (typeof actor === 'string' && actor.trim() && !['Will', 'Owner', 'owner-chatgpt', 'Tin Star MCP', 'Tin Star UI'].includes(actor)) return { owner: actor, id: actor, tasks: [] }
  return null
}
export function malformedWillAsk(card: WorkCard) {
  if (card.archived || card.in_trash || ['Done', 'Archived'].includes(String(value(card, 'Status')))) return null
  const actions = value(card, 'Will action')
  const claimsWill = String(value(card, 'Owner') ?? '').trim().toLowerCase() === 'will' || value(card, 'Waiting For ID') === 'Will' || (Array.isArray(actions) ? actions : [actions]).some(action => typeof action === 'string' && !!action.trim() && !/^(none|no|false|n\/a|answered|resolved)$/i.test(action.trim()))
  const issues = needsWillIssues(card)
  return claimsWill && issues.length ? { card_id: card.id, mate: responsibleMate(card), issues } : null
}
