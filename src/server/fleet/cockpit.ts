import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ok, fail } from '../api/envelope'
import { getConfigRoot } from '../configRoot'
import { loadConfig, firstmatePortWindow } from '../sessions/config'
import { LedgerWatcher } from '../firstmate/ledger-watcher'
import { FirstmateViews, parseWindowRef } from '../firstmate/views'
import { log } from '../logger'
import { resolveCorsHeaders } from '../api/cors'
import { currentOriginAllowlist } from '../api/originAllowlist'

const execFileAsync = promisify(execFile)

interface SnapshotTask {
  id?: unknown
  kind?: unknown
  project?: unknown
  branch?: unknown
  paths?: { worktree?: { path?: unknown } }
  current_state?: { state?: unknown; detail?: unknown; observed_at?: unknown; freshness?: unknown }
  endpoint?: { target?: unknown }
  pr?: { url?: unknown }
  backlog?: { title?: unknown }
}

export interface CockpitWorker {
  key: string
  id: string
  home: string
  kind: string
  state: string
  detail: string
  observedAt: string | null
  freshness: string
  objective: string
  project: string
  worktree: string
  branch: string
  prUrl: string | null
  terminalAvailable: boolean
}

const str = (value: unknown, fallback = 'unknown'): string => typeof value === 'string' && value.trim() ? value : fallback

