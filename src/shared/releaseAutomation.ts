import type { QueueItem } from '../server/reconciliation/queue'
import type { DeploymentReceipt } from './releaseReconciliation'

export interface ReleaseTransitionEvidence {
  pull: string
  mergeSha: string
  receipt: DeploymentReceipt
}
/** Reviewable intent, never a command. No writer or Desk publisher consumes this build. */
export interface ReleaseTransitionProposal {
  id: string
  cardId: string
  owner: string
  from: 'Waiting for Prod Release'
  to: 'Done' | 'In Progress'
  kind: 'complete' | 'verify-in-production'
  requiredPulls: string[]
  evidence: ReleaseTransitionEvidence[]
  auditText: string
  desk: { owner: string; item: QueueItem } | null
}
export interface ReleaseAutomationPlan {
  mode: 'review-only'
  enabled: false
  requestedEnabled: boolean
  configuration: 'default' | 'configured' | 'error'
  warnings: string[]
  proposals: ReleaseTransitionProposal[]
  held: Array<{ cardId: string; reasons: string[] }>
}
