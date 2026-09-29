import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ok, fail } from '../api/envelope'
import { readBody } from '../api/readBody'
import { getConfigRoot } from '../configRoot'
import { loadFleetConfig, firstmatePortWindow } from './config'
import { LedgerWatcher } from '../firstmate/ledger-watcher'
import { FirstmateViews, parseWindowRef } from '../firstmate/views'
import { log } from '../logger'
import { resolveCorsHeaders } from '../api/cors'
import { currentOriginAllowlist } from '../api/originAllowlist'
import { buildAttentionCards, parsePullUrl, type AttentionBacklogRow, type AttentionCard, type AttentionTask, type ReviewStatus } from './attention'
import { dismissDirect } from './dismiss'
import { FleetOutbox, type OutboxMessage, type SubmitResult } from './inbox'
import { directKey, directSet, WorkerMarks, WorkerMarksUnreadable } from './marks'
import { displayedWorkerState, secondmateActivityById, type MateSnapshot } from './workerState'

const execFileAsync = promisify(execFile)

interface SnapshotTask extends AttentionTask {
  id?: unknown
  kind?: unknown
  project?: unknown
  branch?: unknown
  paths?: MateSnapshot['paths'] & { worktree?: { path?: unknown } }
  current_state?: { state?: unknown; source?: unknown; detail?: unknown; observed_at?: unknown; freshness?: unknown }
  endpoint?: { target?: unknown; exists?: unknown; agent_alive?: unknown; status?: unknown }
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
  direct: boolean
}

const str = (value: unknown, fallback = 'unknown'): string => typeof value === 'string' && value.trim() ? value : fallback

