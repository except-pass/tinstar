// Canonical visibility predicate for background sessions (R4–R7, R16).
//
// A background run is pruned from the canvas, hierarchy sidebar, and session
// cycling iff it is background AND the reveal toggle is off AND it has no
// pending attention. Attention exempts the run from pruning on every surface
// so its breakthrough inbox row always points at a real card; when attention
// clears it returns to invisibility (R16). Non-background runs are never
// affected.
//
// Distinct from the hidden-runs eyeball (`useHiddenRuns`): that mechanism dims
// runs in the sidebar and prunes them only from the canvas. The two coexist
// with different semantics and must not be merged.
//
// Passive inbox rows are governed separately in `useInbox`: background runs
// never produce them, even when the reveal toggle is on.

import type { Run, TreeNode } from './types'

/** True when the run must be pruned from canvas, sidebar, and cycling. */
export function isBackgroundHidden(
  run: Pick<Run, 'background' | 'attention'>,
  showBackgroundSessions: boolean,
): boolean {
  return run.background && !showBackgroundSessions && !run.attention
}

/** Ids of the runs currently prune-eligible under the canonical predicate. */
export function backgroundHiddenRunIds(
  runs: Iterable<Pick<Run, 'id' | 'background' | 'attention'>>,
  showBackgroundSessions: boolean,
): Set<string> {
  const out = new Set<string>()
  for (const run of runs) {
    if (isBackgroundHidden(run, showBackgroundSessions)) out.add(run.id)
  }
  return out
}

/**
 * Drop run nodes whose entityId is in `prunedIds` from a workspace tree.
 * Container nodes are kept (possibly emptied) — mirroring the canvas
 * hidden-runs prune. Subtrees with no pruned descendants keep their identity
 * so React memo consumers don't re-render. Callers should short-circuit on
 * `prunedIds.size === 0` and skip the walk entirely.
 */
export function pruneRunNodes(nodes: TreeNode[], prunedIds: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = []
  for (const node of nodes) {
    if (node.type === 'run' && prunedIds.has(node.entityId)) continue
    if (node.children.length === 0) {
      out.push(node)
      continue
    }
    const children = pruneRunNodes(node.children, prunedIds)
    if (children === node.children) out.push(node)
    else out.push({ ...node, children })
  }
  // Preserve identity when nothing changed at this level or below.
  if (out.length === nodes.length && out.every((n, i) => n === nodes[i])) return nodes
  return out
}
