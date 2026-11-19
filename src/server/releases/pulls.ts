import { releasePull } from '../../shared/releases'
import type { ReleasePull } from '../../shared/releases'
import { readGithubScalars } from '../reconciliation/queuePulls'
import { isGithubRateLimit } from '../pulls/restBudget'
import { readReleasePullPage, releasePullPage } from '../pulls/releasePullPage'

const mergedTtl = 24 * 60 * 60_000
const refreshTtl = 120_000
const pageSize = 100
type Observation = Pick<ReleasePull, 'base' | 'head' | 'title' | 'state' | 'mergedAt' | 'mergeSha' | 'observedAt' | 'freshness' | 'readError'>
type RepositoryPoll = { until: number; failure?: { message: string; refreshed: Set<string> } }

/** Poll recent updates together. Point reads fill old or unusually busy gaps. */
export class ReleasePullReader {
  private cache = new Map<string, { until: number; value: Observation }>()
  private pending = new Map<string, Promise<Observation>>()
  private polls = new Map<string, RepositoryPoll>()
  private pollPending = new Map<string, Promise<RepositoryPoll>>()
  private cursor = 0
  private pointReads: number[] = []
  constructor(private read = readGithubScalars, private now = Date.now, private list = readReleasePullPage) {}
  async get(urls: string[]) {
    const result = new Map<string, Observation>(), candidates = [...new Set(urls)]
    const requested = new Set(candidates)
    for (const [url, cached] of this.cache) if (!requested.has(url) && (cached.value.state !== 'merged' || cached.until <= this.now())) this.cache.delete(url)
    const groups = new Map<string, Array<{ url: string; number: number }>>()
    for (const url of candidates) {
      const pull = releasePull(url)
      if (!pull) continue
      const group = groups.get(pull.repository) ?? []
      group.push({ url, number: pull.number })
      groups.set(pull.repository, group)
    }
    for (const repository of this.polls.keys()) {
      if (!groups.has(repository) && !this.pollPending.has(repository)) this.polls.delete(repository)
    }
    const errors = new Map<string, string>()
    const batches = [...groups].filter(([, group]) => group.length > 1)
    for (let offset = 0; offset < batches.length; offset += 4) {
      await Promise.all(batches.slice(offset, offset + 4).map(async ([repository, group]) => {
        if (group.every(({ url }) => this.cache.get(url)?.value.state === 'merged' && this.current(url))) return
        const poll = await this.poll(repository, group)
        if (poll.failure) for (const { url } of group) {
          if (!poll.failure.refreshed.has(url) || !this.current(url)) errors.set(url, poll.failure.message)
        }
      }))
    }
    const start = this.cursor % Math.max(candidates.length, 1)
    const work: Promise<void>[] = []
    this.pointReads = this.pointReads.filter(started => started > this.now() - refreshTtl)
    for (let offset = 0; offset < candidates.length; offset++) {
      const index = (start + offset) % candidates.length, url = candidates[index]!
      const cached = this.cache.get(url)
      const error = errors.get(url)
      if (error && !(cached?.value.state === 'merged' && this.current(url))) {
        result.set(url, this.failed(url, error))
        continue
      }
      let pending = this.pending.get(url)
      if (!pending && !this.current(url) && this.pointReads.length < 4 && this.pending.size < 4) {
        this.pointReads.push(this.now())
        this.cursor = (index + 1) % candidates.length
        pending = this.refresh(url).finally(() => this.pending.delete(url)); this.pending.set(url, pending)
      }
      if (pending) work.push(pending.then(value => { result.set(url, value) }))
      else if (cached) result.set(url, { ...cached.value, freshness: cached.until <= this.now() ? 'stale' : cached.value.freshness })
    }
    await Promise.all(work)
    return result
  }

  private current(url: string) { return (this.cache.get(url)?.until ?? -Infinity) > this.now() }

  private poll(repository: string, group: Array<{ url: string; number: number }>) {
    const previous = this.polls.get(repository)
    if (previous && previous.until > this.now()) return Promise.resolve(previous)
    let pending = this.pollPending.get(repository)
    if (!pending) {
      pending = this.refreshRepository(repository, group).then(poll => {
        this.polls.set(repository, poll)
        return poll
      }).finally(() => this.pollPending.delete(repository))
      this.pollPending.set(repository, pending)
    }
    return pending
  }

