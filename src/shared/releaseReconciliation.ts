/** Observation/report contracts only. No mutation or execution capability. */
export interface RequiredTarget { target: string; component: string }
export interface DeploymentReceipt extends RequiredTarget {
  id: string; repository: string; environment: string
  deployedSha: string | null; artifactDigest: string | null; version: string | null
  deployedAt: string; workflowUrl: string; receiptUrl: string
  outcome: 'succeeded' | 'failed' | 'partial' | 'skipped' | 'rollback'
  exceptions: string[]
}
export interface TargetReconciliation extends RequiredTarget {
  state: 'live' | 'absent' | 'unknown'
  reason: string
  ancestry: 'ancestor' | 'not-ancestor' | 'unknown'
  receipt: DeploymentReceipt | null
}
export interface PullDeployment {
  state: 'shipped' | 'in-queue' | 'unknown'
  verificationRequired?: boolean
  targets: TargetReconciliation[]
}
export interface CardReleaseEligibility {
  cardId: string; status: string; owner: string; requiredPulls: string[]
  requiresProductionVerification: boolean
  decision: 'would-complete' | 'would-verify' | 'waiting' | 'exception' | 'unrelated'
  eligible: boolean; reasons: string[]; receiptIds: string[]
}
export interface ReleaseDryRun {
  mode: 'dry-run'; id: string
  sourceStatus: 'fresh' | 'stale' | 'unconfigured' | 'error'
  collectedAt: string | null; lastSuccessfulAt: string | null
  warnings: string[]; cards: CardReleaseEligibility[]
  targets: Array<{ repository: string; target: string; component: string; version: string | null; deployedSha: string | null; artifactDigest: string | null; receiptUrl: string; observedAt: string }>
}
