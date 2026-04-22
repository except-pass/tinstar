/**
 * NATS Subscription Computation
 *
 * Computes NATS subject patterns based on entity hierarchy.
 * Sessions subscribe to TWO subjects to enable both broadcast and DM:
 * 1. Task broadcast channel (exact match) — all agents on task see it
 * 2. Direct channel (exact match) — only this agent sees it (DM inbox)
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
 * Two-tier subscription model:
 * 1. Broadcast: tinstar.<space>.<init>.<epic>.<task> — task-level channel
 * 2. Direct: tinstar.<space>.<init>.<epic>.<task>.<session> — DM inbox
 *
 * This enables:
 * - Publish to broadcast → everyone on task sees it
 * - Publish to direct → only that agent sees it (private DM)
 *
 * @param ctx - Session context with entity IDs
 * @param docStore - Document store for looking up entity hierarchy
 * @returns Array of NATS subjects to subscribe to (broadcast + direct)
 */
export function computeNatsSubscriptions(
  ctx: NatsSubscriptionContext,
  docStore: DocumentStore,
): string[] {
  const subjects: string[] = []

  // Resolve hierarchy by walking up from task
  let initiativeId = ctx.initiativeId
  let epicId = ctx.epicId
  const taskId = ctx.taskId
  let spaceId = ctx.spaceId

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
  // Use '_' as placeholder for missing levels to keep structure consistent
  const BLANK = '_'

  const space = spaceId ? docStore.getSpace(spaceId) : null
  const initiative = initiativeId ? docStore.getInitiative(initiativeId) : null
  const epic = epicId ? docStore.getEpic(epicId) : null
  const task = taskId ? docStore.getTask(taskId) : null

  const spaceName = space ? sanitizeSubjectToken(space.name) : BLANK
  const initName = initiative ? sanitizeSubjectToken(initiative.name) : BLANK
  const epicName = epic ? sanitizeSubjectToken(epic.name) : BLANK
  const taskName = task ? sanitizeSubjectToken(task.name) : BLANK
  const sessionToken = sanitizeSubjectToken(ctx.sessionName)

  // Build base path (without session name)
  const basePath = ['tinstar', spaceName, initName, epicName, taskName].join('.')

  if (task) {
    // Two-tier subscription for task-level agents:
    // 1. Broadcast channel — all agents on task see messages here
    subjects.push(basePath)
    // 2. Direct channel — only this agent sees messages here (DM inbox)
    subjects.push(`${basePath}.${sessionToken}`)
  } else if (epic) {
    // Epic-level: use wildcard since no specific task
    subjects.push(`tinstar.${spaceName}.${initName}.${epicName}.>`)
  } else if (initiative) {
    // Initiative-level wildcard
    subjects.push(`tinstar.${spaceName}.${initName}.>`)
  } else if (space) {
    // Space-level wildcard
    subjects.push(`tinstar.${spaceName}.>`)
  }

  return subjects
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