  private async refreshRepository(repository: string, group: Array<{ url: string; number: number }>): Promise<RepositoryPoll> {
    const started = this.now(), observedAt = new Date(started).toISOString()
    // An unchanged row may predate the newest page. Look back to the oldest
    // mutable observation, including the boundary second for equal timestamps.
    let since = started - 1000
    for (const { url } of group) {
      const value = this.cache.get(url)?.value
      if (value?.observedAt && value.state !== 'merged') since = Math.min(since, Date.parse(value.observedAt) - 1000)
    }
    const byNumber = new Map(group.map(({ number, url }) => [number, url]))
    const numbers = [...byNumber.keys()].sort((a, b) => a - b)
    const observed = new Set<string>()
    const refreshed = new Set<string>()
    let covered = false
    try {
      // Bound catch-up after outages or a burst of updates. Exact reads can
      // still fill gaps when the list cannot reach the previous observation.
      for (let page = 1; page <= 4; page++) {
        const { rows, count, oldestUpdatedAt } = releasePullPage.parse(await this.list(
          `/repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=${pageSize}&page=${page}`, numbers))
        for (const row of rows) {
          const url = byNumber.get(row.number)
          if (!url || observed.has(url) || this.cache.get(url)?.value.state === 'merged' && this.current(url)) continue
          observed.add(url)
          try {
            this.save(url, this.observation({ ...row, merged: row.merged ?? (row.merged_at !== null), head_sha: row.head.sha, base_ref: row.base.ref }, observedAt, this.cache.get(url)?.value.title ?? null))
            refreshed.add(url)
          } catch {
            // If the list row cannot establish merge evidence, try the exact PR.
            const cached = this.cache.get(url)
            if (cached) cached.until = started
          }
        }
        const reachedCutoff = count === pageSize && oldestUpdatedAt !== null && Date.parse(oldestUpdatedAt) < since
        covered = page === 1 && reachedCutoff
        if (count < pageSize || reachedCutoff) break
      }
    } catch (error) {
      return { until: started + refreshTtl, failure: { message: this.readError(error, repository), refreshed } }
    }
    if (covered) for (const { url } of group) {
      const previous = this.cache.get(url)?.value
      if (!observed.has(url) && previous?.observedAt && previous.state !== 'merged') {
        this.save(url, { ...previous, observedAt, freshness: 'fresh', readError: undefined })
      }
    }
    return { until: started + refreshTtl }
  }

  private readError(error: unknown, subject: string) {
    return isGithubRateLimit(error) ? error.message : (error as { code?: unknown })?.code === 'ENOENT' ? 'gh-axi is unavailable on the server PATH; configure the service PATH' : `GitHub read failed for ${subject}; check service PATH, credentials and repository access`
  }

  private failed(url: string, readError: string): Observation {
    const previous = this.cache.get(url)?.value
    return previous ? { ...previous, freshness: 'stale', readError } : { title: null, state: 'unknown', mergedAt: null, mergeSha: null, observedAt: null, freshness: 'unknown', readError }
  }

  private save(url: string, value: Observation) {
    const delay = value.state === 'merged' && value.freshness === 'fresh' ? mergedTtl : refreshTtl
    this.cache.set(url, { until: this.now() + delay, value })
  }

  private observation(raw: Record<string, unknown>, observedAt: string, title: string | null): Observation {
    if ((raw.state !== 'open' && raw.state !== 'closed') || typeof raw.merged !== 'boolean') throw new Error('Incomplete PR observation')
    if (raw.merged && (typeof raw.merged_at !== 'string' || !Number.isFinite(Date.parse(raw.merged_at)) || !/^[a-f0-9]{40,64}$/.test(String(raw.merge_commit_sha)))) throw new Error('Missing effective merge identity')
    return { base: typeof raw.base_ref === 'string' && raw.base_ref.length > 0 ? raw.base_ref : null, head: /^[a-f0-9]{40,64}$/.test(String(raw.head_sha)) ? String(raw.head_sha) : null, title, state: raw.merged ? 'merged' : raw.state, mergedAt: raw.merged ? String(raw.merged_at) : null, mergeSha: raw.merged ? String(raw.merge_commit_sha) : null, observedAt, freshness: 'fresh' }
  }

  private async refresh(url: string): Promise<Observation> {
    const previous = this.cache.get(url)
    let value: Observation
    try {
      const pull = releasePull(url)
      if (!pull) throw new Error('Unsupported PR')
      const raw = await this.read(`/repos/${pull.repository}/pulls/${pull.number}`, '{title,state,merged,merged_at,merge_commit_sha,head_sha:.head.sha,base_ref:.base.ref}')
      if (typeof raw.title !== 'string') throw new Error('Incomplete PR observation')
      value = this.observation(raw, new Date(this.now()).toISOString(), raw.title)
    } catch (error) {
      value = this.failed(url, this.readError(error, url))
    }
    const current = this.cache.get(url)
    if (current && current !== previous) return current.value
    this.save(url, value)
    return value
  }
}
