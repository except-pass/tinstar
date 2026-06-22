import type { TreeNode } from './types'

/** How to draw a move-target's icon. Mirrors `AgentIcon`'s props so the menus can
 *  render it directly: `icon` is a URL or glyph; `seed`+`color` drive the procedural
 *  robot face used for run workspaces. All optional — absent fields fall back to a
 *  monogram in the renderer. */
export interface MoveTargetIcon { icon?: string; seed?: string; color?: string }

export interface MoveTarget { id: string; label: string; slots: number[]; icon?: MoveTargetIcon }

/** Open, relocatable widgets for the "Move widget here" picker: every non-container
 *  tree node that currently has a layout, labeled and annotated with its
 *  constellation slot(s) and an icon. Pure — callers inject container/label/slot/icon
 *  lookups. `iconOf` is optional; when omitted, targets carry no icon. */
export function buildMoveTargets(
  tree: TreeNode[],
  layouts: Map<string, { x: number; y: number; width: number; height: number }>,
  lookups: {
    isContainer: (id: string) => boolean
    labelOf: (id: string) => string
    slotsOf: (id: string) => number[]
    iconOf?: (id: string) => MoveTargetIcon | undefined
  },
): MoveTarget[] {
  const out: MoveTarget[] = []
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (lookups.isContainer(n.id)) { walk(n.children); continue }
      if (layouts.has(n.id)) {
        const icon = lookups.iconOf?.(n.id)
        out.push({ id: n.id, label: lookups.labelOf(n.id), slots: lookups.slotsOf(n.id), ...(icon && { icon }) })
      }
    }
  }
  walk(tree)
  return out
}
