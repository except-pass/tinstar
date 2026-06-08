// src/hooks/useReadyQueue.ts
import type { Run, TreeNode } from '../domain/types'

/**
 * Run ids in the exact top-to-bottom order the hierarchy renders them: a branch
 * is walked only when it's expanded, so collapsed (and search-pruned, since the
 * caller passes the already-pruned tree) runs are omitted just as on screen.
 */
export function orderedVisibleRunIds(nodes: TreeNode[], isExpanded: (id: string) => boolean): string[] {
  const out: string[] = []
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.type === 'run') out.push(n.entityId)
      if (n.children.length > 0 && isExpanded(n.id)) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/**
 * Reorder session names to match their top-to-bottom position in the hierarchy.
 * Names present in `hierarchyOrder` come first, in that order; any names not
 * found (e.g. a ready session in another space, not shown in the active tree)
 * keep their original relative order at the end so nothing is dropped from the
 * cycle. Stable for equal ranks.
 */
export function orderByHierarchy(names: string[], hierarchyOrder: string[]): string[] {
  const rank = new Map<string, number>()
  hierarchyOrder.forEach((name, i) => { if (!rank.has(name)) rank.set(name, i) })
  const rankOf = (name: string) => rank.get(name) ?? Number.MAX_SAFE_INTEGER
  return [...names].sort((a, b) => rankOf(a) - rankOf(b))
}

/**
 * Restrict a cycle candidate set (ready/active sessions) to the sessions actually
 * visible in the sidebar, preserving the sidebar's order. Candidates absent from
 * `visibleOrder` are dropped entirely — not pushed to the end — so collapsed,
 * search-pruned, or inbox-filtered sessions can't be cycled to. Falls back to the
 * candidates only before the sidebar has reported any order yet (`hasReported`
 * false); once it has reported, an empty order yields an empty queue rather than
 * resurrecting the filtered-out sessions.
 */
export function visibleCycleQueue(candidates: string[], visibleOrder: string[], hasReported: boolean): string[] {
  if (!hasReported) return candidates
  const set = new Set(candidates)
  return visibleOrder.filter(name => set.has(name))
}

export function cycleNext(
  runs: Run[],
  names: string[],
  currentRunId: string | null,
): Run | null {
  if (names.length === 0) return null
  const currentName = runs.find(r => r.id === currentRunId)?.sessionId ?? null
  const idx = currentName ? names.indexOf(currentName) : -1
  const nextName = names[(idx + 1) % names.length]
  return runs.find(r => r.sessionId === nextName) ?? null
}

export function cyclePrev(
  runs: Run[],
  names: string[],
  currentRunId: string | null,
): Run | null {
  if (names.length === 0) return null
  const currentName = runs.find(r => r.id === currentRunId)?.sessionId ?? null
  const idx = currentName ? names.indexOf(currentName) : 0
  const prevName = names[(idx - 1 + names.length) % names.length]
  return runs.find(r => r.sessionId === prevName) ?? null
}
