import type { ComponentType } from 'react'
import { WorkerObjective } from './WorkerObjective'

export { WorkerObjective }
export type { WorkerObjectiveProps } from './WorkerObjective'

/** Assignable to the shell slot, which renders a component with no required props. */
export const workerObjectiveSlot: ComponentType = WorkerObjective
