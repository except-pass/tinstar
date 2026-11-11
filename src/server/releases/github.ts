import { z } from 'zod'
import type { ReleaseObject, NativeReleaseEvidence } from '../../shared/releaseObjects'
import { activeReleaseLinks, type ReleasesRead } from '../../shared/releases'
import { githubJson } from '../pulls/github'
import { ReleaseMembershipReader } from './membership'

const repository = 'fortresspower/cmsandbox'
const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
const tagSchema = z.object({ name: z.string(), commit: z.object({ sha }) })
const recordSchema = z.object({ tag_name: z.string(), html_url: z.string(), body: z.string().nullable(), published_at: z.string().nullable(), draft: z.boolean() })
const runSchema = z.object({ id: z.number(), name: z.string(), path: z.string(), html_url: z.string(), head_sha: sha, head_branch: z.string().nullable(), event: z.string(), status: z.string(), conclusion: z.string().nullable(), run_attempt: z.number(), created_at: z.string(), updated_at: z.string(), run_started_at: z.string().nullable().optional() })
const version = (name: string) => /^v\d+\.\d+\.\d+$/.test(name)
const compareTags = (a: { name: string }, b: { name: string }) => {
  const left = a.name.slice(1).split('.').map(Number), right = b.name.slice(1).split('.').map(Number)
  return right[0]! - left[0]! || right[1]! - left[1]! || right[2]! - left[2]!
}
type Read = typeof githubJson
export interface GithubReleaseRead {
  releases: ReleaseObject[]
  status: 'fresh' | 'partial' | 'unknown'
  observedAt: string | null
  refreshing?: boolean
  warnings: string[]
}

/** Parse only the generated native-release block. Operator prose outside it is
 * retained as notes, never interpreted as deployment or acceptance evidence. */
export function nativeReleaseSummary(body: string): Pick<NativeReleaseEvidence, 'snapshotAt' | 'componentResults'> {
  const block = body.split('<!-- native-production-release:start -->')[1]?.split('<!-- native-production-release:end -->')[0] ?? ''
  return {
    snapshotAt: /^Snapshot: (\S+)/m.exec(block)?.[1] ?? null,
    componentResults: block.split('\n').flatMap(line => {
      const row = /^\| ([^|]+) \| ([^|]+) \| \[(?:run[^\]]*|workflow)\]\((https:\/\/github\.com\/[^)]+)\) \|$/.exec(line)
      return row ? [{ component: row[1]!.trim(), result: row[2]!.trim(), url: row[3]! }] : []
    }),
  }
}

/** Catalog and observations use the PR screen's Reader transport. No coordinator
 * export, GitHub mutation, synthetic deployment receipt or local release ledger.
 * Work is incremental to keep this shared API budget and HTTP latency bounded. */
export class GithubReleaseReader {
  private cached: GithubReleaseRead | null = null
  private until = 0
  private selectedTag: string | undefined
  private pending: Promise<GithubReleaseRead> | null = null
  private details = new Map<string, { at: number; observedAt: string | null; runs: NativeReleaseEvidence['runs']; known: boolean }>()
  private memberships: ReleaseMembershipReader
  constructor(private read: Read = githubJson, private now = Date.now) { this.memberships = new ReleaseMembershipReader(read, now) }

  async get(data: ReleasesRead, tag?: string): Promise<GithubReleaseRead> {
    while (!this.cached || this.until <= this.now() || tag !== this.selectedTag) {
      this.pending ??= this.refresh(tag).then(result => {
        this.cached = result
        this.selectedTag = tag
        this.until = this.now() + 60_000
        return result
      }).finally(() => { this.pending = null })
      await this.pending
    }
    return this.project(data)
  }

  /** Display never waits for GitHub or PR history. Refresh publishes the tag
   * catalog first, then component runs and membership as each read completes. */
  display(data: ReleasesRead, tag?: string): GithubReleaseRead {
    void this.get(data, tag).catch(() => {})
    return this.project(data)
  }

  private project(data: ReleasesRead): GithubReleaseRead {
    const value = this.cached ?? { releases: [], status: 'unknown' as const, observedAt: null, warnings: ['Reading GitHub release sources.'] }
    return { ...value, refreshing: !!this.pending, releases: value.releases.map(release => {
      const pulls = release.pulls.map(pull => ({ ...pull, links: data.pulls.find(existing => existing.id === pull.id)?.links ?? [] }))
      const ids = new Set(pulls.map(pull => pull.id)), cards = new Set(pulls.flatMap(pull => activeReleaseLinks(pull).map(link => link.cardId)))
      return { ...release, gaps: [...release.gaps], pulls, supportingPulls: data.pulls.filter(pull => !ids.has(pull.id) && activeReleaseLinks(pull).some(link => cards.has(link.cardId))) }
    }) }
  }

