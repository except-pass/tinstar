import type { DeploymentReceipt, RequiredTarget } from './releaseReconciliation'
import type { ReleasePull } from './releases'

/** Read-only release projection. Coordinator bindings, not version labels, identify releases. */
export interface ReleaseTarget extends RequiredTarget {
  readiness: string
  readinessEvidence: Array<{ name: string; status: string; url: string | null }>
  receipt: DeploymentReceipt | null
}
export interface ReleaseObject {
  id: string; repository: string; version: string; sourceSha: string | null
  kind: 'candidate' | 'draft' | 'production'
  candidateId: string | null; planId: string | null; executionId: string | null
  scope: string[]; targets: ReleaseTarget[]
  state: string; observedAt: string | null
  provenance: { source: string; asOf: string; historical: boolean }
  evidenceUrl: string | null
  membership: { status: 'pending' | 'complete' | 'partial' | 'unknown'; baseline: string | null; baselineSha: string | null; observedAt: string | null; reason: string | null }
  pulls: ReleasePull[]
  gaps: string[]
}
export interface ReleaseChange {
  id: string; cardId: string | null; title: string; product: string
  pulls: ReleasePull[]; requiredPulls: string[]; targets: ReleaseTarget[]
  delivery: 'Deployed' | 'Not deployed' | 'Unknown' | 'Awaiting delivery'
  acceptance: 'Unknown' | 'Failed' | 'Running' | 'Human review' | 'Passed'
  successCondition: string | null; method: string | null; checkRef: string | null
  acceptanceEvidence: string | null; note: string | null; audience: 'internal' | 'customer'
}

export const eligibleReleaseNote = (release: ReleaseObject, change: ReleaseChange) =>
  release.kind === 'production' && release.membership.status === 'complete' && !!change.cardId &&
  change.delivery === 'Deployed' && change.acceptance === 'Passed' && !!change.successCondition &&
  !!change.checkRef && !!change.acceptanceEvidence && !!change.note
