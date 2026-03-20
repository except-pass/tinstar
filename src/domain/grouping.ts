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

/** Get all entities for a dimension from the taxonomy (even those with no runs) */
function getAllEntitiesForDimension(
  dimension: GroupingDimension,
  taxonomy: TaxonomyRepository,
): Array<{ id: string; label: string; color?: string }> {
  switch (dimension) {
    case 'initiative':
      return taxonomy.getInitiatives().map(i => ({ id: i.id, label: i.name, color: i.settings?.defaultRunColor ?? i.color }))
    case 'epic':
      return taxonomy.getEpics().map(e => ({ id: e.id, label: e.name, color: e.settings?.defaultRunColor }))
    case 'task':
      return taxonomy.getTasks().map(t => ({ id: t.id, label: t.name, color: t.settings?.defaultRunColor }))
    case 'worktree':
      return taxonomy.getWorktrees().map(w => ({ id: w.id, label: w.name }))
  }
}

/** Get child entities that belong to a specific parent entity */
function getChildEntitiesForParent(
  parentDimension: GroupingDimension,
  parentEntityId: string,
  childDimension: GroupingDimension,
  taxonomy: TaxonomyRepository,
): Array<{ id: string; label: string; color?: string }> {
  if (parentDimension === 'initiative' && childDimension === 'epic') {
    return taxonomy.getEpicsByInitiative(parentEntityId).map(e => ({ id: e.id, label: e.name, color: e.settings?.defaultRunColor }))
  }
  if (parentDimension === 'epic' && childDimension === 'task') {
    return taxonomy.getTasksByEpic(parentEntityId).map(t => ({ id: t.id, label: t.name, color: t.settings?.defaultRunColor }))
  }
  return []
}

/** Get orphan entities — those whose parent FK is empty or points to a missing entity */
function getOrphanEntities(
  dimension: GroupingDimension,
  parentDimension: GroupingDimension | undefined,
  taxonomy: TaxonomyRepository,
): Array<{ id: string; label: string; color?: string }> {
  if (!parentDimension) return []

  if (parentDimension === 'initiative' && dimension === 'epic') {
    const initIds = new Set(taxonomy.getInitiatives().map(i => i.id))
    return taxonomy.getEpics()
      .filter(e => !e.initiativeId || !initIds.has(e.initiativeId))
      .map(e => ({ id: e.id, label: e.name }))
  }
  if (parentDimension === 'epic' && dimension === 'task') {
    const epicIds = new Set(taxonomy.getEpics().map(e => e.id))
    return taxonomy.getTasks()
      .filter(t => !t.epicId || !epicIds.has(t.epicId))
      .map(t => ({ id: t.id, label: t.name }))
  }
  if (parentDimension === 'initiative' && dimension === 'task') {
    const initIds = new Set(taxonomy.getInitiatives().map(i => i.id))
    const epicById = new Map(taxonomy.getEpics().map(e => [e.id, e]))
    return taxonomy.getTasks()
      .filter(t => {
        if (t.initiativeId && initIds.has(t.initiativeId)) return false
        // Task reachable via epic chain is not an orphan
        if (t.epicId) {
          const epic = epicById.get(t.epicId)
          if (epic?.initiativeId && initIds.has(epic.initiativeId)) return false
        }
        return true
      })
      .map(t => ({ id: t.id, label: t.name }))
  }
  return []
}

/**
 * Build a hierarchical tree of TreeNodes by recursively grouping runs
 * along the given dimension order.
 *
 * Algorithm: Take first dimension, group runs by that dimension's value,
 * create a TreeNode per group, recurse with remaining dimensions.
 * Leaf-level children are individual run nodes.
 *
 * Entities that exist in the taxonomy but have no runs are included as
 * empty nodes so they're visible in the sidebar and canvas.
 * Orphan entities (missing parent) appear after a separator at each level.
 */
