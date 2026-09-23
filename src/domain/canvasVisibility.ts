import type { TreeNode } from './types'

/**
 * The tree the canvas lays out: drops runs the user hid, and — until the plugin boot
 * pipeline has finished — runs that name a plugin `view`. A plugin's widget is not
 * registered yet on a cold load, so a default layout computed now would size such a
 * run as a run-workspace (2400x1230) and persist that. Held-back runs join the tree
 * once plugins are booted, when their own widget size is known.
 */
export function pruneCanvasRuns(
  nodes: TreeNode[],
  opts: { hiddenRunIds: ReadonlySet<string>; pluginsBooted: boolean },
): TreeNode[] {
  if (opts.hiddenRunIds.size === 0 && opts.pluginsBooted) return nodes
  const prune = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = []
    for (const node of list) {
      if (node.type === 'run' && (opts.hiddenRunIds.has(node.entityId) || (!opts.pluginsBooted && node.view))) continue
      if (node.children.length === 0) {
        out.push(node)
        continue
      }
      out.push({ ...node, children: prune(node.children) })
    }
    return out
  }
  return prune(nodes)
}
