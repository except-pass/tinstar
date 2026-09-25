import type { Epic, PortfolioDoc } from '../portfolio/types'

/** Completed epics stay on the active board through this age, then hide. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Hide only when completion time is older than seven days.
 * The column name is not an input.
 */
export function epicHiddenFromActiveBoard(
  epic: Pick<Epic, 'completedAt'>,
  nowMs: number,
): boolean {
  if (!epic.completedAt) return false
  const completed = Date.parse(epic.completedAt)
  if (!Number.isFinite(completed)) return false
  return nowMs - completed > RETENTION_MS
}

export function activeBoard(doc: PortfolioDoc, nowMs: number): {
  board: PortfolioDoc
  archivedEpicIds: string[]
} {
  const archivedEpicIds: string[] = []
  const epics = doc.epics.filter(epic => {
    if (!epicHiddenFromActiveBoard(epic, nowMs)) return true
    archivedEpicIds.push(epic.id)
    return false
  })
  return {
    board: { ...doc, epics },
    archivedEpicIds,
  }
}
