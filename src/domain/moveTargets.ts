import type { TreeNode } from './types'

export interface MoveTarget { id: string; label: string; slots: number[] }

/** Open, relocatable widgets for the "Move widget here" picker: every non-container
 *  tree node that currently has a layout, labeled and annotated with its
 *  constellation slot(s). Pure — callers inject container/label/slot lookups. */
export function buildMoveTargets(
  tree: TreeNode[],
  layouts: Map<string, { x: number; y: number; width: number; height: number }>,
  lookups: { isContainer: (id: string) => boolean; labelOf: (id: string) => string; slotsOf: (id: string) => number[] },
): MoveTarget[] {
  const out: MoveTarget[] = []
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (lookups.isContainer(n.id)) { walk(n.children); continue }
      if (layouts.has(n.id)) out.push({ id: n.id, label: lookups.labelOf(n.id), slots: lookups.slotsOf(n.id) })
    }
  }
  walk(tree)
  return out
}
