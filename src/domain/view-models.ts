import { useMemo } from 'react'
import type {
  Run,
  GroupingDimension,
  TreeNode,
  RunSummaryViewModel,
} from './types'
import type { RunRepository, TaxonomyRepository } from './repositories'
import { runRepository, taxonomyRepository } from './repositories'
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

  const activeProcedures = run.procedures.filter(
    p => p.status === 'running',
  ).length

  // Use the most recent recap entry timestamp, or createdAt as fallback
  const lastEntry = run.recapEntries[run.recapEntries.length - 1]
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
    fileCount: run.touchedFiles.length,
    procedureCount: run.procedures.length,
    activeProcedures,
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
  treeNodes: TreeNode[]
  runSummaries: Map<string, RunSummaryViewModel>
} {
  const runs = runRepo.getAll()

  // Build hierarchical tree from runs grouped by dimensions
  const sidebarTree = buildGroupTree(runs, dimensions, taxRepo)
  const treeNodes = sidebarTree

  // Build run summary lookup
  const runSummaries = new Map<string, RunSummaryViewModel>()
  for (const run of runs) {
    runSummaries.set(run.id, toRunSummary(run, taxRepo))
  }

  return { sidebarTree, treeNodes, runSummaries }
}

/**
 * React hook that builds the workspace view using the singleton repositories.
 * Memoizes the result based on dimensions.
 */
export function useWorkspaceView(
  dimensions: GroupingDimension[],
): {
  sidebarTree: TreeNode[]
  treeNodes: TreeNode[]
  runSummaries: Map<string, RunSummaryViewModel>
  loading: boolean
} {
  const result = useMemo(
    () => buildWorkspaceView(dimensions, runRepository, taxonomyRepository),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dimensions.join(',')],
  )

  return { ...result, loading: false }
}