/** First Mate owns the objective. Its documented brief heading is the only source we read. */
export function objectiveFromBrief(text: string): string | null {
  const section = text.match(/^## Captain's intent\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1]
  return section?.trim() || null
}

export class CockpitFleet {
  private workers: CockpitWorker[] = []
  private attention: AttentionCard[] = []
  private targets = new Map<string, { id: string; target: string | null }>()
  private watchers: LedgerWatcher[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private polling: Promise<void> | null = null
  private again = false
  private views: FirstmateViews
  private homes: string[]
  private errors: string[] = []
  private marksUnreadable = false
  private python: Promise<boolean> | null = null
  private sizes = new Map<string, { cols: number; rows: number }>()
  private reviews = new Map<string, { status: ReviewStatus; until: number }>()
  private reviewing = new Set<string>()
  private ready = false
  private outbox = new FleetOutbox()
  private marks = new WorkerMarks()

  constructor() {
    const config = loadFleetConfig(getConfigRoot())
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

  list(): { ready: boolean; workers: Array<CockpitWorker & { terminalPid: number | null }>; attention: Array<AttentionCard & { home: string | null }>; errors: string[] } {
    return { ready: this.ready, workers: this.workers.map(worker => ({ ...worker, terminalPid: this.views.pidOf(worker.key) })), attention: this.attention.map(card => ({ ...card, home: this.homes[card.homeIndex] ?? null })), errors: this.marksUnreadable ? [...this.errors, 'Worker marks could not be read'] : this.errors }
  }

  portOf(key: string): number | null { return this.views.portOf(key) }

  messages() {
    return this.outbox.list(this.homes, message => this.attention.some(card => this.sameCall(card, message)), this.ready && this.errors.length === 0)
  }

  private sameCall(card: AttentionCard, message: OutboxMessage): boolean {
    return this.homes[card.homeIndex] === message.home &&
      ((message.holdId !== null && card.holdId === message.holdId) ||
        (card.type === message.cardType && card.taskId === message.taskId && card.decisionKey === message.decisionKey))
  }

  private describe(message: OutboxMessage, card = this.attention.find(item => this.sameCall(item, message))): string {
    const worker = this.workers.find(item => item.home === message.home && item.id === message.taskId)
    const target = [message.taskId ? `task ${message.taskId}` : 'First Mate backlog',
      message.decisionKey ? `decision ${message.decisionKey}` : message.cardType && `${message.cardType} card`,
      message.holdId && message.holdId !== message.decisionKey && `hold ${message.holdId}`].filter(Boolean).join(', ')
    return `${message.kind === 'answer' ? 'Answer for' : 'Message about'} ${target} (${card?.headline ?? worker?.objective ?? 'context unavailable'})`
  }

  async submit(input: unknown): Promise<SubmitResult | null> {
    if (!input || typeof input !== 'object') return null
    const value = input as Record<string, unknown>
    const { requestId, anchorKey, kind, text } = value
    if (typeof requestId !== 'string' || !/^tinstar-[a-f0-9-]{36}$/.test(requestId) ||
      typeof text !== 'string' || !text.trim() || text.length > 10_000 ||
      (kind !== 'answer' && kind !== 'message')) return null
    const previous = await this.outbox.get(requestId)
    if (previous) {
      if (previous.kind !== kind || previous.text !== text.trim() || !this.homes.includes(previous.home)) return null
      return this.outbox.submit(previous, this.describe(previous))
    }
    if (typeof anchorKey !== 'string') return null
    const card = this.attention.find(item => item.key === anchorKey)
    const worker = this.workers.find(item => item.key === anchorKey)
    if (kind === 'answer' && card?.type !== 'decision') return null
    const home = card ? this.homes[card.homeIndex] : worker?.home
    if (!home || !this.homes.includes(home)) return null
    const message: OutboxMessage = {
      requestId, home, kind, text: text.trim(),
      taskId: card ? card.taskId : worker!.id,
      decisionKey: card?.decisionKey ?? null,
      holdId: card?.holdId ?? null,
      cardType: card?.type ?? null,
    }
    return this.outbox.submit(message, this.describe(message, card))
  }

  /** Closes a classified decision here. An unclassified decision stays on the inbox-note path. */
  async dismiss(key: string): Promise<{ dismissed: true } | { dismissed: false; fallback: true } | { dismissed: false; error: string } | null> {
    const card = this.attention.find(item => item.key === key)
    const home = card ? this.homes[card.homeIndex] : undefined
    if (!card || !home || !this.homes.includes(home)) return null
    if ((card.dismissal === 'captain-hold' && card.holdId) || (card.dismissal === 'resolve-key' && card.taskId && card.decisionKey)) {
      return dismissDirect(home, card)
    }
    if (card.type === 'decision' && card.decisionKey) return { dismissed: false, fallback: true }
    return null
  }

  /** Persists a direct mark and notes First Mate only when the mark changes. */
  async setDirect(key: string, direct: boolean): Promise<{ direct: boolean; note: SubmitResult | null } | null> {
    const worker = this.workers.find(item => item.key === key)
    if (!worker) return null
    const changed = await this.marks.queue(async () => {
      const current = this.workers.find(item => item.home === worker.home && item.id === worker.id)
      if (!current) return null
      const changed = await this.marks.change(worker.home, worker.id, direct)
      this.workers = this.workers.map(item => item.home === worker.home && item.id === worker.id ? { ...item, direct } : item)
      return changed
    })
    if (changed === null) return null
    if (!changed) return { direct, note: null }
    const message: OutboxMessage = {
      requestId: `tinstar-${randomUUID()}`,
      home: worker.home,
      kind: 'message',
      taskId: worker.id,
      decisionKey: null,
      holdId: null,
      cardType: null,
      text: direct ? 'This worker is marked direct.' : 'This worker is marked managed.',
    }
    const note = await this.outbox.submit(message, `Message about task ${worker.id}`)
      .catch((error: Error): SubmitResult => ({ saved: false, error: error.message, canReceive: 'unknown' }))
    return { direct, note }
  }

  async terminal(key: string) {
    const ref = this.targets.get(key)
    if (!ref) return null
    this.python ??= execFileAsync('python3', ['-c', '']).then(() => true, () => false)
    if (!await this.python) return { key, state: 'unavailable' as const, reason: 'python3 is required for a size-safe terminal view' }
    const result = await this.views.ensure(key, ref.id, ref.target)
    if (result.state !== 'live') return { key, ...result }
    const size = await this.windowSize(ref.target) ?? this.sizes.get(key)
    if (!size) return { key, state: 'unavailable' as const, reason: 'worker window size unavailable' }
    this.sizes.set(key, size)
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
        const attention = rows.flatMap(row => row.attention)
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
          attention.push(...this.attention.filter(card => card.key.startsWith(`attention-${index}:`)))
        }
        for (const old of this.workers) {
          if (targets.has(old.key)) continue
          this.views.release(old.key)
          this.sizes.delete(old.key)
        }
        // Stamp inside the marks queue so a toggle cannot publish a stale direct flag.
        let marksUnreadable = false
        await this.marks.queue(async () => {
          try {
            const marked = directSet(await this.marks.read())
            this.workers = workers.map(worker => ({ ...worker, direct: marked.has(directKey(worker.home, worker.id)) }))
          } catch (error) {
            if (!(error instanceof WorkerMarksUnreadable)) throw error
            marksUnreadable = true
            const previous = new Map(this.workers.map(worker => [directKey(worker.home, worker.id), worker.direct]))
            this.workers = workers.map(worker => ({ ...worker, direct: previous.get(directKey(worker.home, worker.id)) ?? false }))
          }
        })
        const seenPulls = new Set<string>()
        this.attention = attention.filter(card => {
          if (card.type !== 'review' || !card.prUrl) return true
          if (seenPulls.has(card.prUrl)) return false
          seenPulls.add(card.prUrl)
          return true
        })
        this.targets = targets
        this.errors = errors
        this.marksUnreadable = marksUnreadable
        this.ready = true
        const pulls = new Set(workers.map(worker => worker.prUrl))
        for (const url of this.reviews.keys()) if (!pulls.has(url)) this.reviews.delete(url)
        for (const [key, ref] of targets) {
          if (this.views.portOf(key) === null) continue
          void this.views.ensure(key, ref.id, ref.target)
            .catch(err => log.warn('fleet', `terminal view check failed: ${(err as Error).message}`))
        }
      } while (this.again)
    })().catch(err => log.warn('fleet', `snapshot refresh failed: ${(err as Error).message}`))
      .finally(() => { this.polling = null })
    return this.polling
  }

  private async readHome(home: string, index: number): Promise<{
    workers: CockpitWorker[]
    attention: AttentionCard[]
    targets: Map<string, { id: string; target: string | null }>
    error: string | null
  }> {
    const targets = new Map<string, { id: string; target: string | null }>()
    try {
      const { stdout } = await execFileAsync(join(home, 'bin', 'fm-fleet-snapshot.sh'), ['--json'], {
        timeout: 18_000, maxBuffer: 16 * 1024 * 1024,
      })
      const snapshot = JSON.parse(stdout) as {
        schema?: string; tasks?: SnapshotTask[]; backlog?: { records?: AttentionBacklogRow[] }
        secondmate_current?: { records?: unknown }
      }
      if (snapshot.schema !== 'fm-fleet-snapshot.v1' || !Array.isArray(snapshot.tasks)) throw new Error('unexpected snapshot format')
      const backlog = Array.isArray(snapshot.backlog?.records) ? snapshot.backlog.records : []
      const titles = new Map(backlog.map(r => [r.id, r.title]))
      const mateActivity = secondmateActivityById(snapshot)
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
        const prUrl = typeof task.pr?.url === 'string' && parsePullUrl(task.pr.url)
          ? task.pr.url : null
        const displayed = displayedWorkerState(task, mateActivity.get(id) ?? null)
        const worker: CockpitWorker = {
          key, id, home, kind: str(task.kind), state: displayed.state,
          detail: displayed.detail, observedAt: typeof task.current_state?.observed_at === 'string' ? task.current_state.observed_at : null,
          freshness: str(task.current_state?.freshness), objective,
          project: str(task.project), worktree: str(task.paths?.worktree?.path),
          branch: str(task.branch), prUrl, terminalAvailable: !!target, direct: false,
        }
        return worker
      }))
      const presentWorkers = workers.filter((w): w is CockpitWorker => w !== null)
      const pullUrls = [...new Set(presentWorkers.map(worker => worker.prUrl).filter((url): url is string => !!url))]
      const reviewStatuses = new Map(pullUrls.map(url => [url, this.reviewStatus(url)] as const))
      const attention = buildAttentionCards(index, snapshot.tasks, backlog, presentWorkers, reviewStatuses)
      return { workers: presentWorkers, attention, targets, error: null }
    } catch (err) {
      return { workers: [], attention: [], targets, error: `${home}: ${(err as Error).message}` }
    }
  }

  private reviewStatus(url: string): ReviewStatus {
    const cached = this.reviews.get(url)
    if (!cached || (cached.status !== 'merged' && cached.until <= Date.now())) void this.fetchReviewStatus(url, cached?.status)
    return cached?.status ?? 'unknown'
  }

  private async fetchReviewStatus(url: string, previous: ReviewStatus | undefined): Promise<void> {
    const parsed = parsePullUrl(url)
    if (!parsed || this.reviewing.has(url)) return
    this.reviewing.add(url)
    let status: ReviewStatus = 'unknown'
    try {
      // GitHub is authoritative for merge state; First Mate's PR URL can outlive a merge.
      const { stdout } = await execFileAsync('gh', ['api', parsed.apiPath], { timeout: 8_000, maxBuffer: 1024 * 1024 })
      const pull = JSON.parse(stdout) as { state?: unknown; merged_at?: unknown }
      if (pull.merged_at) status = 'merged'
      else if (pull.state === 'open' || pull.state === 'closed') status = pull.state
    } catch (err) {
      if (previous === 'merged' || previous === 'closed') status = previous
      else if (previous !== 'unknown') log.warn('fleet', `pull request status unavailable: ${(err as Error).message}`)
    } finally {
      this.reviewing.delete(url)
    }
    this.reviews.set(url, { status, until: Date.now() + (status === 'unknown' ? 300_000 : 60_000) })
    if (status !== (previous ?? 'unknown')) void this.refresh()
  }
}

