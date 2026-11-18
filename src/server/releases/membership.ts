import type { ReleaseObject } from '../../shared/releaseObjects'
import { releasePull, type ReleasePull } from '../../shared/releases'
import { githubJson } from '../pulls/github'

/** Same broker/CLI JSON transport as the PR screen. */
export const readReleaseRows = githubJson
type Read = typeof readReleaseRows
type Tag = { name: string; commit: { sha: string } }
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
const version = (value: string) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number)
const compareVersions = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!
const commitTtl = 24 * 60 * 60_000
type CommitPull = { html_url: string; title: unknown; merged_at: string; merge_commit_sha: string; head?: { sha?: unknown }; base?: { ref?: string } }
interface Range {
  membership: ReleaseObject['membership']; pulls: Map<string, ReleasePull>
  files: string[]; commits: string[]; cursor: number; page: number; total: number; retryAt: number
}
interface RangeProgress extends Range {
  observations: Map<string, { rows: CommitPull[]; observedAt: string }>
}
/** Incremental history read: eight commits per range/refresh, four concurrent GETs.
 * Commit-associated PRs must have their effective merge in the exact Git range.
 * Tags delimit Changes only; they never certify deployment or acceptance. */
export class ReleaseMembershipReader {
  private commitPulls = new Map<string, { until: number; work: Promise<CommitPull[]> }>()
  private ranges = new Map<string, RangeProgress>()
  private pending = new Map<string, Promise<Range>>()
  constructor(private read: Read = readReleaseRows, private now = Date.now) {}
  async get(repository: string, source: string | null, tag: string, tags?: Tag[], baseline?: Tag, onMain = false) {
    const key = `${repository}:${source}:${tag}:${baseline?.name ?? ''}:${baseline?.commit.sha ?? ''}`
    const current = this.ranges.get(key)
    if (current && current.retryAt > this.now()) return current
    const existing = this.pending.get(key)
    if (existing) return existing
    const work = this.advance(key, repository, source, tag, onMain, current, tags, baseline).finally(() => this.pending.delete(key))
    this.pending.set(key, work)
    return work
  }
  since(repository: string, source: string, baseline: Tag) { return this.get(repository, source, 'main', [baseline], baseline, true) }
  private readCommitPulls(repository: string, commit: string, onMain: boolean) {
    const key = `${repository.toLowerCase()}:${commit}`
    const cached = this.commitPulls.get(key)
    if (cached && cached.until > this.now()) return cached.work
    const entry: { until: number; work: Promise<CommitPull[]> } = {
      until: Infinity,
      work: this.read(`/repos/${repository}/commits/${commit}/pulls?per_page=100`, '[.[]|{number,title,html_url,merged_at,merge_commit_sha,head:{sha:.head.sha},base:{ref:.base.ref}}]')
        .then(response => {
          if (!Array.isArray(response) || response.length >= 100 || response.some(row => !row || typeof row !== 'object')) throw new Error('Commit-associated PR history is incomplete')
          const merged = (response as CommitPull[]).filter(row =>
            typeof row.merged_at === 'string' && Number.isFinite(Date.parse(row.merged_at)) &&
            sha(row.merge_commit_sha) && typeof row.html_url === 'string' && releasePull(row.html_url)?.repository === repository)
          if (onMain) {
            if (merged.length > 0 && merged.length === response.length) entry.until = this.now() + commitTtl
            else this.commitPulls.delete(key)
          }
          return merged
        })
        .catch(error => {
          if (onMain) this.commitPulls.delete(key)
          throw error
        }),
    }
    if (onMain) this.commitPulls.set(key, entry)
    return entry.work
  }
  private async advance(key: string, repository: string, source: string | null, tag: string, onMain: boolean, previous?: RangeProgress, tags?: Tag[], baseline?: Tag): Promise<Range> {
    const range: RangeProgress = previous ?? { membership: { status: 'pending', baseline: null, baselineSha: null, observedAt: null, reason: 'Reading Git release membership' }, pulls: new Map(), observations: new Map(), files: [], commits: [], cursor: 0, page: 0, total: 0, retryAt: 0 }
    try {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !sha(source)) throw new Error('Release source SHA is missing; Changes cannot be determined')
      if (!range.membership.baselineSha) {
        const availableTags = tags ?? await this.read(`/repos/${repository}/tags?per_page=100`, '.')
        if (!Array.isArray(availableTags)) throw new Error('Previous release tags are unavailable')
        const currentVersion = version(tag)
        const candidates = baseline ? [baseline] : availableTags.filter(row => row && typeof row.name === 'string' && version(row.name) && sha(row.commit?.sha) && currentVersion && compareVersions(version(row.name)!, currentVersion) < 0)
          .sort((a, b) => compareVersions(version(b.name)!, version(a.name)!))
        for (const candidate of candidates.slice(0, 1)) {
          const history = await this.read(`/repos/${repository}/compare/${candidate.commit.sha}...${source}?per_page=100&page=1`, '{status,total_commits,merge_base_commit:{sha:.merge_base_commit.sha},commits:[.commits[]|{sha}],files:[.files[]?|{filename}]}') as Record<string, any>
          if (!['ahead', 'identical'].includes(history.status) || history.merge_base_commit?.sha !== candidate.commit.sha) throw new Error('Consecutive release tags have no proven linear Git range; Changes remain unknown')
          if (!Number.isInteger(history.total_commits) || !Array.isArray(history.commits) || !history.commits.every((row: { sha: unknown }) => sha(row.sha))) throw new Error('Git release comparison is incomplete')
          range.membership.baseline = candidate.name; range.membership.baselineSha = candidate.commit.sha
          range.files = (history.files ?? []).flatMap((file: { filename?: string }) => typeof file.filename === 'string' ? [file.filename] : [])
          range.commits = history.commits.map((row: { sha: string }) => row.sha); range.total = history.total_commits; range.page = 1
          break
        }
        if (!range.membership.baselineSha) throw new Error('No previous version tag was found in the available history; Changes remain unknown')
      }
      if (range.cursor >= range.commits.length && range.commits.length < range.total) {
        const page = await this.read(`/repos/${repository}/compare/${range.membership.baselineSha}...${source}?per_page=100&page=${range.page + 1}`, '{commits:[.commits[]|{sha}]}') as Record<string, any>
        if (!Array.isArray(page.commits) || !page.commits.length || !page.commits.every((row: { sha: unknown }) => sha(row.sha))) throw new Error('Additional Git release history is unavailable; observed Changes are partial')
        range.page++; range.commits.push(...page.commits.map((row: { sha: string }) => row.sha))
      }
      for (const [key, entry] of this.commitPulls) if (entry.until <= this.now()) this.commitPulls.delete(key)
      if (range.cursor >= range.commits.length) range.cursor = 0
      let failure: { reason: unknown } | undefined
      for (let batch = 0; batch < 2 && range.cursor < range.commits.length; batch++) {
        const commits = range.commits.slice(range.cursor, range.cursor + 4)
        const responses = await Promise.allSettled(commits.map(async commit => this.readCommitPulls(repository, commit, onMain)))
        const observedAt = new Date(this.now()).toISOString()
        responses.forEach((response, index) => {
          if (response.status === 'fulfilled') range.observations.set(commits[index]!, { rows: response.value, observedAt })
          else failure ??= response
        })
        range.cursor += commits.length
      }
      if (failure) throw failure.reason
      const inspected = range.observations.size
      const complete = inspected === range.total && range.commits.length === range.total
      range.membership.status = complete ? 'complete' : 'partial'
      range.membership.reason = complete ? null : `Reading Git membership: ${inspected} of ${range.total} commits inspected; counts are partial`
      range.membership.observedAt = new Date(this.now()).toISOString(); range.retryAt = this.now() + 15_000
    } catch (error) {
      range.membership.status = range.observations.size ? 'partial' : 'unknown'
      range.membership.reason = error instanceof Error ? error.message : 'Git release membership unavailable'
      range.retryAt = this.now() + 60_000
    }
    const commitSet = new Set(range.commits)
    const pulls = new Map<string, ReleasePull>()
    for (const { rows, observedAt } of range.observations.values()) {
      for (const raw of rows) {
        const identity = releasePull(raw.html_url)
        if (!identity || identity.repository !== repository || !commitSet.has(raw.merge_commit_sha)) continue
        const previousPull = pulls.get(identity.id)
        if (previousPull?.observedAt && previousPull.observedAt > observedAt) continue
        pulls.set(identity.id, { ...identity, title: typeof raw.title === 'string' ? raw.title : null, state: 'merged', mergedAt: raw.merged_at,
          mergeSha: raw.merge_commit_sha, head: sha(raw.head?.sha) ? raw.head.sha : null, base: raw.base?.ref ?? null,
          observedAt, freshness: 'fresh', links: [], exceptions: [] })
      }
    }
    range.pulls = pulls
    this.ranges.set(key, range)
    if (this.ranges.size > 32) this.ranges.delete(this.ranges.keys().next().value!)
    return range
  }
}
