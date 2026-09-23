// The first mate terminal view (M2). One ttyd per observed worker; each browser
// connection gets its OWN private tmux "view session" that holds nothing but a
// link to the worker's window (bin/tinstar-fm-view). The ttyd is reached through
// Tinstar's existing /s/<runId>/ proxy — the observed Run's `port` is its port —
// so no new endpoint shape goes near src/server/sessions/backends/tmux.ts, which
// is only used for its pure port/bind/health helpers.
//
// HARD INVARIANT: a view can never kill a worker, and nothing here ever addresses
// a worker's window destructively. tmux itself enforces the first half (killing a
// session closes only windows linked to it and no other session); this module
// enforces the second by only ever running these tmux verbs:
//   - list-windows            read-only, to resolve the window id from meta `window=`
//   - list-sessions           read-only, to find stale view sessions
//   - kill-session -t =tsview-…   the sweep of ABANDONED view sessions (and only those)
// View sessions are named `tsview-…`, never `tinstar-*` and never starting with the
// first mate's own session name (its bare `has-session -t firstmate` prefix-matches).
// views.test.ts asserts the verb allowlist against the recorded tmux calls.

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { PortWindow } from '../sessions/config'
import { log } from '../logger'
import { TERMINAL_AUTH_HEADER } from '../sessionProxy'
import { findPort, healthCheck, releasePort, terminalBindAddress, ttydVersionRefusalNow } from '../sessions/backends/tmux'
import { isSafeTaskId } from './reducer'

const execFileAsync = promisify(execFile)

export const VIEW_SESSION_PREFIX = 'tsview-'
export const VIEW_SCRIPT_NAME = 'tinstar-fm-view'
export const OBSERVER_PORT_LABEL = 'firstmate-observer'

/** A worker's tmux window as recorded by the first mate's meta `window=` field. */
export interface WorkerWindowRef { session: string; windowName: string }

/** Parse `session:window` from meta. Null for anything that is not a plain tmux
 *  target we would hand to the view script (which re-validates it). */
export function parseWindowRef(target: string | null | undefined): WorkerWindowRef | null {
  if (!target) return null
  const m = target.match(/^([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)$/)
  if (!m) return null
  const [, session, windowName] = m as unknown as [string, string, string]
  if (session.startsWith(VIEW_SESSION_PREFIX) || VIEW_SESSION_PREFIX.startsWith(session)) return null
  return { session, windowName }
}

/** ttyd's argv for one worker. Pure; exported for tests. */
export function viewTtydArgv(opts: {
  port: number; bind: string; authHeader: string; task: string
  script: string; session: string; windowId: string; windowName: string
}): string[] {
  return [
    '-W',
    '-i', opts.bind,
    '-H', opts.authHeader,
    '-p', String(opts.port),
    '-t', `titleFixed=${opts.task}`,
    '-t', 'theme={"background":"#000000"}',
    opts.script, opts.session, opts.windowId, opts.windowName,
  ]
}

/** Find `bin/tinstar-fm-view` from the module's own directory (works from `src/`
 *  in dev and from `dist/server/` when installed). */
export function resolveViewScript(startDir = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'bin', VIEW_SCRIPT_NAME)
    if (existsSync(p)) return p
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

export interface ProcRow { pid: number; ppid: number; args: string }

/** Parse `ps -axo pid=,ppid=,args=`. */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! })
  }
  return rows
}

/** ttyds this module started in a previous process: orphaned (reparented to init)
 *  and running our view script. A ttyd still owned by a live server (another
 *  Tinstar backend sharing the script) has a live parent and is never listed. */
export function orphanViewTtydPids(rows: ProcRow[], script: string): number[] {
  return rows
    .filter(r => r.ppid === 1 && /(^|\/)ttyd$/.test(r.args.split(' ')[0] ?? '') && r.args.includes(` ${script} `))
    .map(r => r.pid)
}

export interface SessionRow { name: string; attached: number; createdSec: number }

/** View sessions nobody is attached to that have outlived their attach window: the
 *  residue of a viewer that hung up between session creation and attach. */
export function staleViewSessions(rows: SessionRow[], nowSec: number, graceSec = 60): string[] {
  return rows
    .filter(r => r.name.startsWith(VIEW_SESSION_PREFIX) && r.attached === 0 && nowSec - r.createdSec > graceSec)
    .map(r => r.name)
}

