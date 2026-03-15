// src/hooks/useReadyQueue.ts
import type { Run } from '../domain/types'

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
