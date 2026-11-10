import { proposalAnswerId } from '../ask/decision'
import { requestAnchor } from '../../shared/deskSource'
import type { QueueItem, buildQueue } from './queue'
import type { FloorScene } from '../../shared/reconciliationPresentation'
import type { CardContextRead } from './cardContext'
import { queuePulls, type PullsRead, type PullSummary } from '../../shared/pulls'
import { releasePull } from '../../shared/releases'
import type { PullReadiness } from './queuePulls'
import { decisionRequests } from '../../shared/workflowRequests'

export interface NeedsWillItem extends QueueItem {
  prDetails?: string
  requestSince: string | null
  ageBasis: 'request-history' | 'unknown'
  requests: Array<ReturnType<typeof decisionRequests>[number] & { cardId: string }>
  pulls: Array<PullSummary & { readiness: PullReadiness | null }>
}
const tags = (value: unknown) => (Array.isArray(value) ? value : [value]).filter((tag): tag is string => typeof tag === 'string' && !!tag.trim() && !/^(none|no|false|n\/a|answered|resolved)$/i.test(tag.trim()))
/** Current explicit asks only. Green GitHub evidence enriches a routed merge
 * request; repository membership and passing checks never create permission. */
export function needsWill(queue: ReturnType<typeof buildQueue>, scene: FloorScene, contexts: Map<string, CardContextRead>, inventory: PullsRead | null,
  readiness: ReadonlyMap<string, PullReadiness>, authorized = false): NeedsWillItem[] {
  if (!authorized) { inventory = null; readiness = new Map() }
  const cards = new Map(scene.cards.map(card => [card.id, card]))
  return queue.items.flatMap(item => {
    let real = !!item.decisionResolution && item.decisionResolution.state !== 'resolved' || item.sources.some(source => source.kind === 'firstmate' && !!source.responseAnchor && !!source.action)
    const since: string[] = [], requests: Array<ReturnType<typeof decisionRequests>[number] & { cardId: string }> = []
    for (const id of item.cardIds) {
      const card = cards.get(id)
      if (!card || card.source.archived || card.source.in_trash || ['Done', 'Archived'].includes(String(card.source.properties.Status?.value))) continue
      const actionTags = item.sources.find(source => source.kind === 'notion' && source.request?.kind === 'notion-card' && source.id === id)?.actions ?? tags(card.source.properties['Will action']?.value)
      const wait = String(card.source.properties['Waiting For']?.value ?? '')
      const context = contexts.get(id), history = decisionRequests(context?.blocks ?? [])
      const open = history.filter(request => !request.answered && request.requestedFrom?.trim().toLowerCase() === 'will' && actionTags.includes(request.action))
      requests.push(...open.map(request => ({ ...request, cardId: id })))
      if (/\bWill\b/.test(wait) || actionTags.length) real = true
      for (const request of open) if (request.since && Number.isFinite(Date.parse(request.since))) since.push(request.since)
    }
    if (!real) return []
    const ids = new Set(queuePulls(item, inventory).map(pull => pull.id))
    const pulls = [...new Map((inventory?.pulls ?? []).flatMap(pull => {
      const identity = releasePull(pull.url)
      return identity && ids.has(identity.id) ? [[identity.id, { ...pull, ...identity, readiness: readiness.get(identity.url)?.head === pull.head ? readiness.get(identity.url)! : null }] as const] : []
    })).values()]
    const published = requests.filter(request => !request.answered && request.proposal && request.proposal.request_key === item.id &&
      (!request.proposal.card_id || item.cardIds.includes(request.proposal.card_id)) && request.sourceRequest &&
      item.sources.some(source => source.request?.kind !== 'notion-card' && source.request && requestAnchor(source.request) === requestAnchor(request.sourceRequest!) && (source.question ?? source.action) === request.sourceQuestion && (source.generation ?? null) === (request.sourceSpawnGen ?? null)))
      .map(request => request.proposal!)
    const superseded = new Set(published.flatMap(proposal => proposal.supersedes ? [proposal.supersedes] : []))
    const proposal = published.filter(proposal => !superseded.has(proposal.proposal_id)).sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at)).at(-1)
    const conflictingHead = pulls.some(pull => !pull.readiness && readiness.has(pull.url))
    const requestSince = since.length ? since.sort((a, b) => Date.parse(a) - Date.parse(b))[0]! : null
    return [{ ...item, ...(proposal ? { proposal: { answer_id: proposalAnswerId(proposal), value: proposal } } : {}), ...(!authorized ? { prDetails: 'PR details require owner authorization' } : {}), ...(conflictingHead ? { readiness: 'needs-readiness-verification' as const, oneTouch: false, reasons: [...item.reasons, 'PR inventory head differs from the readiness observation; refresh before acting'] } : {}), action: item.action ?? (requests.map(request => request.question).filter(Boolean).join('; ') || null), requests, requestSince, ageBasis: requestSince ? 'request-history' as const : 'unknown' as const, pulls }]
  })
}
