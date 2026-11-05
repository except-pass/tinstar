import type { Execution } from '../server/reconciliation/scene'
import { executionStatus } from './executionLiveness'

/** Attention order, preserving source labels. New source options follow the
 * known options alphabetically; blank/unknown is always last. */
export const cardStatusOrder = [
  'Ready for Review', 'In review', 'In Progress', 'Queued', 'Waiting For', 'Waiting',
  'Waiting for Prod Release', 'Delegated to person', 'Todo', 'Not started', 'Planned',
  'Backlog', 'Spare tokens', 'Done', 'Archived',
] as const
export const workerStatusOrder = ['Blocked', 'Error', 'Running', 'Queued', 'Waiting', 'Idle', 'Stopped', 'Finished'] as const
export const unknownStatus = 'Status unknown'
/** Keep the existing observation/event precedence. Only otherwise unknown
 * states expose additional actual publisher states; this never changes liveness. */
export function floorWorkerStatus(worker: Execution): string {
  const status = executionStatus(worker)
  if (status !== 'Unknown') return status
  const raw = String(worker.source.current_state.state).trim().toLowerCase()
  return ({ error: 'Error', queued: 'Queued', idle: 'Idle', stopped: 'Stopped' } as Record<string, string>)[raw] ?? status
}
export function statusRank(status: string, domain: 'cards' | 'workers') {
  if (!status.trim() || /^(?:unknown|status unknown|unassigned \/ unknown)$/i.test(status)) return 10000
  const order: readonly string[] = domain === 'cards' ? cardStatusOrder : workerStatusOrder
  const index = order.findIndex(value => value.toLowerCase() === status.toLowerCase())
  return index < 0 ? order.length : index
}
export const compareStatus = (a: string, b: string, domain: 'cards' | 'workers') => statusRank(a, domain) - statusRank(b, domain) || a.localeCompare(b)
export interface DonutFilter { cards: string[]; workers: string[] }
export const emptyDonutFilter = (): DonutFilter => ({ cards: [], workers: [] })
export const hasDonutFilter = (filter?: DonutFilter) => !!filter && !!(filter.cards.length || filter.workers.length)
