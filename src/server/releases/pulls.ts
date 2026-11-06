import { releasePull } from '../../shared/releases'
import type { ReleasePull } from '../../shared/releases'
import { readGithubScalars } from '../reconciliation/queuePulls'

type Observation = Pick<ReleasePull, 'title' | 'state' | 'mergedAt' | 'mergeSha' | 'observedAt' | 'freshness' | 'readError'>
/** One GET per explicit PR, at most four concurrently per refresh. No repository crawl. */
export class ReleasePullReader {
  private cache = new Map<string, { until: number; value: Observation }>()
  private pending = new Map<string, Promise<Observation>>()
  private cursor = 0
  constructor(private read = readGithubScalars, private now = Date.now) {}
  async get(urls: string[]) {
    const result = new Map<string, Observation>(), candidates = [...new Set(urls)]
    for (const url of this.cache.keys()) if (!candidates.includes(url)) this.cache.delete(url)
    const start = this.cursor % Math.max(candidates.length, 1)
    const work: Promise<void>[] = []
    let budget = 4
    for (let offset = 0; offset < candidates.length; offset++) {
      const index = (start + offset) % candidates.length, url = candidates[index]!
      const cached = this.cache.get(url)
      let pending = this.pending.get(url)
      if (!pending && (!cached || cached.until <= this.now()) && budget > 0 && this.pending.size < 4) {
        budget--; this.cursor = (index + 1) % candidates.length
        pending = this.refresh(url).finally(() => this.pending.delete(url)); this.pending.set(url, pending)
      }
      if (pending) work.push(pending.then(value => { result.set(url, value) }))
      else if (cached) result.set(url, { ...cached.value, freshness: cached.until <= this.now() ? 'stale' : cached.value.freshness })
    }
    await Promise.all(work)
    return result
  }
  private async refresh(url: string): Promise<Observation> {
    let value: Observation
    try {
      const pull = releasePull(url)
      if (!pull) throw new Error('Unsupported PR')
      const raw = await this.read(`/repos/${pull.repository}/pulls/${pull.number}`, '{title,state,merged,merged_at,merge_commit_sha}')
      if (typeof raw.title !== 'string' || !['open', 'closed'].includes(String(raw.state)) || typeof raw.merged !== 'boolean') throw new Error('Incomplete PR observation')
      if (raw.merged && (typeof raw.merged_at !== 'string' || !Number.isFinite(Date.parse(raw.merged_at)) || !/^[a-f0-9]{40,64}$/.test(String(raw.merge_commit_sha)))) throw new Error('Missing effective merge identity')
      value = { title: raw.title, state: raw.merged ? 'merged' : raw.state as 'open' | 'closed', mergedAt: raw.merged ? String(raw.merged_at) : null, mergeSha: raw.merged ? String(raw.merge_commit_sha) : null, observedAt: new Date(this.now()).toISOString(), freshness: 'fresh' }
    } catch (error) {
      const readError = (error as { code?: unknown }).code === 'ENOENT' ? 'gh-axi is unavailable on the server PATH; configure the service PATH' : `GitHub read failed for ${url}; check service PATH, credentials and repository access`
      const previous = this.cache.get(url)?.value
      value = previous ? { ...previous, freshness: 'stale', readError } : { title: null, state: 'unknown', mergedAt: null, mergeSha: null, observedAt: null, freshness: 'unknown', readError }
    }
    // Merged identity is stable; a longer cache lets the bounded reader cover the whole queue.
    this.cache.set(url, { until: this.now() + (value.state === 'merged' && value.freshness === 'fresh' ? 600_000 : 60_000), value })
    return value
  }
}
