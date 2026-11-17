import { currentDecisionProposal } from '../../shared/decisionProposal'
import { proposalAnswerId } from '../ask/decision'
import { requestAnchor } from '../../shared/deskSource'
import type { QueueItem, buildQueue } from './queue'
import type { FloorScene } from '../../shared/reconciliationPresentation'
import type { CardContextRead } from './cardContext'
import { queuePulls, type PullsRead, type PullSummary } from '../../shared/pulls'
import { releasePull } from '../../shared/releases'
import type { PullReadiness } from './queuePulls'
import { currentWillRequests, deferredDecisionCard, oldestOpenRequestSince } from './claimPolicy'
import { decisionRequests } from '../../shared/workflowRequests'

export interface NeedsWillItem extends QueueItem {
  requestReadiness?: QueueItem['readiness']
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
  readiness: ReadonlyMap<string, PullReadiness>, authorized = false, publications: import('./proposalSource').ProposalPublication[] = []): NeedsWillItem[] {
  if (!authorized) { inventory = null; readiness = new Map() }
  const cards = new Map(scene.cards.map(card => [card.id, card]))
  return queue.items.flatMap(item => {
    let real = !!item.decisionResolution && item.decisionResolution.state !== 'resolved' && !item.decisionResolution.answered
    const requests: Array<ReturnType<typeof decisionRequests>[number] & { cardId: string }> = []
    const publicationHistory: typeof requests = []
    const closedSources = new Set<string>()
    let activeCard = false
    for (const id of item.cardIds) {
      const card = cards.get(id)
      if (!card || deferredDecisionCard(card.source)) continue
      activeCard = true
      const actionTags = item.sources.find(source => (source.kind === 'notion' || source.kind === 'jira') && source.request?.home === null && source.id === id)?.actions ?? tags(card.source.properties['Will action']?.value)
      const wait = String(card.source.properties['Waiting For']?.value ?? '')
      const context = contexts.get(id)
      const recorded = currentWillRequests(context?.blocks ?? [], actionTags, publications)
      const open = recorded.filter(request => !request.superseded && !request.answered)
      requests.push(...open.map(request => ({ ...request, cardId: id })))
      publicationHistory.push(...recorded.filter(request => request.proposal).map(request => ({ ...request, cardId: id })))
      for (const request of recorded) if (request.answeredByOwner && request.sourceRequest) closedSources.add(requestAnchor(request.sourceRequest))
      const outstandingTags = actionTags.filter(tag => {
        const matching = recorded.filter(request => request.action.trim().toLowerCase() === tag.trim().toLowerCase())
        return !matching.length || matching.some(request => !request.superseded && !request.answeredByOwner)
      })
      if (outstandingTags.length || /\bWill\b/.test(wait) && !actionTags.length) real = true
    }
    if (item.cardIds.length && !activeCard && item.cardIds.every(id => cards.has(id))) return []
    if (item.sources.some(source => source.kind === 'firstmate' && !!source.responseAnchor && !!source.action && !closedSources.has(source.responseAnchor))) real = true
    if (!real) return []
    const ids = new Set(queuePulls(item, inventory).map(pull => pull.id))
    const pulls = [...new Map((inventory?.pulls ?? []).flatMap(pull => {
      const identity = releasePull(pull.url)
      return identity && ids.has(identity.id) ? [[identity.id, { ...pull, ...identity, readiness: readiness.get(identity.url)?.head === pull.head ? readiness.get(identity.url)! : null }] as const] : []
    })).values()]
    const recordedPublications = publicationHistory.filter(request => request.proposal && request.proposal.request_key === item.id &&
      (!request.proposal.card_id || item.cardIds.includes(request.proposal.card_id)) && request.sourceRequest &&
      item.sources.some(source => source.request?.home !== null && source.request && requestAnchor(source.request) === requestAnchor(request.sourceRequest!) && (source.question ?? source.action) === request.sourceQuestion && (source.generation ?? null) === (request.sourceSpawnGen ?? null)))
      .map(request => ({ answer_id: proposalAnswerId(request.proposal!), value: request.proposal!, answered: request.answered }))
    const published = recordedPublications.flatMap(({ answer_id, value, answered }) => answered ? [] : [{ answer_id, value }])
    const current = currentDecisionProposal([...recordedPublications, ...publications.filter(entry => entry.value.request_key === item.id)])
    const active = current && !recordedPublications.some(entry => entry.answer_id === current.answer_id && entry.answered) ? current : undefined
    const proposal = active?.value
    const proposalHistoryComplete = item.cardIds.every(id => contexts.get(id)?.outcome === 'available')
    const conflictingHead = pulls.some(pull => !pull.readiness && readiness.has(pull.url))
    const requestSince = oldestOpenRequestSince(requests)
    const verification = [...new Set(requests.flatMap(request => request.verification ?? []))]
    const reasons = [...verification]
    if (!proposalHistoryComplete) reasons.push('Publication history is incomplete; refresh before choosing')
    if (conflictingHead) reasons.push('PR inventory head differs from the readiness observation; refresh before acting')
    return [{ ...item, requestReadiness: conflictingHead || verification.length ? 'needs-readiness-verification' as const : item.readiness,
      currentProposalAnswerId: active?.answer_id ?? null, proposalHistoryComplete,
      ...(reasons.length ? { readiness: 'needs-readiness-verification' as const, oneTouch: false, reasons: [...item.reasons, ...reasons] } : {}),
      proposals: published, ...(proposal?.source.kind === 'firstmate-request' ? { proposal: { answer_id: proposalAnswerId(proposal), value: proposal } } : {}),
      ...(!authorized ? { prDetails: 'PR details require owner authorization' } : {}),
      action: item.action ?? (requests.map(request => request.question).filter(Boolean).join('; ') || null), requests, requestSince, ageBasis: requestSince ? 'request-history' as const : 'unknown' as const, pulls }]
  })
}
