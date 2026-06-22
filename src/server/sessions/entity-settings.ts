import type { DocumentStore } from '../stores/document-store'
import type { EntitySettings, GroupingDimension, ResolvedSettings } from '../../domain/types'

/**
 * Resolve entity settings by walking the hierarchy bottom-up.
 * Closest-wins: Task overrides Epic overrides Initiative.
 */
export function resolveEntitySettings(
  entityId: string,
  entityType: GroupingDimension,
  docStore: DocumentStore,
): ResolvedSettings | null {
  const resolved: EntitySettings = {}
  const sources: ResolvedSettings['sources'] = {}
  let local: EntitySettings = {}

  // Collect settings from the entity and its ancestors (bottom-up)
  const chain = buildAncestorChain(entityId, entityType, docStore)
  if (chain.length === 0) return null

  // Local settings are from the entity itself
  local = chain[0]!.settings ?? {}

  // Walk from deepest to root — closest wins
  for (const { settings, type, name } of chain) {
    if (!settings) continue
    for (const key of Object.keys(settings) as (keyof EntitySettings)[]) {
      if (settings[key] !== undefined && resolved[key] === undefined) {
        ;(resolved as Record<string, unknown>)[key] = settings[key]
        if (!(key in local) || local[key] === undefined) {
          sources[key] = { type, name }
        }
      }
    }
  }

  return { resolved, sources, local }
}

interface AncestorEntry {
  settings: EntitySettings | undefined
  type: GroupingDimension
  name: string
}

function buildAncestorChain(
  entityId: string,
  entityType: GroupingDimension,
  docStore: DocumentStore,
): AncestorEntry[] {
  const chain: AncestorEntry[] = []

  if (entityType === 'task') {
    const task = docStore.getTask(entityId)
    if (!task) return []
    chain.push({ settings: task.settings, type: 'task', name: task.name })

    // Resolve the initiative through the epic when the task is parented under
    // one — a task seated in an epic usually carries no direct initiativeId, so
    // fall back to the epic's initiative or the initiative tier is dropped.
    let initiativeId = task.initiativeId
    if (task.epicId) {
      const epic = docStore.getEpic(task.epicId)
      if (epic) {
        chain.push({ settings: epic.settings, type: 'epic', name: epic.name })
        if (!initiativeId) initiativeId = epic.initiativeId
      }
    }

    if (initiativeId) {
      const init = docStore.getInitiative(initiativeId)
      if (init) chain.push({ settings: init.settings, type: 'initiative', name: init.name })
    }
  } else if (entityType === 'epic') {
    const epic = docStore.getEpic(entityId)
    if (!epic) return []
    chain.push({ settings: epic.settings, type: 'epic', name: epic.name })

    if (epic.initiativeId) {
      const init = docStore.getInitiative(epic.initiativeId)
      if (init) chain.push({ settings: init.settings, type: 'initiative', name: init.name })
    }
  } else if (entityType === 'initiative') {
    const init = docStore.getInitiative(entityId)
    if (!init) return []
    chain.push({ settings: init.settings, type: 'initiative', name: init.name })
  }

  return chain
}
