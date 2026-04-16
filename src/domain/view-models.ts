import type {
  Run,
  GroupingDimension,
  TreeNode,
  RunSummaryViewModel,
} from './types'
import type { RunRepository, TaxonomyRepository } from './repositories'
import { buildGroupTree } from './grouping'

/**
 * Convert a Run + taxonomy lookups into a flat RunSummaryViewModel
 * suitable for rendering in tile components.
 */
export function toRunSummary(
  run: Run,
  taxonomy: TaxonomyRepository,
): RunSummaryViewModel {
  const initiative = taxonomy.getInitiativeForRun(run)
  const epic = taxonomy.getEpicForRun(run)
  const task = taxonomy.getTaskForRun(run)
  const worktree = taxonomy.getWorktreeForRun(run)

  const recapEntries = run.recapEntries ?? []
  const touchedFiles = run.touchedFiles ?? []

  // Use the most recent recap entry timestamp, or createdAt as fallback
  const lastEntry = recapEntries[recapEntries.length - 1]
  const lastActivity = lastEntry?.timestamp ?? run.createdAt

  return {
    id: `summary-${run.id}`,
    runId: run.id,
    title: task?.name ?? run.task ?? run.id,
    status: run.status,
    initiative: initiative?.name ?? 'Unknown',
    epic: epic?.name ?? 'Unknown',
    task: task?.name ?? 'Unknown',
    worktree: worktree?.name ?? 'Unknown',
    fileCount: touchedFiles.length,
    lastActivity,
    lastRecap: lastEntry?.content ?? null,
  }
}

/**
 * Build the complete workspace view: sidebar tree, tree nodes,
 * and run summaries — all from the given dimensions.
 */
export function buildWorkspaceView(
  dimensions: GroupingDimension[],
  runRepo: RunRepository,
  taxRepo: TaxonomyRepository,
): {
  sidebarTree: TreeNode[]
  runSummaries: Map<string, RunSummaryViewModel>
} {
  const runs = runRepo.getAll()
  const sidebarTree = buildGroupTree(runs, dimensions, taxRepo)
  const runSummaries = new Map<string, RunSummaryViewModel>()
  for (const run of runs) {
    runSummaries.set(run.id, toRunSummary(run, taxRepo))
  }
  return { sidebarTree, runSummaries }
}

export function findNodeLabel(nodes: TreeNode[], targetId: string): string | null {
  for (const node of nodes) {
    if (node.id === targetId) return node.label
    const children = node.children ?? []
    if (children.length > 0) {
      const found = findNodeLabel(children, targetId)
      if (found) return found
    }
  }
  return null
}
