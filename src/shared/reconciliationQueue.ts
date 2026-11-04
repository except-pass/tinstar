import type { buildQueue } from '../server/reconciliation/queue'
export type DeskQueue = ReturnType<typeof buildQueue>
export interface QueueUnavailable { outcome: 'queue-source-unavailable'; message: string }
export type QueueRead = DeskQueue | QueueUnavailable
export const hasQueue = (value: QueueRead | null | undefined): value is DeskQueue => !!value && 'items' in value
/** Only current, verified requests enter default next-decision navigation. */
export const decisionItems = (queue: DeskQueue, now = Date.now()) => queue.items.filter(item => item.readiness === 'ready-now' && item.sources.every(source => ['fresh', 'partial'].includes(source.status) && (!source.expiresAt || Date.parse(source.expiresAt) > now)))
