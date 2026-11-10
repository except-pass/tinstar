import { releasePull, type PullIdentity, type ReleaseLink } from './releases'

export interface PullSummary extends PullIdentity {
  state?: 'open' | 'closed' | 'merged'
  title: string; author: string; draft: boolean; head: string; base: string
  createdAt: string; updatedAt: string
  observedAt: string; freshness: 'fresh' | 'stale'
  links: ReleaseLink[]
}
export interface PullRepository {
  scope?: 'all-open' | 'authored-or-associated'
  repository: string; status: 'fresh' | 'partial' | 'stale' | 'unavailable'
  observedAt: string | null; complete: boolean; error: string | null
}
export interface PullsRead {
  account?: string
  authenticatedActor?: string; credentialProfile?: string
  associations?: Array<PullIdentity & { links: ReleaseLink[] }>
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

export function queuePulls(item: { cardIds: string[]; evidence: Array<{ kind: string; url: string }> }, inventory: PullsRead | null): PullIdentity[] {
  const urls = [...item.evidence.filter(link => link.kind === 'pull-request').map(link => link.url),
    ...[...(inventory?.associations ?? []), ...(inventory?.pulls ?? [])].filter(pull => pull.links.some(link => link.active && item.cardIds.includes(link.cardId))).map(pull => pull.url)]
  return [...new Map(urls.flatMap(url => { const pull = releasePull(url); return pull ? [[pull.id, pull] as const] : [] })).values()]
}

export function inventoryPullState(url: string, inventory: PullsRead | null): 'open' | 'not-open' | 'unverified' {
  const identity = releasePull(url)
  if (!identity || !inventory) return 'unverified'
  const pull = inventory.pulls.find(pull => releasePull(pull.url)?.id === identity.id)
  if (pull) return pull.freshness === 'fresh' ? 'open' : 'unverified'
  const coverage = inventory.repositories.find(repository => repository.repository === identity.repository)
  const covered = coverage?.scope === 'all-open' || coverage?.scope === 'authored-or-associated' &&
    inventory.associations?.some(pull => releasePull(pull.url)?.id === identity.id && pull.links.some(link => link.active))
  return covered && coverage?.status === 'fresh' && coverage.complete ? 'not-open' : 'unverified'
}
