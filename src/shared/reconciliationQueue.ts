import type { buildQueue } from '../server/reconciliation/queue'
export type DeskQueue = ReturnType<typeof buildQueue>
export interface QueueUnavailable { outcome: 'queue-source-unavailable'; message: string }
export type QueueRead = DeskQueue | QueueUnavailable
export const hasQueue = (value: QueueRead | null | undefined): value is DeskQueue => !!value && 'items' in value
/** Future work remains in card context, outside next-decision navigation. */
export const decisionItems = (queue: DeskQueue) => queue.items.filter(item => item.readiness !== 'future-or-conditional')
