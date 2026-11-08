import { z } from 'zod'
import type { PullDetail, PullRepository, PullSummary } from '../../shared/pulls'
import { releasePull } from '../../shared/releases'
import { QueuePullReader } from '../reconciliation/queuePulls'
import { githubJson } from './github'

const listing = z.array(z.object({
  number: z.number().int().positive(), title: z.string(), html_url: z.string(),
  user: z.object({ login: z.string() }).nullable(), draft: z.boolean(),
  head: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }), base: z.object({ ref: z.string() }),
  created_at: z.string().datetime({ offset: true }), updated_at: z.string().datetime({ offset: true }),
}))
const details = z.object({ head: z.object({ sha: z.string() }), state: z.string(), body: z.string().nullable(),
  additions: z.number().nonnegative(), deletions: z.number().nonnegative(), changed_files: z.number().nonnegative() })
const reviews = z.array(z.object({ user: z.object({ login: z.string() }).nullable(), state: z.string(), html_url: z.string() }))
type RepoRead = { pulls: Omit<PullSummary, 'links'>[]; coverage: PullRepository }

/** Demand cache, shared across clients. Four repo reads at once, bounded pages;
 * limits prevent an accidental large account crawl from exhausting the shared API budget. */
export class PullReader {
  private repos = new Map<string, { until: number; data: RepoRead }>()
  private pending = new Map<string, Promise<RepoRead>>()
  private detailCache = new Map<string, { until: number; data: PullDetail }>()
  private detailPending = new Map<string, Promise<PullDetail>>()
  constructor(private read = githubJson, private now = Date.now, private readiness = new QueuePullReader()) {}
  async inventory(repositories: string[]) {
    const result: RepoRead[] = []
    for (let index = 0; index < repositories.length; index += 4) {
      result.push(...await Promise.all(repositories.slice(index, index + 4).map(repository => {
        const cached = this.repos.get(repository)
        if (cached && cached.until > this.now()) return cached.data
        let pending = this.pending.get(repository)
        if (!pending) { pending = this.refresh(repository).finally(() => this.pending.delete(repository)); this.pending.set(repository, pending) }
        return pending
      })))
    }
    return result
  }
  private async refresh(repository: string): Promise<RepoRead> {
    const pulls: RepoRead['pulls'] = [], observedAt = new Date(this.now()).toISOString()
    let complete = false, error: string | null = null
    try {
      // 1,000 open PRs/repo is deliberately partial, with a visible coverage notice.
      for (let page = 1; page <= 10; page++) {
        const rows = listing.parse(await this.read(`/repos/${repository}/pulls?state=open&per_page=100&page=${page}`, '[.[]|{number,title,html_url,user:{login:.user.login},draft,head:{sha:.head.sha},base:{ref:.base.ref},created_at,updated_at}]'))
        for (const row of rows) {
          const identity = releasePull(row.html_url)
          if (!identity || identity.repository !== repository || identity.number !== row.number) throw new Error('GitHub PR identity mismatch')
          pulls.push({ ...identity, title: row.title, author: row.user?.login ?? 'Unknown', draft: row.draft,
            head: row.head.sha, base: row.base.ref, createdAt: row.created_at, updatedAt: row.updated_at, observedAt, freshness: 'fresh' })
        }
        if (rows.length < 100) { complete = true; break }
      }
      if (!complete) error = 'Showing the first 1,000 open PRs; repository coverage is partial.'
    } catch (reason) { error = reason instanceof z.ZodError ? 'GitHub returned incomplete PR metadata.' : (reason as Error).message }
    const previous = this.repos.get(repository)?.data
    // Failed pagination retains previous rows as stale, including rows beyond the successful page.
    const merged = new Map<string, Omit<PullSummary, 'links'>>((!complete && previous ? previous.pulls.map(pull => [pull.id, { ...pull, freshness: 'stale' as const }] as const) : []))
    for (const pull of pulls) merged.set(pull.id, pull)
    const data: RepoRead = { pulls: [...merged.values()], coverage: { repository, complete,
      observedAt: pulls.length || complete ? observedAt : previous?.coverage.observedAt ?? null,
      status: complete ? 'fresh' : pulls.length ? 'partial' : previous?.pulls.length ? 'stale' : 'unavailable', error } }
    this.repos.set(repository, { until: this.now() + 60_000, data })
    return data
  }
  async detail(url: string, head: string): Promise<PullDetail> {
    const identity = releasePull(url)
    if (!identity) throw new Error('Invalid PR identity')
    const key = `${identity.id}@${head}`, cached = this.detailCache.get(key)
    if (cached && cached.until > this.now()) return cached.data
    let pending = this.detailPending.get(key)
    if (!pending) { pending = this.refreshDetail(identity.url, identity.repository, identity.number, head, cached?.data).finally(() => this.detailPending.delete(key)); this.detailPending.set(key, pending) }
    return pending
  }
  private async refreshDetail(url: string, repository: string, number: number, expectedHead: string, previous?: PullDetail): Promise<PullDetail> {
    try {
      const raw = details.parse(await this.read(`/repos/${repository}/pulls/${number}`, '{head:{sha:.head.sha},state,body,additions,deletions,changed_files}'))
      if (raw.head.sha !== expectedHead) throw new Error('PR head changed. Refresh the PR list to inspect its current changes.')
      const [reviewResult, readinessResult] = await Promise.allSettled([
        this.read(`/repos/${repository}/pulls/${number}/reviews?per_page=100`, '[.[]|{user:{login:.user.login},state,html_url}]').then(value => reviews.parse(value)),
        this.readiness.get([url]),
      ])
      const rows = reviewResult.status === 'fulfilled' ? reviewResult.value : []
      const latest = new Map<string, string>()
      for (const row of rows) if (row.user && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(row.state)) latest.set(row.user.login, row.state)
      const reviewsComplete = reviewResult.status === 'fulfilled' && rows.length < 100
      const check = readinessResult.status === 'fulfilled' ? readinessResult.value.get(url) : null
      const data: PullDetail = { head: raw.head.sha, state: raw.state, body: (raw.body ?? '').slice(0, 32_000), bodyTruncated: (raw.body?.length ?? 0) > 32_000,
        additions: raw.additions, deletions: raw.deletions, files: raw.changed_files,
        checks: check?.status === 'fresh' && check.head === raw.head.sha ? check.checks : 'unknown',
        reviews: rows.map(row => ({ author: row.user?.login ?? 'Unknown', state: row.state, url: row.html_url })), reviewsComplete,
        review: !reviewsComplete ? 'Unknown / partial' : [...latest.values()].includes('CHANGES_REQUESTED') ? 'Changes requested' : [...latest.values()].includes('APPROVED') ? 'Approved review' : 'No approval observed',
        observedAt: new Date(this.now()).toISOString(), freshness: 'fresh', error: reviewsComplete ? null : 'Review evidence unavailable or limited to the first 100 reviews.' }
      this.detailCache.set(`${repository}#${number}@${expectedHead}`, { until: this.now() + 120_000, data })
      while (this.detailCache.size > 200) this.detailCache.delete(this.detailCache.keys().next().value!)
      return data
    } catch (error) {
      if (previous) return { ...previous, freshness: 'stale', error: (error as Error).message }
      throw error
    }
  }
}
