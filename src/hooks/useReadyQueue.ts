// src/hooks/useReadyQueue.ts
import type { Run } from '../domain/types'

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
