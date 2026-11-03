import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parsePullUrl } from '../fleet/attention'

export interface PullReadiness {
  status: 'fresh' | 'stale' | 'unknown'
  observedAt: string | null
  expiresAt: string | null
  state: 'open' | 'closed' | 'merged' | 'unknown'
  head: string | null
  draft: boolean
  checks: 'passed' | 'pending' | 'failed' | 'unknown'
  mergeability: 'ready' | 'blocked' | 'unknown'
}
const exec = promisify(execFile)

/** gh-axi's projected scalar response avoids retrieving bodies/reviews/transcripts.
 * Reject unsupported output as unknown rather than mistaking it for green checks.
 */
async function github(path: string, projection: string): Promise<Record<string, unknown>> {
  const { stdout } = await exec('gh-axi', ['api', 'GET', path, '--jq', projection], { timeout: 5_000, maxBuffer: 64 * 1024 })
  return Object.fromEntries(stdout.trim().split('\n').map(line => {
    const match = /^([a-z_]+): (.*)$/.exec(line)
    if (!match) throw new Error('Unsupported GitHub response')
    const value = match[2]!
    return [match[1]!, /^(?:true|false|null|\d+)$/.test(value) ? JSON.parse(value) : value]
  }))
}

async function readPull(url: string, read = github): Promise<Omit<PullReadiness, 'status' | 'observedAt' | 'expiresAt'>> {
  const pull = parsePullUrl(url)
  if (!pull) throw new Error('Unsupported PR URL')
  const info = await read(pull.apiPath, '{state,merged,draft,head:.head.sha,mergeable,mergeable_state}')
  if (!['open', 'closed'].includes(String(info.state)) || typeof info.merged !== 'boolean' || typeof info.draft !== 'boolean' || !/^[a-f0-9]{40,64}$/.test(String(info.head))) throw new Error('Incomplete PR response')
  const state = info.merged ? 'merged' : info.state as 'open' | 'closed'
  if (state !== 'open') return { state, head: String(info.head), draft: info.draft, checks: 'unknown', mergeability: 'unknown' }
  const headPath = `/repos/${pull.repository}/commits/${info.head}`
  const [checks, statuses] = await Promise.all([
    read(`${headPath}/check-runs?per_page=100`, '{total:.total_count,returned:(.check_runs|length),pending:([.check_runs[]|select(.status!="completed")]|length),failed:([.check_runs[]|select(.status=="completed" and (.conclusion!="success" and .conclusion!="neutral" and .conclusion!="skipped"))]|length)}'),
    read(`${headPath}/status?per_page=100`, '{total:.total_count,state}'),
  ])
  if (![checks.total, checks.returned, checks.pending, checks.failed, statuses.total].every(value => typeof value === 'number' && Number.isInteger(value) && value >= 0) || !['success', 'pending', 'failure', 'error'].includes(String(statuses.state))) throw new Error('Incomplete check response')
  // No pagination storm: >100 checks is explicit unknown, not a partial green.
  const checkState: PullReadiness['checks'] = checks.total !== checks.returned ? 'unknown' :
    Number(checks.failed) > 0 || ['failure', 'error'].includes(String(statuses.state)) ? 'failed' :
    Number(checks.pending) > 0 || Number(statuses.total) > 0 && statuses.state === 'pending' ? 'pending' :
    Number(checks.total) + Number(statuses.total) > 0 ? 'passed' : 'unknown'
  return { state, head: String(info.head), draft: info.draft, checks: checkState,
    mergeability: info.mergeable === true && info.mergeable_state === 'clean' ? 'ready' :
      info.mergeable === false || ['blocked', 'dirty', 'behind', 'unstable', 'draft'].includes(String(info.mergeable_state)) ? 'blocked' : 'unknown' }
}

/** Demand-driven cache; at most four PRs (12 GETs) per refresh, no retries/poller.
 * Missing CLI/auth/access is an unknown observation, never permission to merge.
 */
export class QueuePullReader {
  private cache = new Map<string, { value: PullReadiness; retryAt: number }>()
  private pending = new Map<string, Promise<PullReadiness>>()
  constructor(private readonly read = github, private readonly now = Date.now) {}

  async get(urls: string[]): Promise<Map<string, PullReadiness>> {
    const result = new Map<string, PullReadiness>()
    let budget = 4
    const work: Promise<void>[] = []
    const ordered = [...new Set(urls)].sort((a, b) =>
      (this.cache.get(a)?.retryAt ?? -Infinity) - (this.cache.get(b)?.retryAt ?? -Infinity))
    for (const url of ordered) {
      if (!parsePullUrl(url)) continue
      const cached = this.cache.get(url)
      let pending = this.pending.get(url)
      if (!pending && (!cached || this.now() >= cached.retryAt) && budget > 0 && this.pending.size < 4) {
        budget--
        pending = this.refresh(url).finally(() => { this.pending.delete(url) })
        this.pending.set(url, pending)
      }
      if (pending) work.push(pending.then(value => { result.set(url, this.age(value)) }))
      else if (cached) result.set(url, this.age(cached.value))
    }
    await Promise.all(work)
    return result
  }

  private age(value: PullReadiness): PullReadiness {
    return value.expiresAt && this.now() >= Date.parse(value.expiresAt) ? { ...value, status: 'stale' } : value
  }

  private async refresh(url: string): Promise<PullReadiness> {
    let value: PullReadiness
    try {
      const result = await readPull(url, this.read)
      const observedAt = new Date(this.now()).toISOString()
      value = { ...result, status: 'fresh', observedAt, expiresAt: new Date(this.now() + 60_000).toISOString() }
    } catch {
      const previous = this.cache.get(url)?.value
      value = previous ? { ...previous, status: 'stale' } : { status: 'unknown', observedAt: null, expiresAt: null,
        state: 'unknown', head: null, draft: false, checks: 'unknown', mergeability: 'unknown' }
    }
    this.cache.delete(url)
    this.cache.set(url, { value, retryAt: this.now() + 60_000 })
    while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!)
    return value
  }
}

