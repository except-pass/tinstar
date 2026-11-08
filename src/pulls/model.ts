import type { FloorScene } from '../shared/reconciliationPresentation'
import type { PullSummary, PullDetail } from '../shared/pulls'
import { pullContext } from '../shared/pullContext'
export { pullContext } from '../shared/pullContext'

export type PullSort = 'repository' | 'title' | 'author' | 'changes' | 'checks' | 'review' | 'updated' | 'initiative' | 'epic' | 'manager' | 'worker'
export function visiblePulls(pulls: PullSummary[], query: string, sort: PullSort, descending: boolean, scene: FloorScene | null, details: Record<string, PullDetail>) {
  const value = (pull: PullSummary): string | number => {
    const context = pullContext(scene, pull), detail = details[pull.id]
    switch (sort) {
      case 'repository': return pull.repository
      case 'title': return pull.title
      case 'author': return pull.author
      case 'updated': return Date.parse(pull.updatedAt)
      case 'changes': return detail ? detail.additions + detail.deletions : -1
      case 'checks': return detail?.checks ?? 'unknown'
      case 'review': return detail?.review ?? 'Unknown'
      case 'initiative': return context.initiatives.join(', ')
      case 'epic': return context.epics.join(', ')
      case 'manager': return context.managers.join(', ')
      case 'worker': return context.workerNames.join(', ')
    }
  }
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return pulls.filter(pull => {
    const context = pullContext(scene, pull)
    const text = [pull.repository, pull.number, pull.title, pull.author, ...context.initiatives, ...context.epics, ...context.workerNames, ...context.managers].join(' ').toLowerCase()
    return words.every(word => text.includes(word))
  }).sort((a, b) => {
    const left = value(a), right = value(b)
    const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' })
    return (descending ? -order : order) || a.id.localeCompare(b.id)
  })
}
