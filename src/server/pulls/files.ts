import { createHash } from 'node:crypto'
import { z } from 'zod'
import { releasePull } from '../../shared/releases'
import { fileCategory, type PullFootprint, type PullFile } from '../../shared/pullFootprint'
import { githubJson } from './github'

const metadata = z.object({ head: z.object({ sha: z.string() }), base: z.object({ sha: z.string() }), changed_files: z.number().int().nonnegative() })
const pageSchema = z.array(z.object({ filename: z.string().min(1), previous_filename: z.string().nullish(), status: z.string(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), changes: z.number().int().nonnegative() }))
/** Demand reads only. GitHub caps this API at 3,000 files; never imply complete coverage beyond it. */
export class PullFilesReader {
  private cache = new Map<string, { until: number; data: PullFootprint }>()
  private pending = new Map<string, Promise<PullFootprint>>()
  constructor(private read = githubJson, private now = Date.now) {}
  async get(url: string, head: string): Promise<PullFootprint> {
    const pull = releasePull(url)
    if (!pull) throw new Error('Invalid PR identity')
    const key = `${pull.id}@${head}`, cached = this.cache.get(key)
    if (cached && cached.until > this.now()) return cached.data
    let pending = this.pending.get(key)
    if (!pending) {
      pending = this.refresh(pull.url, pull.repository, pull.number, head, cached?.data).then(data => {
        this.cache.set(key, { until: this.now() + (data.complete ? 120_000 : 15_000), data })
        while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!)
        return data
      }).finally(() => this.pending.delete(key))
      this.pending.set(key, pending)
    }
    return pending
  }
  private async refresh(url: string, repository: string, number: number, head: string, previous?: PullFootprint): Promise<PullFootprint> {
    const path = `/repos/${repository}/pulls/${number}`
    const metaProjection = '{head:{sha:.head.sha},base:{sha:.base.sha},changed_files}'
    const before = metadata.parse(await this.read(path, metaProjection))
    if (before.head.sha !== head) throw new Error('PR head changed. Refresh the PR list before reading files.')
    const files = new Map<string, PullFile>()
    let error: string | null = null, ended = false
    try {
      for (let page = 1; page <= 30; page++) {
        const rows = pageSchema.parse(await this.read(`${path}/files?per_page=100&page=${page}`, '[.[]|{filename,previous_filename,status,additions,deletions,changes}]'))
        for (const row of rows) files.set(row.filename, { filename: row.filename, previousFilename: row.previous_filename ?? null, status: row.status,
          additions: row.additions, deletions: row.deletions, changes: row.changes, category: fileCategory(row.filename),
          url: `${url}/files#diff-${createHash('sha256').update(row.filename).digest('hex')}` })
        if (rows.length < 100 || files.size >= before.changed_files) { ended = true; break }
      }
    } catch (reason) { error = reason instanceof z.ZodError ? 'GitHub returned incomplete file metadata.' : (reason as Error).message }
    // Files pages have no head token. Recheck both sides so a push or base advance
    // during pagination cannot label a mixture of diffs as the captured head.
    const after = metadata.parse(await this.read(path, metaProjection))
    if (after.head.sha !== head || after.base.sha !== before.base.sha || after.changed_files !== before.changed_files) throw new Error('PR diff changed while reading files. Refresh and retry.')
    const complete = !error && ended && files.size === after.changed_files
    if (!complete && !error) error = before.changed_files > 3000 ? 'GitHub returns at most 3,000 files. Footprint covers observed files only.' : 'GitHub file coverage is incomplete. Footprint covers observed files only.'
    // A failed first page may retain the same-head/base result, explicitly stale.
    if (!files.size && error && previous?.baseHead === after.base.sha) return { ...previous, freshness: 'stale', complete: false, error }
    return { head, baseHead: after.base.sha, files: [...files.values()], expectedFiles: after.changed_files, complete,
      observedAt: new Date(this.now()).toISOString(), freshness: 'fresh', error }
  }
}
