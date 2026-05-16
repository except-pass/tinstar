import { useEffect } from 'react'
import { useOnboardingState } from '../hooks/useOnboardingState'
import { useBackendState } from '../hooks/useBackendState'
import { StepCard } from './onboarding/StepCard'
import { ConnectStep } from './onboarding/ConnectStep'
import { WorkspaceStep } from './onboarding/WorkspaceStep'
import { ProjectStep } from './onboarding/ProjectStep'
import { FirstSessionStep } from './onboarding/FirstSessionStep'
import { apiUrl } from '../apiClient'

const BODIES = {
  connect: ConnectStep,
  workspace: WorkspaceStep,
  project: ProjectStep,
  first_session: FirstSessionStep,
} as const

export function OnboardingCanvas() {
  const { active, steps } = useOnboardingState()
  const { spaces } = useBackendState()

  // When all onboarding steps are complete, activate the first available space
  // so WorkspaceShell switches from OnboardingCanvas to the main workspace.
  useEffect(() => {
    if (active !== null) return
    const firstSpace = spaces[0]
    if (!firstSpace) return
    fetch(apiUrl(`/api/spaces/${firstSpace.id}/activate`), { method: 'POST' }).catch(() => {})
  }, [active, spaces])

  return (
    <div className="flex flex-col items-center justify-start h-full w-full overflow-y-auto bg-surface-base p-8">
      <div className="w-full max-w-2xl">
        <h1 className="font-display text-2xl text-cyan-300 mb-1">Welcome to Tinstar</h1>
        <p className="text-slate-400 text-sm mb-6">Let's get you set up.</p>
        {steps.map(step => {
          const Body = BODIES[step.id]
          return (
            <StepCard key={step.id} id={step.id} status={step.status} title={step.id}>
              <Body />
            </StepCard>
          )
        })}
      </div>
    </div>
  )
}
