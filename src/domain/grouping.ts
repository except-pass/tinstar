import type { Run, GroupingDimension, TreeNode, GroupRollupViewModel } from './types'
import type { TaxonomyRepository } from './repositories'
import { STATUS_BORDER_COLORS } from './status-colors'

/**
 * Resolve a run's value for a given grouping dimension.
 * Returns { id, label, color? } or undefined if the dimension can't be resolved.
 */
export function getRunDimensionValue(
  run: Run,
  dimension: GroupingDimension,
  taxonomy: TaxonomyRepository,
): { id: string; label: string; color?: string } | undefined {
  return taxonomy.resolveDimension(run, dimension)
}

/**
 * Build a hierarchical tree of TreeNodes by recursively grouping runs
 * along the given dimension order.
 *
 * Algorithm: Take first dimension, group runs by that dimension's value,
 * create a TreeNode per group, recurse with remaining dimensions.
 * Leaf-level children are individual run nodes.
 */
export function buildGroupTree(
  runs: Run[],
  dimensions: GroupingDimension[],
  taxonomy: TaxonomyRepository,
): TreeNode[] {
  if (dimensions.length === 0) {
    // No more dimensions — return run leaf nodes
    return runs.map(run => ({
      id: `run-${run.id}`,
      label: run.id,
      type: 'run' as const,
      entityId: run.id,
      children: [],
      runCount: 1,
      activeCount: run.status === 'active' ? 1 : 0,
      color: STATUS_BORDER_COLORS[run.status],
    }))
  }

  const dimension: GroupingDimension = dimensions[0]!
  const remaining = dimensions.slice(1)

  // Group runs by this dimension's value
  const groups = new Map<string, { label: string; color?: string; runs: Run[] }>()

  for (const run of runs) {
    const resolved = taxonomy.resolveDimension(run, dimension)
    if (!resolved) continue

    const existing = groups.get(resolved.id)
    if (existing) {
      existing.runs.push(run)
    } else {
      groups.set(resolved.id, {
        label: resolved.label,
        color: resolved.color,
        runs: [run],
      })
    }
  }

  // Build tree nodes for each group
  const nodes: TreeNode[] = []
  for (const [entityId, group] of groups) {
    const children = buildGroupTree(group.runs, remaining, taxonomy)
    const activeCount = group.runs.filter(r => r.status === 'active').length

    nodes.push({
      id: `${dimension}-${entityId}`,
      label: group.label,
      type: dimension,
      entityId,
      children,
      runCount: group.runs.length,
      activeCount,
      color: group.color,
    })
  }

  return nodes
}

/**
 * Flatten a tree of TreeNodes into a Map keyed by node id.
 * Includes all nodes at every depth.
 */
export function flattenTree(nodes: TreeNode[]): Map<string, TreeNode> {
  const map = new Map<string, TreeNode>()

  function walk(nodeList: TreeNode[]) {
    for (const node of nodeList) {
      map.set(node.id, node)
      if (node.children.length > 0) {
        walk(node.children)
      }
    }
  }

  walk(nodes)
  return map
}

/**
 * Compute a rollup view model for a group node by aggregating
 * the statuses of all runs beneath it.
 */
export function computeRollup(node: TreeNode, runs: Run[]): GroupRollupViewModel {
  // Collect all run entity IDs under this node
  const runIds = new Set<string>()

  function collectRunIds(n: TreeNode) {
    if (n.type === 'run') {
      runIds.add(n.entityId)
    } else {
      for (const child of n.children) {
        collectRunIds(child)
      }
    }
  }

  collectRunIds(node)

  // Filter runs that belong to this node
  const nodeRuns = runs.filter(r => runIds.has(r.id))
  const groupType = node.type === 'run' ? 'task' : node.type

  return {
    id: node.id,
    label: node.label,
    type: groupType,
    runCount: nodeRuns.length,
    activeCount: nodeRuns.filter(r => r.status === 'active').length,
    completedCount: nodeRuns.filter(r => r.status === 'complete').length,
    failedCount: nodeRuns.filter(r => r.status === 'failed').length,
  }
}
