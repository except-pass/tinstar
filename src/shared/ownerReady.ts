export interface OwnerRequestSource {
  kind: 'jira' | 'notion' | 'firstmate'
  id: string
  label: string
  url: string | null
}

export interface OwnerMergeAsk {
  url: string | null
  requestedHeads: string[]
  unverifiedRequest: boolean
  fresh: boolean
  sources: Array<OwnerRequestSource & { requestedHead: string | null; superseded?: true }>
  live?: { head: string | null; state: 'ready' | 'stale' | 'pending' | 'unverified'; observedAt: string | null }
}

export interface OwnerDecisionAsk {
  id: string
  question: string
  fresh: boolean
  sources: OwnerRequestSource[]
}

export interface OwnerReadyRead {
  observedAt: string
  repositories: Array<{ repository: string | null; merges: OwnerMergeAsk[]; decisions: OwnerDecisionAsk[] }>
  warnings: string[]
  recheckedAt?: string
}
