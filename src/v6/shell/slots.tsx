import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import { ActivePortfolio } from '../account/ActivePortfolio'
import { NeedsYouRail as NeedsYouRailView } from '../needsyou'
import { WorkerObjective as WorkerObjectiveView, type WorkerObjectiveProps } from '../objective'
import { QuotaRail as QuotaRailView } from '../quota'
import { ContextThread as ContextThreadView, type ContextThreadProps } from '../threads'
import type { ShellWorkerIdentity } from './identity'
import type { ViewId } from './navigation'

/** What the shell has already selected. Slots read this instead of inventing a target. */
export interface ShellSelection {
  workerId: string | null
  view: ViewId
  /** Rail identity for each worker id. Slots display this and do not mint another. */
  identities?: Record<string, ShellWorkerIdentity>
}

const EMPTY_SELECTION: ShellSelection = {
  workerId: null,
  view: { kind: 'portfolio' },
}

const SelectionContext = createContext<ShellSelection>(EMPTY_SELECTION)

export function ShellSelection({ value, children }: { value: ShellSelection; children: ReactNode }) {
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

export function objectivePropsFor(workerId: string | null): WorkerObjectiveProps {
  if (!workerId) return {}
  return { workerId }
}

/** Worker, epic, and task views are anchors. The portfolio view is not. */
export function threadPropsFor(view: ViewId): ContextThreadProps {
  if (view.kind === 'worker' || view.kind === 'epic' || view.kind === 'task') {
    return { anchor: { type: view.kind, ids: [view.id] } }
  }
  return {}
}

function WiredWorkerObjective() {
  const { workerId, identities } = useContext(SelectionContext)
  const identity = workerId && identities ? identities[workerId] : undefined
  return <WorkerObjectiveView {...objectivePropsFor(workerId)} identity={identity} />
}

function WiredNeedsYouRail() {
  const { identities } = useContext(SelectionContext)
  return <NeedsYouRailView identities={identities ?? {}} />
}

function WiredContextThread() {
  const { view } = useContext(SelectionContext)
  return <ContextThreadView {...threadPropsFor(view)} />
}

/** Module surfaces. The shell renders one component per slot. */
export const NeedsYouRail: ComponentType = WiredNeedsYouRail
export const PortfolioBoard: ComponentType = ActivePortfolio
export const ContextThread: ComponentType = WiredContextThread
export const WorkerObjective: ComponentType = WiredWorkerObjective
export const QuotaRail: ComponentType = QuotaRailView
