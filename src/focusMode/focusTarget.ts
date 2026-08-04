import { DEFAULT_RUN_VIEW } from '../domain/runView'
import { orderByHierarchy } from '../hooks/useReadyQueue'

export interface FocusRunCandidate {
  id: string
  status: string
  /** Absent (or the built-in registration name) means the standard Run Workspace. */
  view?: string
}

export type FocusTargetResolution =
  | { kind: 'resolving' }
  | { kind: 'focused'; runId: string }
  | { kind: 'empty' }
  | { kind: 'no-live' }

export interface ResolveFocusTargetInput {
  hydrated: boolean
  runs: readonly FocusRunCandidate[]
  selectedRunId?: string | null
  currentRunId?: string | null
  /** Existing Tinstar session order, already scoped to the active space. */
  orderedCandidateIds: readonly string[]
  /** View-hidden/background-pruned runs cannot become a fresh fallback. */
  excludedRunIds?: ReadonlySet<string>
}

export function isBuiltInRunWorkspace(run: FocusRunCandidate | undefined): run is FocusRunCandidate {
  return !!run && (!run.view || run.view === DEFAULT_RUN_VIEW)
}

/** Keep the hierarchy's visible order as the lead, then append eligible runs
 * hidden only by branch collapse. Focus must remain cyclable when the hierarchy
 * itself is collapsed; hidden/background filtering happens before this helper. */
export function focusCycleQueue(candidates: readonly string[], visibleOrder: readonly string[]): string[] {
  return orderByHierarchy([...candidates], [...visibleOrder])
}

/** Focus never crosses the active space. Legacy spaceless runs remain visible
 * in whichever space is active, matching the canvas's existing migration rule. */
export function runsInFocusSpace<T extends { spaceId?: string }>(
  runs: readonly T[],
  activeSpaceId: string | null | undefined,
): T[] {
  return runs.filter(run => !activeSpaceId || !run.spaceId || run.spaceId === activeSpaceId)
}

/**
 * Resolve Focus against live state only. Explicit selected/current targets may
 * be stopped, but every automatic fallback must be a live built-in workspace.
 */
export function resolveFocusTarget({
  hydrated,
  runs,
  selectedRunId,
  currentRunId,
  orderedCandidateIds,
  excludedRunIds = new Set<string>(),
}: ResolveFocusTargetInput): FocusTargetResolution {
  if (!hydrated) return { kind: 'resolving' }

  const byId = new Map(runs.map(run => [run.id, run]))
  const explicit = [selectedRunId, currentRunId]
    .map(id => id ? byId.get(id) : undefined)
    .find(run => isBuiltInRunWorkspace(run) && !excludedRunIds.has(run.id))
  if (explicit) return { kind: 'focused', runId: explicit.id }

  for (const id of orderedCandidateIds) {
    const candidate = byId.get(id)
    if (
      isBuiltInRunWorkspace(candidate)
      && candidate.status !== 'stopped'
      && !excludedRunIds.has(candidate.id)
    ) {
      return { kind: 'focused', runId: candidate.id }
    }
  }

  // The order source can temporarily omit rows (for example while the sidebar
  // reports after mount). Preserve repository order as the final live fallback.
  const fallback = runs.find(run =>
    isBuiltInRunWorkspace(run)
    && run.status !== 'stopped'
    && !excludedRunIds.has(run.id),
  )
  if (fallback) return { kind: 'focused', runId: fallback.id }

  return runs.length === 0 ? { kind: 'empty' } : { kind: 'no-live' }
}
