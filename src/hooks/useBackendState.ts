import { useMemo } from 'react'
import { useServerEvents } from './useServerEvents'
import { RunRepository, TaxonomyRepository } from '../domain/repositories'

export function useBackendState() {
  const { state, connected, loading } = useServerEvents()

  const runRepo = useMemo(
    () => new RunRepository(state.runs),
    [state.runs],
  )

  const taxRepo = useMemo(
    () => new TaxonomyRepository(
      state.initiatives,
      state.epics,
      state.tasks,
      state.worktrees,
    ),
    [state.initiatives, state.epics, state.tasks, state.worktrees],
  )

  return { runRepo, taxRepo, connected, loading }
}
