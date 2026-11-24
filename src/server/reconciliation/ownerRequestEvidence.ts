import { releasePull } from '../../shared/pullIdentity'
import { isPublishedReviewDetail } from './workerLinkReport'

export const requestedHead = (text: unknown) =>
  typeof text === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(text) ? text.toLowerCase() : null

/** A head belongs to an explicit request only when the publication binds it to
 * this exact URL. An unrelated SHA elsewhere in a note is never head evidence. */
export function mergePublication(line: string, jira = false) {
  const match = (jira ? /^Will: merge (https:\/\/\S+?)(?:\s+(.*))?$/i :
    /^(?:Will: )?merge (https:\/\/\S+?)(?:\s+(.*))?$/i).exec(line.trim())
  const pull = match && releasePull(match[1]!)
  if (!pull) return null
  const suffix = (match[2] ?? '').trim()
  const head = requestedHead(/^head (\S+)$/i.exec(suffix)?.[1])
  // Unfamiliar qualifiers may be conditions. Retain the exact target but hold
  // readiness until a current publication records an unconditional request.
  return { ...pull, head, conditional: !!suffix && !head }
}

/** An exact-head ready notice supplements a routed merge ask. A ready notice
 * alone does not route work or change which head the owner was asked to merge. */
export function readyHeadPublication(event: string) {
  const notice = /^done: PR (https:\/\/\S+) checks green at head (\S+)$/.exec(event)
  const pull = notice && releasePull(notice[1]!)
  const head = requestedHead(notice?.[2])
  return pull && head ? { ...pull, head } : null
}

export function workerReviewPublication(task: {
  pr: { url?: unknown; head?: unknown }
  current_state: { freshness?: unknown; detail?: unknown }
  lastEventText?: string | null
  last_event: { raw?: unknown }
}) {
  const pull = typeof task.pr.url === 'string' ? releasePull(task.pr.url) : null
  if (!pull) return null
  const snapshotHead = requestedHead(task.pr.head)
  const last = task.lastEventText ?? (typeof task.last_event.raw === 'string' ? task.last_event.raw : '')
  const publication = readyHeadPublication(last)
  if (publication) {
    return publication.id === pull.id && (!snapshotHead || publication.head === snapshotHead) ? publication : null
  }
  if (!snapshotHead || task.current_state.freshness !== 'fresh' || !isPublishedReviewDetail(task.current_state.detail)) return null
  return { ...pull, head: snapshotHead }
}

export function declaredRepository(value: unknown) {
  return typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value.trim()) ? value.trim().toLowerCase() : null
}
