import type { OrganizationalScope, TreeNode, Worktree } from './types'

export function normalizedScope(scope: OrganizationalScope | undefined): OrganizationalScope {
  const project = scope?.project?.trim()
  if (!project) return {}
  const worktree = scope?.worktree?.trim()
  return worktree ? { project, worktree } : { project }
}

function totals(children: TreeNode[]): Pick<TreeNode, 'runCount' | 'activeCount'> {
  return children.reduce(
    (sum, child) => ({
      runCount: sum.runCount + child.runCount,
      activeCount: sum.activeCount + child.activeCount,
    }),
    { runCount: 0, activeCount: 0 },
  )
}

function worktreeNode(project: string, worktree: string, children: TreeNode[]): TreeNode {
  return {
    id: `worktree-${project}--${worktree}`,
    entityId: worktree,
    label: worktree,
    type: 'worktree',
    children,
    ...totals(children),
    scope: { project, worktree },
  }
}

/** Build the one live organizational hierarchy used by both sidebar and canvas. */
export function buildScopeTree(
  leaves: TreeNode[],
  registeredProjects: string[],
  registeredWorktrees: Worktree[],
): TreeNode[] {
  const projectOrder: string[] = []
  const projectNames = new Set<string>()
  const rememberProject = (name: string | undefined) => {
    const trimmed = name?.trim()
    if (!trimmed || projectNames.has(trimmed)) return
    projectNames.add(trimmed)
    projectOrder.push(trimmed)
  }

  registeredProjects.forEach(rememberProject)
  registeredWorktrees.forEach(worktree => rememberProject(worktree.repo))
  leaves.forEach(leaf => rememberProject(normalizedScope(leaf.scope).project))

  const unscoped: TreeNode[] = []
  const directByProject = new Map<string, TreeNode[]>()
  const byWorktree = new Map<string, TreeNode[]>()

  for (const leaf of leaves) {
    const scope = normalizedScope(leaf.scope)
    if (!scope.project) {
      unscoped.push(leaf)
      continue
    }
    if (!scope.worktree) {
      const direct = directByProject.get(scope.project) ?? []
      direct.push(leaf)
      directByProject.set(scope.project, direct)
      continue
    }
    const key = `${scope.project}\0${scope.worktree}`
    const scoped = byWorktree.get(key) ?? []
    scoped.push(leaf)
    byWorktree.set(key, scoped)
  }

  const result: TreeNode[] = projectOrder.map(project => {
    const children = [...(directByProject.get(project) ?? [])]
    const seenWorktrees = new Set<string>()
    const addWorktree = (name: string) => {
      if (!name || seenWorktrees.has(name)) return
      seenWorktrees.add(name)
      children.push(worktreeNode(project, name, byWorktree.get(`${project}\0${name}`) ?? []))
    }
    registeredWorktrees
      .filter(worktree => worktree.repo === project)
      .forEach(worktree => addWorktree(worktree.branch || worktree.name))
    for (const key of byWorktree.keys()) {
      const [owner, name] = key.split('\0')
      if (owner === project && name) addWorktree(name)
    }
    return {
      id: `project-${project}`,
      entityId: project,
      label: project,
      type: 'project',
      children,
      ...totals(children),
      scope: { project },
    }
  })

  if (unscoped.length > 0) {
    result.push({
      id: 'unscoped',
      entityId: '',
      label: 'Unscoped',
      type: 'unscoped',
      children: unscoped,
      ...totals(unscoped),
      scope: {},
    })
  }

  return result
}

/** Unscoped is a hierarchy area, never a canvas container. */
export function flattenUnscopedForCanvas(tree: TreeNode[]): TreeNode[] {
  return tree.flatMap(node => node.type === 'unscoped' ? node.children : [node])
}
