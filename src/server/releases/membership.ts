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
interface Range {
  membership: ReleaseObject['membership']; pulls: Map<string, ReleasePull>
  files: string[]; commits: string[]; cursor: number; page: number; total: number; retryAt: number
}
/** Incremental history read: eight commits per range/refresh, four concurrent GETs.
 * Commit-associated PRs must have their effective merge in the exact Git range.
 * Tags delimit Changes only; they never certify deployment or acceptance. */
export class ReleaseMembershipReader {
  private ranges = new Map<string, Range>()
  private pending = new Map<string, Promise<Range>>()
  constructor(private read: Read = readReleaseRows, private now = Date.now) {}
  async get(repository: string, source: string | null, tag: string, tags?: Tag[], baseline?: Tag) {
    const key = `${repository}:${source}:${tag}:${baseline?.name ?? ''}:${baseline?.commit.sha ?? ''}`
    const current = this.ranges.get(key)
    if (current && (current.membership.status === 'complete' || current.retryAt > this.now())) return current
    const existing = this.pending.get(key)
    if (existing) return existing
    const work = this.advance(repository, source, tag, current, tags, baseline).finally(() => this.pending.delete(key))
    this.pending.set(key, work)
    return work
  }
  since(repository: string, source: string, baseline: Tag) { return this.get(repository, source, 'main', [baseline], baseline) }
  private async advance(repository: string, source: string | null, tag: string, previous?: Range, tags?: Tag[], baseline?: Tag) {
    const range: Range = previous ?? { membership: { status: 'pending', baseline: null, baselineSha: null, observedAt: null, reason: 'Reading Git release membership' }, pulls: new Map(), files: [], commits: [], cursor: 0, page: 0, total: 0, retryAt: 0 }
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
      const commitSet = new Set(range.commits)
      // Advance only whole successful batches: failed reads retry without dropping known members.
      for (let batch = 0; batch < 2 && range.cursor < range.commits.length; batch++) {
        const commits = range.commits.slice(range.cursor, range.cursor + 4)
        const responses = await Promise.all(commits.map(commit => this.read(`/repos/${repository}/commits/${commit}/pulls?per_page=100`, '[.[]|{number,title,html_url,merged_at,merge_commit_sha,head:{sha:.head.sha},base:{ref:.base.ref}}]')))
        for (const response of responses) {
          if (!Array.isArray(response) || response.length === 100) throw new Error('Commit-associated PR history is incomplete')
          for (const raw of response) {
            const identity = releasePull(raw.html_url)
            if (!identity || identity.repository !== repository || !raw.merged_at || !commitSet.has(raw.merge_commit_sha)) continue
            range.pulls.set(identity.id, { ...identity, title: typeof raw.title === 'string' ? raw.title : null, state: 'merged', mergedAt: raw.merged_at,
              mergeSha: raw.merge_commit_sha, head: sha(raw.head?.sha) ? raw.head.sha : null, base: raw.base?.ref ?? null,
              observedAt: new Date(this.now()).toISOString(), freshness: 'fresh', links: [], exceptions: [] })
          }
        }
        range.cursor += commits.length
      }
      const complete = range.cursor === range.total && range.commits.length === range.total
      range.membership.status = complete ? 'complete' : 'partial'
      range.membership.reason = complete ? null : `Reading Git membership: ${range.cursor} of ${range.total} commits inspected; counts are partial`
      range.membership.observedAt = new Date(this.now()).toISOString(); range.retryAt = this.now() + (complete ? 600_000 : 15_000)
    } catch (error) {
      range.membership.status = range.pulls.size ? 'partial' : 'unknown'
      range.membership.reason = error instanceof Error ? error.message : 'Git release membership unavailable'
      range.retryAt = this.now() + 60_000
    }
    this.ranges.set(`${repository}:${source}:${tag}:${baseline?.name ?? ''}:${baseline?.commit.sha ?? ''}`, range)
    // Retain only recently used immutable ranges, without a new on-disk release ledger.
    if (this.ranges.size > 32) this.ranges.delete(this.ranges.keys().next().value!)
    return range
  }
}
