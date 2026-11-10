import type { buildQueue } from '../server/reconciliation/queue'
export type DeskQueue = ReturnType<typeof buildQueue>
export interface QueueUnavailable { outcome: 'queue-source-unavailable'; message: string }
export type QueueRead = DeskQueue | QueueUnavailable
export const hasQueue = (value: QueueRead | null | undefined): value is DeskQueue => !!value && 'items' in value
/** Only current, verified requests enter default next-decision navigation. */
export const decisionItems = (queue: DeskQueue, now = Date.now()) => (queue.needsWill ?? queue.items).filter(item => item.readiness === 'ready-now' && item.sources.every(source => ['fresh', 'partial'].includes(source.status) && (!source.expiresAt || Date.parse(source.expiresAt) > now)))

export function retainedQueueItemId(previous: DeskQueue | null, queue: DeskQueue, id: string | null): string | null {
  if (!id || queue.items.some(item => item.id === id)) return id
  const old = previous?.items.find(item => item.id === id)
  if (!old) return id
  const identities = new Set(old.identities ?? [old.id])
  const matches = queue.items.filter(item => (item.identities ?? [item.id]).some(identity => identities.has(identity)))
  return matches.length === 1 ? matches[0]!.id : id
}
