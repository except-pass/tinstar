import { useEffect, useState } from 'react'
import { useBackendState } from './useBackendState'
import { useBackendReachable } from './useBackendReachable'
import { apiUrl } from '../apiClient'
import type { Space } from '../domain/types'

export type OnboardingStep = 'connect' | 'workspace' | 'project' | 'first_session'
export type StepStatus = 'pending' | 'active' | 'completed'

interface Inputs {
  reachable: boolean
  spaces: string[]
  projects: string[]
  runCount: number
}

const ORDER: OnboardingStep[] = ['connect', 'workspace', 'project', 'first_session']

export function computeOnboardingState(inputs: Inputs): {
  active: OnboardingStep | null
  steps: { id: OnboardingStep; status: StepStatus }[]
} {
  const predicates: Record<OnboardingStep, boolean> = {
    connect: inputs.reachable,
    workspace: inputs.spaces.length > 0,
    project: inputs.projects.length > 0,
    first_session: inputs.runCount > 0,
  }
  const active = ORDER.find(s => !predicates[s]) ?? null
  const steps = ORDER.map(id => ({
    id,
    status: (id === active
      ? 'active'
      : predicates[id]
        ? 'completed'
        : 'pending') as StepStatus,
  }))
  return { active, steps }
}

export function useOnboardingState() {
  const reachable = useBackendReachable()
  const { spaces, runRepo } = useBackendState()
  const [projects, setProjects] = useState<string[]>([])
  const [projectsVersion, setProjectsVersion] = useState(0)

  // Refresh when spaces change OR when the server notifies us of a project change
  useEffect(() => {
    const onChanged = () => setProjectsVersion(v => v + 1)
    window.addEventListener('tinstar:projects_changed', onChanged)
    return () => window.removeEventListener('tinstar:projects_changed', onChanged)
  }, [])

  useEffect(() => {
    if (!reachable) return
    let cancelled = false
    fetch(apiUrl('/api/projects'))
      .then(r => r.json())
      .then((resp: { ok: boolean; data?: Record<string, string> }) => {
        if (!cancelled) setProjects(Object.keys(resp.data ?? {}))
      })
      .catch(() => { /* ignore — predicate just stays empty */ })
    return () => { cancelled = true }
  }, [reachable, spaces.length, projectsVersion])

  return computeOnboardingState({
    reachable,
    spaces: spaces.map((s: Space) => s.id),
    projects,
    runCount: runRepo.getAll().length,
  })
}
