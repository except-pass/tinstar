import type { WorkCard } from './workReader'
import { parseWorkerLinks, FIRST_MATE_TASKS } from './workerLinks'
import { decisionRequests, workflowReceipt } from '../../shared/workflowRequests'

const value = (card: WorkCard, name: string) => card.properties[name]?.value
export const deferredDecisionStatus = (status: unknown) => ['todo', 'backlog', 'archived', 'done'].includes(String(status).trim().toLowerCase())
export const deferredDecisionCard = (card: WorkCard) => card.archived || card.in_trash || deferredDecisionStatus(value(card, 'Status'))
const isWill = (value: unknown) => typeof value === 'string' && value.trim().toLowerCase() === 'will'

export function actionableWillCard(card: WorkCard) {
  const actions = value(card, 'Will action')
  const tagged = (Array.isArray(actions) ? actions : [actions]).some(action =>
    typeof action === 'string' && !!action.trim() && !/^(none|no|false|n\/a|answered|resolved)$/i.test(action.trim()))
  return !deferredDecisionCard(card) && (isWill(value(card, 'Owner')) || tagged || cardWaitsForWill(card))
}

export function cardWaitsForWill(card: WorkCard) {
  if (String(value(card, 'Status')).trim().toLowerCase() !== 'waiting for') return false
  return isWill(value(card, 'Waiting For ID')) ||
    /^\s*(?:will(?:\s*:|\s*$|\s+to\b)|waiting for will\b)/im.test(String(value(card, 'Waiting For') ?? ''))
}

export function currentWillRequests(notes: Parameters<typeof decisionRequests>[0], actions: unknown) {
  const tags = (Array.isArray(actions) ? actions : [actions]).filter((action): action is string => typeof action === 'string').map(action => action.trim().toLowerCase())
  return decisionRequests(notes).filter(request => request.requestedFrom?.trim().toLowerCase() === 'will' && tags.includes(request.action.trim().toLowerCase()))
}
export function oldestOpenRequestSince(requests: ReturnType<typeof decisionRequests>) {
  return requests.filter(request => !request.answered).flatMap(request => request.since && Number.isFinite(Date.parse(request.since)) ? [request.since] : []).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null
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
