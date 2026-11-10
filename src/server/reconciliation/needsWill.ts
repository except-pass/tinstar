import type { QueueItem, buildQueue } from './queue'
import type { FloorScene } from '../../shared/reconciliationPresentation'
import type { CardContextRead } from './cardContext'
import type { PullsRead, PullSummary } from '../../shared/pulls'
import type { PullReadiness } from './queuePulls'
import { decisionRequests } from '../../shared/workflowRequests'

export interface NeedsWillItem extends QueueItem {
  requestSince: string | null
  ageBasis: 'request-history' | 'unknown'
  requests: ReturnType<typeof decisionRequests>
  pulls: Array<PullSummary & { readiness: PullReadiness | null }>
}
const tags = (value: unknown) => (Array.isArray(value) ? value : [value]).filter((tag): tag is string => typeof tag === 'string' && !!tag.trim() && !/^(none|no|false|n\/a|answered|resolved)$/i.test(tag.trim()))
/** Current explicit asks only. Green GitHub evidence enriches a routed merge
 * request; repository membership and passing checks never create permission. */
export function needsWill(queue: ReturnType<typeof buildQueue>, scene: FloorScene, contexts: Map<string, CardContextRead>, inventory: PullsRead | null,
  readiness: ReadonlyMap<string, PullReadiness>): NeedsWillItem[] {
  const cards = new Map(scene.cards.map(card => [card.id, card]))
  return queue.items.flatMap(item => {
    let real = item.sources.some(source => source.kind === 'firstmate' && !!source.responseAnchor && !!source.action)
    const since: string[] = [], requests: ReturnType<typeof decisionRequests> = []
    for (const id of item.cardIds) {
      const card = cards.get(id)
      if (!card || card.source.archived || card.source.in_trash || ['Done', 'Archived'].includes(String(card.source.properties.Status?.value))) continue
      const actionTags = tags(card.source.properties['Will action']?.value)
      const wait = String(card.source.properties['Waiting For']?.value ?? '')
      const context = contexts.get(id), history = decisionRequests(context?.blocks ?? [])
      const open = history.filter(request => !request.answered && request.requestedFrom?.trim().toLowerCase() === 'will' && actionTags.includes(request.action))
      requests.push(...open)
      // A complete answer history suppresses only its own old tag. A tag that
      // predates the tracked request may represent another outstanding ask.
      const outstandingTags = actionTags.filter(tag => {
        const requests = history.filter(request => request.action === tag)
        return context?.outcome !== 'available' || !requests.length || requests.some(request => request.preserveAction || !request.answered && request.requestedFrom?.trim().toLowerCase() === 'will')
      })
      if (/\bWill\b/.test(wait) || open.length || outstandingTags.length) real = true
      for (const request of open) if (request.since && Number.isFinite(Date.parse(request.since))) since.push(request.since)
    }
    if (!real) return []
    const urls = new Set(item.evidence.filter(evidence => evidence.kind === 'pull-request').map(evidence => evidence.url))
    const pulls = (inventory?.pulls ?? []).filter(pull => urls.has(pull.url)).map(pull => ({ ...pull, readiness: readiness.get(pull.url)?.head === pull.head ? readiness.get(pull.url)! : null }))
    const conflictingHead = pulls.some(pull => !pull.readiness && readiness.has(pull.url))
    const requestSince = since.length ? since.sort((a, b) => Date.parse(a) - Date.parse(b))[0]! : null
    return [{ ...item, ...(conflictingHead ? { readiness: 'needs-readiness-verification' as const, oneTouch: false, reasons: [...item.reasons, 'PR inventory head differs from the readiness observation; refresh before acting'] } : {}), action: item.action ?? (requests.map(request => request.question).filter(Boolean).join('; ') || null), requests, requestSince, ageBasis: requestSince ? 'request-history' as const : 'unknown' as const, pulls }]
  })
}
