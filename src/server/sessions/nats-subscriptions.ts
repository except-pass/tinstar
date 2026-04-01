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
  spaceId?: string | null
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
 * - Space-level wildcards
 *
 * Subject format: tinstar.<space>.<initiative>.<epic>.<task>.<session-name>
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
  // Note: We use only the hierarchical tinstar.* pattern, not agents.* (avoids namespace collision)

  // If we have entity associations, build hierarchy-based subjects
  let initiativeId = ctx.initiativeId
  let epicId = ctx.epicId
  const taskId = ctx.taskId
  let spaceId = ctx.spaceId

  // Resolve hierarchy by walking up from task
  if (taskId) {
    const task = docStore.getTask(taskId)
    if (task) {
      epicId = epicId || task.epicId
      initiativeId = initiativeId || task.initiativeId
      spaceId = spaceId || task.spaceId
    }
  }

  if (epicId && !initiativeId) {
    const epic = docStore.getEpic(epicId)
    if (epic) {
      initiativeId = epic.initiativeId
      spaceId = spaceId || epic.spaceId
    }
  }

  if (initiativeId && !spaceId) {
    const initiative = docStore.getInitiative(initiativeId)
    if (initiative) {
      spaceId = initiative.spaceId
    }
  }

  // Build hierarchy path using entity names (not IDs) for human-readable subjects
  // Use '_' as placeholder for missing levels to keep structure consistent:
  // tinstar.<space>.<init>.<epic>.<task>.<session>
  const BLANK = '_'

  const space = spaceId ? docStore.getSpace(spaceId) : null
  const initiative = initiativeId ? docStore.getInitiative(initiativeId) : null
  const epic = epicId ? docStore.getEpic(epicId) : null
  const task = taskId ? docStore.getTask(taskId) : null

  const spaceName = space ? sanitizeSubjectToken(space.name) : BLANK
  const initName = initiative ? sanitizeSubjectToken(initiative.name) : BLANK
  const epicName = epic ? sanitizeSubjectToken(epic.name) : BLANK
  const taskName = task ? sanitizeSubjectToken(task.name) : BLANK

  // Always build the full path with placeholders for missing levels
  const parts = ['tinstar', spaceName, initName, epicName, taskName]

  // Add wildcard subjects for each level that exists (not blank)
  // tinstar.<space>.>
  if (space) {
    subjects.push(`tinstar.${spaceName}.>`)
  }

  // tinstar.<space>.<init>.>
  if (initiative) {
    subjects.push(`tinstar.${spaceName}.${initName}.>`)
  }

  // tinstar.<space>.<init>.<epic>.>
  if (epic) {
    subjects.push(`tinstar.${spaceName}.${initName}.${epicName}.>`)
  }

  // Task-level subjects (broadcast and direct)
  if (task) {
    // tinstar.<space>.<init>.<epic>.<task>.*
    subjects.push(`${parts.join('.')}.*`)

    // tinstar.<space>.<init>.<epic>.<task>.<session>
    subjects.push(`${parts.join('.')}.${sanitizeSubjectToken(ctx.sessionName)}`)
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
