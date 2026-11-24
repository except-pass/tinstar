import { releasePull } from '../../shared/pullIdentity'

export const requestedHead = (text: unknown) =>
  typeof text === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(text) ? text.toLowerCase() : null

/** A head belongs to an explicit request only when the publication binds it to
 * this exact URL. An unrelated SHA elsewhere in a note is never head evidence. */
export function mergePublication(line: string, jira = false) {
  const match = (jira ? /^Will: merge (https:\/\/\S+?)(?:\s+(.*))?$/i :
    /^(?:Will: |Please )?merge (https:\/\/\S+?)(?:\s+(.*))?$/i).exec(line.trim())
  const pull = match && releasePull(match[1]!)
  if (!pull) return null
  const suffix = (match[2] ?? '').trim()
  const head = requestedHead(suffix.replace(/^(?:at )?head /i, ''))
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

export function declaredRepository(value: unknown) {
  return typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value.trim()) ? value.trim().toLowerCase() : null
}