export interface ViewsDeps {
  /** Runs the user's (default-server) tmux. Rejects on non-zero exit. */
  tmux(args: string[]): Promise<string>
  ps(): Promise<string>
  findPort(window: PortWindow): Promise<number>
  releasePort(port: number): void
  healthCheck(port: number): Promise<boolean>
  bindAddress(): string
  authHeader: string
  /** A string explaining why ttyd cannot be used, or null when it can. */
  ttydRefusal(): string | null
  spawnTtyd(argv: string[]): ChildProcess
  killPid(pid: number): void
  now(): number
}

export function defaultViewsDeps(): ViewsDeps {
  return {
    tmux: async args => (await execFileAsync('tmux', args, { timeout: 10_000 })).stdout,
    ps: async () => (await execFileAsync('ps', ['-axo', 'pid=,ppid=,args='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout,
    findPort,
    releasePort,
    healthCheck: port => healthCheck(port, { timeout: 5000 }),
    bindAddress: terminalBindAddress,
    authHeader: TERMINAL_AUTH_HEADER,
    ttydRefusal: ttydVersionRefusalNow,
    spawnTtyd: argv => spawn('ttyd', argv, { stdio: 'ignore' }),
    killPid: pid => process.kill(pid, 'SIGTERM'),
    now: () => Math.floor(Date.now() / 1000),
  }
}

interface LiveView {
  runId: string
  key: string
  port: number
  child: ChildProcess
}

export interface FirstmateViewsOpts {
  window: PortWindow
  deps?: Partial<ViewsDeps>
  script?: string | null
  /** Called when a view's ttyd exits on its own (crash / killed), so the card can drop its port. */
  onExit?: (runId: string) => void
}

export type TerminalResult =
  | { state: 'live'; port: number }
  | { state: 'unavailable'; reason: string }

export class FirstmateViews {
  private readonly deps: ViewsDeps
  private readonly script: string | null
  private readonly live = new Map<string, LiveView>()
  private readonly inflight = new Map<string, Promise<TerminalResult>>()
  private stopped = false
  private warnedRefusal = false

  constructor(private readonly opts: FirstmateViewsOpts) {
    this.deps = { ...defaultViewsDeps(), ...opts.deps }
    this.script = opts.script === undefined ? resolveViewScript() : opts.script
  }

  /** Boot: end ttyds orphaned by a previous process, and view sessions nobody holds.
   *  Killing a ttyd only ends a view — the worker's window is never addressed. */
  async start(): Promise<void> {
    await this.sweepOrphanTtyds()
    await this.sweepStaleViewSessions()
  }

  stop(): void {
    this.stopped = true
    for (const v of [...this.live.values()]) this.stopView(v.runId, false)
  }

  portOf(runId: string): number | null {
    return this.live.get(runId)?.port ?? null
  }

  /** Make sure a ttyd serves `runId`'s worker window. Idempotent; concurrent calls share one attempt. */
  ensure(runId: string, task: string, windowTarget: string | null): Promise<TerminalResult> {
    const pending = this.inflight.get(runId)
    if (pending) return pending
    const p = this.doEnsure(runId, task, windowTarget).finally(() => this.inflight.delete(runId))
    this.inflight.set(runId, p)
    return p
  }

  /** Stop the run's ttyd (card removed / worker cleaned up). Ends views only. */
  release(runId: string): void {
    this.stopView(runId, false)
  }

  private async doEnsure(runId: string, task: string, windowTarget: string | null): Promise<TerminalResult> {
    if (this.stopped) return { state: 'unavailable', reason: 'observer stopped' }
    if (!this.script) return { state: 'unavailable', reason: `${VIEW_SCRIPT_NAME} not found` }
    if (!isSafeTaskId(task)) return { state: 'unavailable', reason: 'unsafe task id' }
    const ref = parseWindowRef(windowTarget)
    if (!ref) {
      this.stopView(runId, false)
      return { state: 'unavailable', reason: windowTarget ? 'not a tmux window target' : 'no window recorded yet' }
    }
    let windowId: string | null
    try {
      windowId = await this.resolveWindowId(ref)
    } catch (err) {
      this.stopView(runId, false)
      return { state: 'unavailable', reason: `tmux unreadable: ${(err as Error).message.split('\n')[0]}` }
    }
    if (!windowId) {
      this.stopView(runId, false)
      return { state: 'unavailable', reason: 'worker window not found' }
    }
    // The window id changes when the first mate relaunches a worker: restart on change.
    const key = `${ref.session}:${ref.windowName}:${windowId}`
    const existing = this.live.get(runId)
    if (existing) {
      if (existing.key === key && existing.child.exitCode === null && existing.child.signalCode === null) {
        return { state: 'live', port: existing.port }
      }
      this.stopView(runId, false)
    }
    const refusal = this.deps.ttydRefusal()
    if (refusal) {
      if (!this.warnedRefusal) { this.warnedRefusal = true; log.warn('firstmate', `terminal view unavailable: ${refusal}`) }
      return { state: 'unavailable', reason: refusal.split('\n')[0]! }
    }
    let port: number
    try {
      port = await this.deps.findPort(this.opts.window)
    } catch (err) {
      return { state: 'unavailable', reason: (err as Error).message }
    }
    const argv = viewTtydArgv({
      port, bind: this.deps.bindAddress(), authHeader: this.deps.authHeader, task,
      script: this.script, session: ref.session, windowId, windowName: ref.windowName,
    })
    let child: ChildProcess
    try {
      child = this.deps.spawnTtyd(argv)
    } catch (err) {
      this.deps.releasePort(port)
      return { state: 'unavailable', reason: `could not start ttyd: ${(err as Error).message}` }
    }
    const view: LiveView = { runId, key, port, child }
    this.live.set(runId, view)
    child.on('error', err => {
      log.warn('firstmate', `ttyd for ${runId} failed: ${err.message}`)
      this.dropIfCurrent(view, true)
    })
    child.on('exit', () => this.dropIfCurrent(view, true))
    const healthy = await this.deps.healthCheck(port)
    if (!healthy || this.live.get(runId) !== view) {
      if (this.live.get(runId) === view) this.stopView(runId, false)
      return { state: 'unavailable', reason: 'terminal did not become ready' }
    }
    return { state: 'live', port }
  }

  private dropIfCurrent(view: LiveView, notify: boolean): void {
    if (this.live.get(view.runId) !== view) return
    this.live.delete(view.runId)
    this.deps.releasePort(view.port)
    if (notify && !this.stopped) this.opts.onExit?.(view.runId)
  }

  private stopView(runId: string, notify: boolean): void {
    const view = this.live.get(runId)
    if (!view) return
    this.live.delete(runId)
    this.deps.releasePort(view.port)
    try { view.child.kill('SIGTERM') } catch { /* already gone */ }
    if (notify) this.opts.onExit?.(runId)
  }

  private async resolveWindowId(ref: WorkerWindowRef): Promise<string | null> {
    let out: string
    try {
      out = await this.deps.tmux(['list-windows', '-t', `=${ref.session}`, '-F', '#{window_id} #{window_name}'])
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr ?? (err as Error).message)
      // A missing session or server is a definitive "no such window", not a tmux failure.
      if (/can't find session|no server running|error connecting to/.test(msg)) return null
      throw err
    }
    for (const line of out.split('\n')) {
      const sp = line.indexOf(' ')
      if (sp > 0 && line.slice(sp + 1) === ref.windowName && /^@\d+$/.test(line.slice(0, sp))) return line.slice(0, sp)
    }
    return null
  }

  async sweepOrphanTtyds(): Promise<number> {
    if (!this.script) return 0
    let rows: ProcRow[]
    try { rows = parsePs(await this.deps.ps()) } catch { return 0 }
    const pids = orphanViewTtydPids(rows, this.script)
    for (const pid of pids) {
      try { this.deps.killPid(pid) } catch { /* raced its own exit */ }
    }
    if (pids.length) log.info('firstmate', `ended ${pids.length} orphaned terminal view ttyd(s)`)
    return pids.length
  }

  async sweepStaleViewSessions(): Promise<number> {
    let out: string
    try {
      out = await this.deps.tmux(['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_created}'])
    } catch { return 0 }
    const rows: SessionRow[] = []
    for (const line of out.split('\n')) {
      const [name, attached, created] = line.split('\t')
      if (name && attached !== undefined && created !== undefined) rows.push({ name, attached: Number(attached), createdSec: Number(created) })
    }
    const stale = staleViewSessions(rows, this.deps.now())
    for (const name of stale) {
      // `=` exact match; the name is guaranteed to start with `tsview-` by staleViewSessions.
      try { await this.deps.tmux(['kill-session', '-t', `=${name}`]) } catch { /* already gone */ }
    }
    return stale.length
  }
}
