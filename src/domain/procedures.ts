import type { ResolvedProcedure } from '../types'
import type { TaxonomyRepository } from './repositories'

/**
 * Resolve the full procedure list for a given task ID by merging
 * the task's own procedures with those inherited from its Epic and Initiative.
 * Task procedures come first (own), then Epic, then Initiative.
 */
export function resolveEntityProcedures(
  taskId: string,
  taxRepo: TaxonomyRepository,
): ResolvedProcedure[] {
  const result: ResolvedProcedure[] = []

  const task = taxRepo.getTaskById(taskId)
  if (!task) return result

  for (const p of task.settings?.procedures ?? []) {
    result.push({ ...p, entityId: task.id, entityType: 'task' })
  }

  if (task.epicId) {
    const epic = taxRepo.getEpicById(task.epicId)
    if (epic) {
      for (const p of epic.settings?.procedures ?? []) {
        result.push({ ...p, entityId: epic.id, entityType: 'epic' })
      }

      if (epic.initiativeId) {
        const initiative = taxRepo.getInitiativeById(epic.initiativeId)
        if (initiative) {
          for (const p of initiative.settings?.procedures ?? []) {
            result.push({ ...p, entityId: initiative.id, entityType: 'initiative' })
          }
        }
      }
    }
  }

  return result
}