  private async list(path: string) {
    const result: unknown[] = []
    // GitHub's page parameter is bounded by the broker. At the limit preserve
    // known rows and report partial coverage rather than certify completeness.
    for (let page = 1; page <= 10; page++) {
      const rows = await this.read(`${path}?per_page=100&page=${page}`)
      if (!Array.isArray(rows)) throw new Error('Incomplete GitHub catalog')
      result.push(...rows)
      if (rows.length < 100) return { rows: result, complete: true }
    }
    return { rows: result, complete: false }
  }

  private async refresh(selectedTag?: string): Promise<GithubReleaseRead> {
    const observedAt = new Date(this.now()).toISOString(), warnings: string[] = []
    const [tagRead, recordRead, mainRead] = await Promise.allSettled([this.list(`/repos/${repository}/tags`), this.list(`/repos/${repository}/releases`), this.read(`/repos/${repository}/branches/main`)])
    if (tagRead.status === 'rejected') {
      return { status: 'unknown', observedAt: this.cached?.observedAt ?? null, warnings: ['GitHub version tags unavailable; release history is unknown.'], releases: (this.cached?.releases ?? []).map(release => ({ ...release, state: 'Unknown', github: release.github ? { ...release.github, runsStatus: 'unknown' as const } : undefined, provenance: { ...release.provenance, historical: true }, gaps: [...release.gaps, 'GitHub version tags unavailable; this is a last-known observation.'] })) }
    }
    let tags: z.infer<typeof tagSchema>[]
    try { tags = z.array(tagSchema).parse(tagRead.value.rows).filter(tag => version(tag.name)).sort(compareTags) }
    catch { return { status: 'unknown', observedAt: null, warnings: ['GitHub version tags unreadable; release history is unknown.'], releases: [] } }
    if (!tagRead.value.complete) warnings.push('GitHub tag history is partial; older releases may be missing.')
    let records: z.infer<typeof recordSchema>[] = [], recordsKnown = false
    if (recordRead.status === 'fulfilled') {
      try { records = z.array(recordSchema).parse(recordRead.value.rows); recordsKnown = recordRead.value.complete } catch { /* Unknown, not absent. */ }
    }
    if (!recordsKnown) warnings.push('GitHub Release records unavailable or incomplete; missing records are unknown.')
    const main = mainRead.status === 'fulfilled' ? z.object({ commit: z.object({ sha }) }).safeParse(mainRead.value) : null
    const mainSha = main?.success ? main.data.commit.sha : null
    if (!mainSha) warnings.push('Main HEAD is unavailable; untagged work is unknown.')
    const requested = tags.find(tag => tag.name === selectedTag)
    const recent = tags.slice(0, 5)
    if (requested && !recent.some(tag => tag.name === requested.name)) recent.push(requested)
    const ranges = new Map<string, Awaited<ReturnType<ReleaseMembershipReader['get']>>>()
    // Publish identities before waiting for Actions, compare or per-commit PRs.
    const publish = () => {
      const releases = recent.map((tag): ReleaseObject => {
        const detail = this.details.get(`${tag.name}:${tag.commit.sha}`), record = records.find(record => record.tag_name === tag.name)
        const previous = this.cached?.releases.find(release => release.version === tag.name && release.sourceSha === tag.commit.sha)
        const readable = !!detail?.known && detail.at >= this.now() - 60_000
        const range = ranges.get(tag.name), runs = detail?.runs ?? [], activity = runs.length > 0
        const latest = [...new Map([...runs].sort((a, b) => a.id - b.id).map(run => [run.workflow, run] as const)).values()]
        const gaps = ['Native Actions results do not establish current deployed component identities or feature acceptance.']
        if (!readable) gaps.push(detail ? 'Actions evidence is pending, stale or unreadable; retained runs are last known.' : 'Actions evidence pending; release activity is unknown until read.')
        if (detail && !runs.length) gaps.push('No matching component tag runs observed; deployment remains unknown. Older Actions history may have expired.')
        if ((range?.files ?? previous?.scope ?? []).length >= 300) gaps.push('GitHub compare file scope may be truncated at 300 files; PR membership is read from paginated commits independently.')
        const summary = nativeReleaseSummary(record?.body ?? '')
        if (summary.componentResults.some(row => /unknown|unavailable|missing|pending cutover/i.test(row.result))) gaps.push('The GitHub Release snapshot has missing component evidence; inspect its native links.')
        return {
          id: `${repository}:tag:${tag.name}`, repository, version: tag.name, sourceSha: tag.commit.sha,
          kind: 'production', candidateId: null, planId: null, executionId: null,
          scope: range?.files ?? previous?.scope ?? [], targets: [],
          state: !readable ? 'Unknown' : !activity ? 'Deployment unknown' : latest.some(run => run.status === 'completed' && run.conclusion !== 'success') ? 'Failed/unfinished components' : latest.some(run => run.status !== 'completed') ? 'Running' : 'Awaiting PROD verification',
          observedAt: runs.map(run => run.updatedAt).sort().at(-1) ?? record?.published_at ?? null,
          provenance: { source: 'GitHub version tag, Release record and component Actions runs', asOf: detail?.observedAt ?? observedAt, historical: !readable },
          evidenceUrl: record?.html_url ?? `https://github.com/${repository}/tree/${tag.name}`,
          membership: range?.membership ?? previous?.membership ?? { status: 'pending', baseline: null, baselineSha: null, observedAt: null, reason: 'Git release comparison pending; Changes are unknown.' },
          pulls: range ? [...range.pulls.values()] : previous?.pulls ?? [], gaps,
          github: { record: record ? 'available' : recordsKnown ? 'missing' : 'unknown', url: record?.html_url ?? null, body: record?.body ?? null, publishedAt: record?.published_at ?? null, ...summary, runs, runsStatus: readable ? 'fresh' : 'unknown' },
        }
      })
      if (tags[0] && mainSha !== tags[0].commit.sha) {
        const previous = this.cached?.releases.find(release => release.id === `${repository}:draft:main` && release.sourceSha === mainSha)
        const range = ranges.get('main'), baseline = tags[0]
        releases.push({ id: `${repository}:draft:main`, repository, version: 'main', sourceSha: mainSha,
          kind: 'draft', candidateId: null, planId: null, executionId: null, targets: [], state: mainSha ? 'Untagged work' : 'Unknown',
          scope: range?.files ?? previous?.scope ?? [], observedAt, provenance: { source: `Untagged main since ${baseline.name}`, asOf: observedAt, historical: !mainSha },
          evidenceUrl: `https://github.com/${repository}/compare/${baseline.name}...main`,
          membership: range ? { ...range.membership } : previous?.membership ?? { status: mainSha ? 'pending' : 'unknown', baseline: baseline.name, baselineSha: baseline.commit.sha, observedAt: null, reason: mainSha ? 'Reading untagged main changes.' : 'Main HEAD unavailable; untagged changes are unknown.' },
          pulls: range ? [...range.pulls.values()] : previous?.pulls ?? [],
          gaps: [`Main work since ${baseline.name} has no version tag; it is not a released version.`],
          github: { record: 'missing', url: null, body: null, publishedAt: null, snapshotAt: null, componentResults: [], runs: [], runsStatus: 'unknown' },
        })
      }
      return { releases, observedAt, status: warnings.length || releases.some(release => release.kind === 'production' && release.github?.runsStatus === 'unknown') ? 'partial' as const : 'fresh' as const, warnings: [...warnings] }
    }
    this.cached = publish()
    // Read the small recent window, never every historical tag. Each completed
    // run read is visible independently of slow PR membership enrichment.
    for (let offset = 0; offset < recent.length; offset += 3) {
      await Promise.all(recent.slice(offset, offset + 3).map(async tag => {
        const key = `${tag.name}:${tag.commit.sha}`
        const known = this.details.get(key)
        if (known?.known && known.at > this.now() - 60_000) return
        try {
          const runs: z.infer<typeof runSchema>[] = []
          let complete = false
          for (let page = 1; page <= 10; page++) {
            // Match exact tag/event locally. The existing Reader already supports
            // head_sha; an extra event query needlessly depends on broker rollout.
            const raw = z.object({ total_count: z.number(), workflow_runs: z.array(runSchema) }).parse(await this.read(`/repos/${repository}/actions/runs?head_sha=${tag.commit.sha}&per_page=100&page=${page}`))
            runs.push(...raw.workflow_runs)
            if (runs.length >= raw.total_count) { complete = true; break }
            if (!raw.workflow_runs.length) break
          }
          this.details.set(key, { at: this.now(), observedAt, known: complete, runs: runs.filter(run => ['push', 'workflow_run'].includes(run.event) && run.head_sha === tag.commit.sha && run.head_branch === tag.name && run.path.split('@')[0] !== '.github/workflows/release-production.yml').map(run => ({ id: run.id, name: run.name, workflow: run.path, url: run.html_url, sha: run.head_sha, status: run.status, conclusion: run.conclusion, attempt: run.run_attempt, createdAt: run.created_at, updatedAt: run.updated_at, startedAt: run.run_started_at ?? null })) })
        } catch {
          this.details.set(key, { at: this.now(), observedAt: this.details.get(key)?.observedAt ?? null, known: false, runs: this.details.get(key)?.runs ?? [] })
        }
        this.cached = publish()
      }))
    }
    const selected = [recent[0], requested].filter((tag, index, rows): tag is z.infer<typeof tagSchema> => !!tag && rows.indexOf(tag) === index)
    for (const tag of selected) {
      ranges.set(tag.name, await this.memberships.get(repository, tag.commit.sha, tag.name, tags))
      this.cached = publish()
    }
    if (tags[0] && mainSha && mainSha !== tags[0].commit.sha) {
      ranges.set('main', await this.memberships.since(repository, mainSha, tags[0]))
      this.cached = publish()
    }
    return publish()
  }
}