export function buildGroupTree(
  runs: Run[],
  dimensions: GroupingDimension[],
  taxonomy: TaxonomyRepository,
  _isRoot = true,
  _parentDimension?: GroupingDimension,
  _parentEntityId?: string,
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
      activeCount: run.status === 'running' ? 1 : 0,
      color: STATUS_BORDER_COLORS[run.status],
      backend: run.backend,
    }))
  }

  const dimension: GroupingDimension = dimensions[0]!
  const remaining = dimensions.slice(1)

  // Group runs by this dimension's value
  const groups = new Map<string, { label: string; color?: string; runs: Run[] }>()
  const orphanRuns: Run[] = []

  for (const run of runs) {
    const resolved = taxonomy.resolveDimension(run, dimension)
    if (!resolved) {
      orphanRuns.push(run)
      continue
    }

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

  // Include empty entities so they're visible even without runs
  if (_isRoot) {
    // Root level: include all entities for this dimension
    for (const entity of getAllEntitiesForDimension(dimension, taxonomy)) {
      if (!groups.has(entity.id)) {
        groups.set(entity.id, { label: entity.label, color: entity.color, runs: [] })
      }
    }
  } else if (_parentDimension && _parentEntityId) {
    // Nested level: include child entities that belong to this parent
    for (const entity of getChildEntitiesForParent(_parentDimension, _parentEntityId, dimension, taxonomy)) {
      if (!groups.has(entity.id)) {
        groups.set(entity.id, { label: entity.label, color: entity.color, runs: [] })
      }
    }
  }

  // Build tree nodes for each group
  const nodes: TreeNode[] = []
  for (const [entityId, group] of groups) {
    const children = buildGroupTree(group.runs, remaining, taxonomy, false, dimension, entityId)
    const activeCount = group.runs.filter(r => r.status === 'running').length

    const node: TreeNode = {
      id: `${dimension}-${entityId}`,
      label: group.label,
      type: dimension,
      entityId,
      children,
      runCount: group.runs.length,
      activeCount,
      color: group.color,
    }
    if (dimension === 'task') {
      const task = taxonomy.getTaskById(entityId)
      node.percentDone = task?.percentDone ?? null
      node.status = task?.status
      node.externalUrl = task?.externalUrl ?? null
    }
    nodes.push(node)
  }

  // Non-root orphan runs: runs that don't match any entity for this dimension
  // still need to appear as direct children (e.g. a run with no worktree
  // inside a task group when grouping by ['task', 'worktree'])
  if (!_isRoot && orphanRuns.length > 0) {
    if (remaining.length > 0) {
      // Recurse orphans through remaining dimensions
      const orphanChildren = buildGroupTree(orphanRuns, remaining, taxonomy, false)
      nodes.push(...orphanChildren)
    } else {
      // Leaf level: emit as run nodes
      for (const run of orphanRuns) {
        nodes.push({
          id: `run-${run.id}`,
          label: run.id,
          type: 'run' as const,
          entityId: run.id,
          children: [],
          runCount: 1,
          activeCount: run.status === 'running' ? 1 : 0,
          color: STATUS_BORDER_COLORS[run.status],
          backend: run.backend,
        })
      }
    }
  }

  // Add orphan entities (those with missing/empty parent) at root level
  if (_isRoot) {
    void _parentDimension // undefined at true root
    // For the root level, the "parent dimension" is the dimension ABOVE
    // the current one in the original hierarchy (not passed down).
    // We detect orphans of the NEXT dimension whose parent in THIS dimension is missing.
    // But more importantly, we detect orphan entities of THIS dimension that
    // don't have a parent in the dimension above (i.e., dimensions not in our list).
    // This is handled by getAllEntitiesForDimension already including them.

    // Orphan entities of lower dimensions that float up to root:
    // e.g. epics with no initiative when dimensions = ['initiative', 'epic', 'task']
    // Track all node IDs already present anywhere in the tree (including descendants of
    // orphan nodes added in earlier iterations) to avoid duplicates like baserepo appearing
    // both under an orphan epic AND as a standalone orphan task.
    const addedNodeIds = new Set<string>()
    function trackNodeIds(n: TreeNode) {
      addedNodeIds.add(n.id)
      for (const c of n.children) trackNodeIds(c)
    }
    for (const n of nodes) trackNodeIds(n)

    for (const lowerDim of dimensions.slice(1)) {
      const orphanEntities = getOrphanEntities(lowerDim, dimension, taxonomy)
      for (const entity of orphanEntities) {
        // Only add if not already present anywhere in the tree (including as a descendant
        // of an orphan node added in a previous lowerDim iteration)
        const nodeId = `${lowerDim}-${entity.id}`
        if (!addedNodeIds.has(nodeId)) {
          // Build sub-tree for this orphan entity's runs
          const entityRuns = orphanRuns.filter(run => {
            const resolved = taxonomy.resolveDimension(run, lowerDim)
            return resolved?.id === entity.id
          })
          const subDims = dimensions.slice(dimensions.indexOf(lowerDim) + 1)
          const children = buildGroupTree(entityRuns, subDims, taxonomy, false, lowerDim, entity.id)

          const newNode: TreeNode = {
            id: nodeId,
            label: entity.label,
            type: lowerDim,
            entityId: entity.id,
            children,
            runCount: entityRuns.length,
            activeCount: entityRuns.filter(r => r.status === 'running').length,
            color: entity.color,
            orphan: true,
          }
          nodes.push(newNode)
          trackNodeIds(newNode)
        }
      }
    }

    // Remaining truly orphan runs (not claimed by any orphan entity)
    const claimedRunIds = new Set<string>()
    for (const node of nodes) {
      if (node.orphan) collectRunIds(node, claimedRunIds)
    }
    for (const run of orphanRuns) {
      if (!claimedRunIds.has(run.id)) {
        nodes.push({
          id: `run-${run.id}`,
          label: run.id,
          type: 'run' as const,
          entityId: run.id,
          children: [],
          runCount: 1,
          activeCount: run.status === 'running' ? 1 : 0,
          color: STATUS_BORDER_COLORS[run.status],
          backend: run.backend,
          orphan: true,
        })
      }
    }
  }

  return nodes
}

function collectRunIds(node: TreeNode, ids: Set<string>): void {
  if (node.type === 'run') ids.add(node.entityId)
  for (const child of node.children) collectRunIds(child, ids)
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
    type: groupType as GroupingDimension,
    runCount: nodeRuns.length,
    activeCount: nodeRuns.filter(r => r.status === 'running').length,
    completedCount: nodeRuns.filter(r => r.status === 'stopped').length,
    failedCount: nodeRuns.filter(r => r.status === 'stopped').length,
  }
}
