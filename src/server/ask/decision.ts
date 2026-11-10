import { createHash } from 'node:crypto'
import { decisionRequestRevision, type DecisionProposal } from '../../shared/decisionProposal'
import type { AskContext } from '../../shared/ask'
import type { QueueItem } from '../reconciliation/queue'

/** Stable across retries/devices, scoped to the exact published source revision. */
export function proposalAnswerId(proposal: DecisionProposal) {
  const hex = createHash('sha256').update(JSON.stringify([proposal.request_key, proposal.proposal_id, proposal.source])).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
export function decisionContext(item: QueueItem, view: AskContext['view']): AskContext {
  const cardId = item.cardIds.length === 1 ? item.cardIds[0]! : null
  const source = item.sources.find(source => source.kind === 'firstmate') ?? item.sources[0]
  return {
    decision: { request_key: item.id, revision: decisionRevision(item) },
    schema_version: 2, target: { kind: 'decision', id: item.id },
    return_to: { section: 'decisions', target: { kind: 'decision', id: item.id }, view: { ...view, scene: 'decisions', request_key: item.id } },
    anchor: { kind: 'decision', page_id: cardId ?? item.id, label: item.title.slice(0, 512), url: cardId ? `https://www.notion.so/${cardId}` : null,
      observed_at: source?.observedAt ?? null, expires_at: source?.expiresAt ?? null, freshness: source?.status === 'fresh' || source?.status === 'partial' ? source.status : 'unknown' },
    view: { ...view, scene: 'decisions', request_key: item.id },
  }
}
export function decisionFresh(item: QueueItem, now = Date.now()) {
  return item.readiness === 'ready-now' && item.sources.length > 0 && item.sources.every(source =>
    ['fresh', 'partial'].includes(source.status) && source.coverage === 'complete' && !!source.observedAt &&
    !!source.expiresAt && Date.parse(source.expiresAt) > now)
}

export const decisionRevision = decisionRequestRevision
