import type { AcceptanceResult } from './releaseAcceptance'
import type { DeploymentReceipt, RequiredTarget } from './releaseReconciliation'
import type { ReleasePull } from './releases'

/** Native GitHub observations are separate from verified deployment receipts. */
export interface NativeReleaseEvidence {
  record: 'available' | 'missing' | 'unknown'
  url: string | null; body: string | null; publishedAt: string | null; snapshotAt: string | null
  componentResults: Array<{ component: string; result: string; url: string }>
  runsStatus: 'fresh' | 'unknown'
  runs: Array<{ id: number; name: string; workflow: string; url: string; sha: string; status: string; conclusion: string | null; attempt: number; createdAt: string; updatedAt: string; startedAt: string | null }>
}
/** Read-only release projection; native releases are identified by repository/tag. */
export interface ReleaseTarget extends RequiredTarget {
  readiness: string
  readinessEvidence: Array<{ name: string; status: string; url: string | null }>
  receipt: DeploymentReceipt | null
}
export interface ReleaseObject {
  github?: NativeReleaseEvidence
  id: string; repository: string; version: string; sourceSha: string | null
  kind: 'candidate' | 'draft' | 'production'
  candidateId: string | null; planId: string | null; executionId: string | null
  scope: string[]; targets: ReleaseTarget[]
  state: string; observedAt: string | null
  provenance: { source: string; asOf: string; historical: boolean }
  evidenceUrl: string | null
  membership: { status: 'pending' | 'complete' | 'partial' | 'unknown'; baseline: string | null; baselineSha: string | null; observedAt: string | null; reason: string | null }
  pulls: ReleasePull[]
  supportingPulls?: ReleasePull[]
  gaps: string[]
}
export interface ReleaseChange {
  id: string; cardId: string | null; title: string; product: string
  pulls: ReleasePull[]; requiredPulls: string[]; targets: ReleaseTarget[]
  delivery: 'Deployed' | 'Not deployed' | 'Unknown' | 'Awaiting delivery'
  acceptance: 'Unknown' | 'Failed' | 'Running' | 'Human review' | 'Passed' | 'Missing' | 'Inconclusive' | 'Skipped'
  successCondition: string | null; method: string | null; checkRef: string | null
  checks?: AcceptanceResult[]; acceptanceGap?: string | null
  acceptanceEvidence: string | null; note: string | null; customerNote?: string | null; audience: 'internal' | 'customer'
}

export const eligibleReleaseNote = (release: ReleaseObject, change: ReleaseChange) =>
  release.kind === 'production' && release.membership.status === 'complete' && !!change.cardId &&
  change.delivery === 'Deployed' && change.acceptance === 'Passed' && !!change.successCondition &&
  !!change.checkRef && !!change.acceptanceEvidence && !!change.note
