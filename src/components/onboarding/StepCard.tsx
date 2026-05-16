import type { ReactNode } from 'react'
import type { OnboardingStep, StepStatus } from '../../hooks/useOnboardingState'

interface Props {
  id: OnboardingStep
  status: StepStatus
  title: string
  summary?: string
  children?: ReactNode
}

const TITLES: Record<OnboardingStep, string> = {
  connect: '1. Connect to a tinstar backend',
  workspace: '2. Create your first workspace',
  project: '3. Register a project',
  first_session: '4. Start your first session',
}

export function StepCard({ id, status, summary, children }: Props) {
  const expanded = status === 'active'
  return (
    <section
      data-testid={`onboarding-step-${id}`}
      data-status={status}
      className={`border rounded-md p-4 mb-3 transition-all ${
        status === 'completed' ? 'opacity-60 border-emerald-700/40 bg-emerald-900/10'
        : status === 'active' ? 'border-cyan-400/60 bg-surface-panel/60'
        : 'opacity-40 border-white/10'
      }`}
    >
      <header className="flex items-center gap-2">
        {status === 'completed' && <span className="material-symbols-outlined text-emerald-400 text-base">check_circle</span>}
        <h2 className="font-display text-lg">{TITLES[id]}</h2>
        {summary && <span className="text-slate-400 text-sm ml-2">— {summary}</span>}
      </header>
      {expanded && <div className="mt-3">{children}</div>}
    </section>
  )
}
