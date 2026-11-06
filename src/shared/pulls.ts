import type { PullIdentity, ReleaseLink } from './releases'

export interface PullSummary extends PullIdentity {
  title: string; author: string; draft: boolean; head: string; base: string
  createdAt: string; updatedAt: string
  observedAt: string; freshness: 'fresh' | 'stale'
  links: ReleaseLink[]
}
export interface PullRepository {
  repository: string; status: 'fresh' | 'partial' | 'stale' | 'unavailable'
  observedAt: string | null; complete: boolean; error: string | null
}
export interface PullsRead {
  pulls: PullSummary[]; repositories: PullRepository[]; warnings: string[]; associationsComplete: boolean
}
export interface PullDetail {
  head: string; state: string; body: string; bodyTruncated: boolean
  additions: number; deletions: number; files: number
  checks: 'passed' | 'failed' | 'pending' | 'unknown'
  reviews: Array<{ author: string; state: string; url: string }>
  review: string; reviewsComplete: boolean
  observedAt: string; freshness: 'fresh' | 'stale'; error: string | null
}
