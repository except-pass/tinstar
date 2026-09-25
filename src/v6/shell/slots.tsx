import type { ComponentType } from 'react'
import { ActivePortfolio } from '../account/ActivePortfolio'
import { NeedsYouRail as NeedsYouRailView } from '../needsyou'
import { WorkerObjective as WorkerObjectiveView } from '../objective'
import { QuotaRail as QuotaRailView } from '../quota'
import { ContextThread as ContextThreadView } from '../threads'

/** Module surfaces. The shell renders one component per slot. */
export const NeedsYouRail: ComponentType = NeedsYouRailView
export const PortfolioBoard: ComponentType = ActivePortfolio
export const ContextThread: ComponentType = ContextThreadView
export const WorkerObjective: ComponentType = WorkerObjectiveView
export const QuotaRail: ComponentType = QuotaRailView
