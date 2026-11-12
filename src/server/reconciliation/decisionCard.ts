import type { FirstMateRequest } from '../../shared/deskSource'
import type { SourceSnapshot } from './index'
import { ageObservation } from './observation'
import type { CardReference } from './references'
import { declaredLinks } from './scene'
import { isBlankWorkerLinks, readableTaskIdentities, FIRST_MATE_TASKS, WORKER_LINK_SCHEMA } from './workerLinks'

/** Resolve request ownership without writing card links or guessing from titles. */
export function decisionCard(request: FirstMateRequest, refs: CardReference[], intentions?: SourceSnapshot['intentions']) {
  if (refs.some(ref => ref.basis === 'explicit')) {
    const ids = new Set(refs.map(ref => ref.pageId))
    return ids.size === 1 ? { cardId: refs[0]!.pageId } : { cardId: null, reason: 'request lacks one explicit canonical card link' }
  }
  const searched = `${FIRST_MATE_TASKS} (${WORKER_LINK_SCHEMA}) for fm_home=${JSON.stringify(request.home)} + task_id=${JSON.stringify(request.taskId)}`
  if (!request.taskId) return { cardId: null, reason: `request lacks one explicit canonical card link; ${searched}: task identity is unknown` }
  const observation = intentions && ageObservation(intentions)
  if (!observation || observation.status !== 'fresh' || observation.coverage !== 'complete' || !observation.data || observation.data.hasMore) {
    return { cardId: null, reason: `request lacks one explicit canonical card link; ${searched}: card coverage is unknown (missing, stale or incomplete)` }
  }
  const names = (tasks: Array<{ fm_home: string; task_id: string }>) =>
    tasks.some(link => link.fm_home === request.home && link.task_id === request.taskId)
  const matches = new Set<string>(), unreadable: string[] = []
  for (const card of observation.data.cards) {
    const links = declaredLinks(card)
    if (links.status === 'valid') {
      if (names(links.tasks)) matches.add(card.id)
    } else if (!isBlankWorkerLinks(links)) {
      // A readable declaration of other tasks cannot hide this one. Unreadable
      // JSON, an unreadable entry, or an entry that names this task stays
      // unknown: a match still needs a fully valid declaration, and one stale
      // unrelated card must not block every decision on the board.
      const property = card.properties[FIRST_MATE_TASKS]
      const identities = links.status === 'invalid' && property?.type === 'rich_text' && !property.hasMore
        ? readableTaskIdentities(property.value) : null
      if (!identities || names(identities)) unreadable.push(card.id)
    }
  }
  // An unreadable declaration could hide a competing card; it is not a nonmatch.
  if (unreadable.length) return { cardId: null, reason: `request lacks one explicit canonical card link; ${searched}: link coverage is unknown on cards ${unreadable.join(', ')}` }
  if (matches.size !== 1) return { cardId: null, reason: `request lacks one explicit canonical card link; ${searched}: ${matches.size} matching cards${matches.size ? ` (${[...matches].join(', ')})` : ''}` }
  return { cardId: [...matches][0]! }
}