export async function handleCockpitRequest(fleet: CockpitFleet, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0]
  const terminalMatch = path?.match(/^\/api\/fleet\/([^/]+)\/terminal$/)
  const directMatch = path?.match(/^\/api\/fleet\/([^/]+)\/direct$/)
  if (path !== '/api/fleet' && path !== '/api/fleet/messages' && path !== '/api/fleet/dismiss' && !terminalMatch && !directMatch) return false
  const allowedOrigins = currentOriginAllowlist()
  const headers = resolveCorsHeaders({ origin: req.headers.origin, allowlist: allowedOrigins }) as Record<string, string>
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers)
    res.end()
    return true
  }
  if (path === '/api/fleet' && req.method === 'GET') return ok(res, fleet.list(), { headers })
  if (path === '/api/fleet/messages' && req.method === 'GET') {
    try { return ok(res, await fleet.messages(), { headers }) }
    catch { return fail(res, 'BACKEND_UNAVAILABLE', 'Messages unavailable', { headers }) }
  }
  if (path === '/api/fleet/dismiss' && req.method === 'POST') {
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
    if (!req.headers['content-type']?.startsWith('application/json')) return fail(res, 'BAD_REQUEST', 'Expected JSON', { headers })
    let input: unknown
    try { input = JSON.parse(await readBody(req)) } catch { return fail(res, 'BAD_REQUEST', 'Invalid dismiss', { headers }) }
    const key = input && typeof input === 'object' ? (input as { key?: unknown }).key : undefined
    if (typeof key !== 'string' || !key) return fail(res, 'BAD_REQUEST', 'Expected a decision', { headers })
    const result = await fleet.dismiss(key)
    return result ? ok(res, result, { headers }) : fail(res, 'BAD_REQUEST', 'Decision is unavailable', { headers })
  }
  if (path === '/api/fleet/messages' && req.method === 'POST') {
    // An unrelated page must not queue a note through the operator's local server.
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
    if (!req.headers['content-type']?.startsWith('application/json')) return fail(res, 'BAD_REQUEST', 'Expected JSON', { headers })
    let input: unknown
    try { input = JSON.parse(await readBody(req)) } catch { return fail(res, 'BAD_REQUEST', 'Invalid message', { headers }) }
    try {
      const result = await fleet.submit(input)
      return result ? ok(res, result, { headers }) : fail(res, 'BAD_REQUEST', 'Message target is unavailable', { headers })
    } catch (error) { return fail(res, 'CONFLICT', (error as Error).message, { headers }) }
  }
  if (directMatch && req.method === 'POST') {
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
    if (!req.headers['content-type']?.startsWith('application/json')) return fail(res, 'BAD_REQUEST', 'Expected JSON', { headers })
    let input: unknown
    try { input = JSON.parse(await readBody(req)) } catch { return fail(res, 'BAD_REQUEST', 'Invalid mark', { headers }) }
    const direct = input && typeof input === 'object' ? (input as { direct?: unknown }).direct : undefined
    if (typeof direct !== 'boolean') return fail(res, 'BAD_REQUEST', 'Expected a direct mark', { headers })
    try {
      const result = await fleet.setDirect(decodeURIComponent(directMatch[1]!), direct)
      return result ? ok(res, result, { headers }) : fail(res, 'NOT_FOUND', 'Worker not found', { headers })
    } catch (error) {
      if (error instanceof WorkerMarksUnreadable) return fail(res, 'CONFIG_UNAVAILABLE', 'Worker marks could not be read', { headers })
      return fail(res, 'CONFLICT', (error as Error).message, { headers })
    }
  }
  if (terminalMatch && req.method === 'GET') {
    const result = await fleet.terminal(decodeURIComponent(terminalMatch[1]!))
    return result ? ok(res, result, { headers }) : fail(res, 'NOT_FOUND', 'Worker not found', { headers })
  }
  return false
}