/** First Mate owns the objective. Its documented brief heading is the only source we read. */
export function objectiveFromBrief(text: string): string | null {
  const section = text.match(/^## Captain's intent\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1]
  return section?.trim() || null
}

export class CockpitFleet {
  private workers: CockpitWorker[] = []
  private targets = new Map<string, { id: string; target: string | null }>()
  private watchers: LedgerWatcher[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private polling: Promise<void> | null = null
  private again = false
  private views: FirstmateViews
  private homes: string[]
  private errors: string[] = []
  private python: Promise<boolean> | null = null

  constructor() {
    const config = loadConfig({ _rootDir: getConfigRoot() })
    this.homes = config.firstmate.homes
    this.views = new FirstmateViews({ window: firstmatePortWindow(config) })
  }

  start(): void {
    void this.views.start().catch(err => log.warn('fleet', `terminal view sweep failed: ${(err as Error).message}`))
    for (const home of this.homes) {
      const watcher = new LedgerWatcher({ home, onBatch: () => this.refresh() })
      watcher.start()
      this.watchers.push(watcher)
    }
    this.timer = setInterval(() => void this.refresh(), 20_000)
    this.timer.unref?.()
    void this.refresh()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    for (const watcher of this.watchers) watcher.stop()
    this.views.stop()
  }

  list(): { workers: CockpitWorker[]; errors: string[] } {
    return { workers: this.workers, errors: this.errors }
  }

  portOf(key: string): number | null { return this.views.portOf(key) }

  async terminal(key: string) {
    const ref = this.targets.get(key)
    if (!ref) return null
    this.python ??= execFileAsync('python3', ['-c', '']).then(() => true, () => false)
    if (!await this.python) return { key, state: 'unavailable' as const, reason: 'python3 is required for a size-safe terminal view' }
    const result = await this.views.ensure(key, ref.id, ref.target)
    if (result.state !== 'live') return { key, ...result }
    const size = await this.windowSize(ref.target)
    if (!size) return { key, state: 'unavailable' as const, reason: 'worker window size unavailable' }
    return { key, ...result, pid: this.views.pidOf(key), ...size }
  }

  private async windowSize(target: string | null): Promise<{ cols: number; rows: number } | null> {
    const ref = parseWindowRef(target)
    if (!ref) return null
    try {
      const { stdout } = await execFileAsync('tmux', ['list-windows', '-t', `=${ref.session}`, '-F', '#{window_name} #{window_width} #{window_height}'], { timeout: 10_000 })
      const [, cols, rows] = stdout.split('\n').map(line => line.split(' ')).find(([name]) => name === ref.windowName) ?? []
      return Number(cols) > 0 && Number(rows) > 0 ? { cols: Number(cols), rows: Number(rows) } : null
    } catch { return null }
  }

  refresh(): Promise<void> {
    if (this.polling) { this.again = true; return this.polling }
    this.polling = (async () => {
      do {
        this.again = false
        const rows = await Promise.all(this.homes.map((home, index) => this.readHome(home, index)))
        const workers = rows.flatMap(row => row.workers)
        const targets = new Map(rows.flatMap(row => [...row.targets]))
        const errors = rows.flatMap(row => row.error ? [row.error] : [])
        // Preserve a home's last known workers if a transient snapshot read fails.
        for (const [index, row] of rows.entries()) {
          if (!row.error) continue
          for (const worker of this.workers.filter(w => w.home === this.homes[index])) {
            workers.push({ ...worker, freshness: 'unknown' })
            const target = this.targets.get(worker.key)
            if (target) targets.set(worker.key, target)
          }
        }
        for (const old of this.workers) if (!targets.has(old.key)) this.views.release(old.key)
        this.workers = workers
        this.targets = targets
        this.errors = errors
      } while (this.again)
    })().catch(err => log.warn('fleet', `snapshot refresh failed: ${(err as Error).message}`))
      .finally(() => { this.polling = null })
    return this.polling
  }

  private async readHome(home: string, index: number): Promise<{
    workers: CockpitWorker[]
    targets: Map<string, { id: string; target: string | null }>
    error: string | null
  }> {
    const targets = new Map<string, { id: string; target: string | null }>()
    try {
      const { stdout } = await execFileAsync(join(home, 'bin', 'fm-fleet-snapshot.sh'), ['--json'], {
        timeout: 18_000, maxBuffer: 16 * 1024 * 1024,
      })
      const snapshot = JSON.parse(stdout) as { schema?: string; tasks?: SnapshotTask[]; backlog?: { records?: Array<{ id?: string; title?: string }> } }
      if (snapshot.schema !== 'fm-fleet-snapshot.v1' || !Array.isArray(snapshot.tasks)) throw new Error('unexpected snapshot format')
      const titles = new Map((snapshot.backlog?.records ?? []).map(r => [r.id, r.title]))
      const workers = await Promise.all(snapshot.tasks.map(async task => {
        const id = str(task.id, '')
        if (!id) return null
        const key = `cockpit-${index}-${id}`
        const target = typeof task.endpoint?.target === 'string' ? task.endpoint.target : null
        targets.set(key, { id, target })
        let objective = str(task.backlog?.title ?? titles.get(id), 'unknown')
        try {
          const brief = await readFile(join(home, 'data', id, 'brief.md'), 'utf8')
          objective = objectiveFromBrief(brief) ?? objective
        } catch { /* backlog title is the documented fallback */ }
        const prUrl = typeof task.pr?.url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(task.pr.url)
          ? task.pr.url : null
        return {
          key, id, home, kind: str(task.kind), state: str(task.current_state?.state),
          detail: str(task.current_state?.detail), observedAt: typeof task.current_state?.observed_at === 'string' ? task.current_state.observed_at : null,
          freshness: str(task.current_state?.freshness), objective,
          project: str(task.project), worktree: str(task.paths?.worktree?.path),
          branch: str(task.branch), prUrl, terminalAvailable: !!target,
        } satisfies CockpitWorker
      }))
      return { workers: workers.filter((w): w is CockpitWorker => w !== null), targets, error: null }
    } catch (err) {
      return { workers: [], targets, error: `${home}: ${(err as Error).message}` }
    }
  }
}

export async function handleCockpitRequest(fleet: CockpitFleet, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0]
  const match = path?.match(/^\/api\/fleet\/([^/]+)\/terminal$/)
  if (path !== '/api/fleet' && !match) return false
  const headers = resolveCorsHeaders({ origin: req.headers.origin, allowlist: currentOriginAllowlist() }) as Record<string, string>
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers)
    res.end()
    return true
  }
  if (path === '/api/fleet' && req.method === 'GET') return ok(res, fleet.list(), { headers })
  if (match && req.method === 'GET') {
    const result = await fleet.terminal(decodeURIComponent(match[1]!))
    return result ? ok(res, result, { headers }) : fail(res, 'NOT_FOUND', 'Worker not found', { headers })
  }
  return false
}
