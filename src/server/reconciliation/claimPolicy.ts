import { waitEntries, waitState } from '../../shared/waitingForPolicy'
import type { WorkCard } from './workReader'
import { parseWorkerLinks, FIRST_MATE_TASKS } from './workerLinks'
import { decisionRequests, isDecisionRetraction, workflowReceipt } from '../../shared/workflowRequests'

const value = (card: WorkCard, name: string) => card.properties[name]?.value
export const deferredDecisionStatus = (status: unknown) => ['todo', 'backlog', 'archived', 'done'].includes(String(status).trim().toLowerCase())
export const deferredDecisionCard = (card: WorkCard) => card.archived || card.in_trash || deferredDecisionStatus(value(card, 'Status'))
const isWill = (value: unknown) => typeof value === 'string' && value.trim().toLowerCase() === 'will'

export const cardOwnedByWill = (card: WorkCard) => isWill(value(card, 'Owner'))
export const jiraCardAssignedToWill = (card: WorkCard) => card.source?.synthetic === false &&
  ['will', 'william gathright'].includes(String(value(card, 'Assignee') ?? '').trim().toLowerCase())

function cardHasWillAction(card: WorkCard) {
  const actions = value(card, 'Will action')
  return (Array.isArray(actions) ? actions : [actions]).some(action =>
    typeof action === 'string' && !!action.trim() && !/^(none|no|false|n\/a|answered|resolved)$/i.test(action.trim()))
}

export function actionableWillCard(card: WorkCard) {
  return !deferredDecisionCard(card) && (cardOwnedByWill(card) || cardHasWillAction(card) || cardWaitsForWill(card))
}

export function isWillWait(entry: ReturnType<typeof waitEntries>[number]) {
  const { type, id } = entry.fields
  if ((!id?.trim() || entry.implicitIdentity) &&
    /^\s*(?:will(?:\s*:|\s*$|\s+to\b)|waiting for will\b)/i.test(entry.text)) return true
  return isWill(id) && (!type?.trim() || /^(actor|person)$/i.test(type.trim()))
}

export function cardWaitsForWill(card: WorkCard) {
  const wait = waitState(card)
  return wait.status.trim().toLowerCase() === 'waiting for' &&
    (isWillWait({ text: '', fields: wait }) || waitEntries(wait.waitingFor, wait).some(isWillWait))
}

export function isCurrentWillRequest(request: ReturnType<typeof decisionRequests>[number], actions: unknown) {
  return request.requestedFrom?.trim().toLowerCase() === 'will' &&
    (Array.isArray(actions) ? actions : [actions]).some(action =>
      typeof action === 'string' && action.trim().toLowerCase() === request.action.trim().toLowerCase())
}

export function currentWillRequests(notes: Parameters<typeof decisionRequests>[0], actions: unknown) {
  return decisionRequests(notes).filter(request => isCurrentWillRequest(request, actions))
}
export function oldestOpenRequestSince(requests: ReturnType<typeof decisionRequests>) {
  return requests.filter(request => !request.answered).flatMap(request => request.since && Number.isFinite(Date.parse(request.since)) ? [request.since] : []).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null
}
/** Exact declarations only. Unknown ownership remains visible for Firstmate to reconcile. */
export function responsibleMate(card: WorkCard, notes: Array<{ text: string }> = []): { owner: string; id: string; tasks: Array<{ fm_home: string; task_id: string }> } | null {
  const links = parseWorkerLinks(value(card, FIRST_MATE_TASKS))
  if (links.status === 'valid' && links.tasks.length) return { owner: 'Firstmate', id: links.tasks.map(task => `${task.fm_home}/${task.task_id}`).join(', '), tasks: links.tasks }
  const actors = [value(card, 'Last touched by'), ...[...notes].reverse().flatMap(note => {
    const receipt = isDecisionRetraction(note.text) ? null : workflowReceipt(note)
    return receipt ? [JSON.parse(receipt.slice('Tin Star operation: '.length))[0] as unknown] : []
  })]
  for (const actor of actors) if (typeof actor === 'string' && actor.trim() && !['Will', 'Owner', 'owner-chatgpt', 'Tin Star MCP', 'Tin Star UI'].includes(actor)) return { owner: actor, id: actor, tasks: [] }
  return null
}
