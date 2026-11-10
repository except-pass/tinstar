import type { Execution } from '../server/reconciliation/scene'
import { currentActivity, recordedState } from './workerEvidence'

/** Attention order, preserving source labels. New source options follow the
 * known options alphabetically; blank/unknown is always last. */
export const cardStatusOrder = [
  'Ready for Review', 'In review', 'In Progress', 'Queued', 'Waiting For', 'Waiting',
  'Waiting for Prod Release', 'Delegated to person', 'Todo', 'Not started', 'Planned',
  'Backlog', 'Spare tokens', 'Done', 'Archived',
] as const
export const workerStatusOrder = ['Blocked', 'Error', 'Running', 'Queued', 'Waiting', 'Idle', 'Stopped', 'Finished'] as const
export const unknownStatus = 'Status unknown'
/** Status categories use the same recorded evidence as card and chip facts. */
export function floorWorkerStatus(worker: Execution, now = Date.now()): string {
  const activity = currentActivity(worker, now)
  if (activity === 'terminal') return 'Finished'
  if (activity === 'working') return 'Running'
  if (activity === 'waiting') return recordedState(worker, now) === 'blocked' ? 'Blocked' : 'Waiting'
  return ({ error: 'Error', queued: 'Queued', idle: 'Idle', stopped: 'Stopped' } as Record<string, string>)[recordedState(worker, now) ?? ''] ?? 'No update'
}
export function statusRank(status: string, domain: 'cards' | 'workers') {
  if (!status.trim() || /^(?:unknown|status unknown|no update|unassigned \/ unknown)$/i.test(status)) return 10000
  const order: readonly string[] = domain === 'cards' ? cardStatusOrder : workerStatusOrder
  const index = order.findIndex(value => value.toLowerCase() === status.toLowerCase())
  return index < 0 ? order.length : index
}
export const compareStatus = (a: string, b: string, domain: 'cards' | 'workers') => statusRank(a, domain) - statusRank(b, domain) || a.localeCompare(b)
export interface DonutFilter { cards: string[]; workers: string[] }
export const emptyDonutFilter = (): DonutFilter => ({ cards: [], workers: [] })
export const hasDonutFilter = (filter?: DonutFilter) => !!filter && !!(filter.cards.length || filter.workers.length)
