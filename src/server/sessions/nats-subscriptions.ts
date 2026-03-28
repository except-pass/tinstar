/**
 * NATS Subscription Computation
 *
 * Computes NATS subject patterns based on entity hierarchy.
 * Sessions subscribe to subjects that allow them to receive messages
 * at various levels of the hierarchy (task, epic, initiative).
 */

import type { DocumentStore } from '../stores/document-store'

export interface NatsSubscriptionContext {
  sessionName: string
  taskId?: string | null
  epicId?: string | null
  initiativeId?: string | null
}

/**
 * Compute NATS subscriptions for a session based on its entity hierarchy.
 *
 * Returns subjects for:
 * - Direct messages to this session
 * - Task-level broadcasts
 * - Epic-level wildcards
 * - Initiative-level wildcards
 *
 * Subject format: tinstar.<initiative>.<epic>.<task>.<session-name>
 *
 * @param ctx - Session context with entity IDs
 * @param docStore - Document store for looking up entity hierarchy
 * @returns Array of NATS subjects to subscribe to
 */
export function computeNatsSubscriptions(
  ctx: NatsSubscriptionContext,
  docStore: DocumentStore,
): string[] {
  const subjects: string[] = []

  // Always subscribe to direct messages for this session
  subjects.push(`agents.${ctx.sessionName}`)

  // If we have entity associations, build hierarchy-based subjects
  let initiativeId = ctx.initiativeId
  let epicId = ctx.epicId
  const taskId = ctx.taskId

  // Resolve hierarchy by walking up from task
  if (taskId) {
    const task = docStore.getTask(taskId)
    if (task) {
      epicId = epicId || task.epicId
      initiativeId = initiativeId || task.initiativeId
    }
  }

  if (epicId && !initiativeId) {
    const epic = docStore.getEpic(epicId)
    if (epic) {
      initiativeId = epic.initiativeId
    }
  }

  // Build hierarchy path
  const parts: string[] = ['tinstar']

  if (initiativeId) {
    const initiative = docStore.getInitiative(initiativeId)
    if (initiative) {
      parts.push(sanitizeSubjectToken(initiative.id))

      // Initiative wildcard: tinstar.<init>.>
      subjects.push(`${parts.join('.')}.>`)

      if (epicId) {
        const epic = docStore.getEpic(epicId)
        if (epic) {
          parts.push(sanitizeSubjectToken(epic.id))

          // Epic wildcard: tinstar.<init>.<epic>.>
          subjects.push(`${parts.join('.')}.>`)

          if (taskId) {
            const task = docStore.getTask(taskId)
            if (task) {
              parts.push(sanitizeSubjectToken(task.id))

              // Task broadcast: tinstar.<init>.<epic>.<task>.*
              subjects.push(`${parts.join('.')}.*`)

              // Direct: tinstar.<init>.<epic>.<task>.<session-name>
              subjects.push(`${parts.join('.')}.${sanitizeSubjectToken(ctx.sessionName)}`)
            }
          }
        }
      }
    }
  }

  return [...new Set(subjects)] // Deduplicate
}

/**
 * Sanitize a string for use as a NATS subject token.
 * NATS subjects use '.' as separator and don't allow spaces or special chars.
 */
function sanitizeSubjectToken(token: string): string {
  return token
    .replace(/\s+/g, '-')      // spaces to hyphens
    .replace(/[.>*]/g, '-')    // NATS special chars to hyphens
    .replace(/-+/g, '-')       // collapse multiple hyphens
    .replace(/^-|-$/g, '')     // trim leading/trailing hyphens
    .toLowerCase()
}

/**
 * Compute the diff between old and new subscriptions.
 * Used when an entity's parent changes to determine what to add/remove.
 */
export function diffSubscriptions(
  oldSubs: string[],
  newSubs: string[],
): { add: string[]; remove: string[] } {
  const oldSet = new Set(oldSubs)
  const newSet = new Set(newSubs)

  const add = newSubs.filter(s => !oldSet.has(s))
  const remove = oldSubs.filter(s => !newSet.has(s))

  return { add, remove }
}
