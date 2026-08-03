import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ServiceState, SupervisorState } from './types.js'
import {
  isSupportedProcessId,
  probeProcessLiveness,
  processIdentity as readProcessIdentity,
} from './process-liveness.js'

export interface SupervisorOpts {
  name: string
  binaryPath: string
  args: string[]
  env?: Record<string, string>
  stateDir: string
  port: number
  /** Called repeatedly until it returns true; caller controls via probeTimeoutMs. */
  probe: () => Promise<boolean>
  probeTimeoutMs?: number
  probeIntervalMs?: number
  expectedBinaryName?: string
  restartBackoffMs?: number            // default: 2000
  maxRestartsPerMinute?: number        // default: 5
  shutdownGraceMs?: number             // default: 5000
  healthIntervalMs?: number            // default: 30000
  healthFailureThreshold?: number      // default: 2
  onStateChange?: (name: string, state: ServiceState) => void
  /** Process-identity reader; injectable for deterministic lifecycle tests. */
  processIdentity?: typeof readProcessIdentity
}

type TrackedProcessState = 'same' | 'gone' | 'replaced' | 'unknown'

interface AdoptedProcess {
  pid: number
  processIdentity: string
}

export class Supervisor {
  state: ServiceState = 'idle'
  pid = 0
  private child: ChildProcess | null = null
  private restartCount = 0
  private restartWindowStart = 0
  private exitHandler: ((code: number | null) => void) | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private consecutiveFailures = 0
  private stopping = false
  private stopFailurePending = false
  private trackedProcessIdentity: string | null = null
  constructor(private readonly opts: SupervisorOpts) {}

  async start(): Promise<void> {
    let resumeTrackedProcess = false
    if (this.stopping) {
      throw new Error(`${this.opts.name} shutdown is still pending`)
    }
    if (this.stopFailurePending && this.pid) {
      const status = this.trackedProcessState(this.pid)
      if (status === 'unknown') {
        throw new Error(`${this.opts.name} shutdown identity is still unresolved`)
      }
      if (status === 'gone' || status === 'replaced') this.finishStop()
      else {
        this.stopFailurePending = false
        resumeTrackedProcess = true
      }
    }
    this.state = 'starting'
    this.consecutiveFailures = 0
    mkdirSync(this.opts.stateDir, { recursive: true })

    if (resumeTrackedProcess) {
      const ok = await this.waitForReady()
      this.setState(ok ? 'ready' : 'degraded')
      this.startHealthLoop()
      return
    }

    // Try to adopt an existing process recorded in the state file.
    const adopted = this.tryAdopt()
    if (adopted) {
      this.pid = adopted.pid
      this.trackedProcessIdentity = adopted.processIdentity
      // Upgrade a compatible legacy state file so the next restart can prove
      // that the PID still names the same process lifetime.
      this.persist()
      const ok = await this.waitForReady()
      this.setState(ok ? 'ready' : 'degraded')
      this.startHealthLoop()
      return
    }

    this.spawnOnce()

    const ok = await this.waitForReady()
    this.setState(ok ? 'ready' : 'degraded')
    this.startHealthLoop()
  }

  async stop(): Promise<void> {
    const grace = this.opts.shutdownGraceMs ?? 5_000
    const pid = this.pid
    if (!pid) { this.finishStop(); return }
    this.stopping = true

    const beforeTerm = this.trackedProcessState(pid)
    if (beforeTerm === 'gone' || beforeTerm === 'replaced') {
      this.finishStop()
      return
    }
    if (beforeTerm === 'unknown') {
      this.failStop(`${this.opts.name} process ${pid} identity could not be verified`)
    }

    try { process.kill(pid, 'SIGTERM') } catch { /* checked below */ }

    // wait up to `grace` ms for the process to exit
    const deadline = Date.now() + grace
    while (Date.now() < deadline) {
      const status = this.trackedProcessState(pid)
      if (status === 'gone' || status === 'replaced') { this.finishStop(); return }
      await new Promise((r) => setTimeout(r, 50))
    }

    // escalate
    const beforeKill = this.trackedProcessState(pid)
    if (beforeKill === 'gone' || beforeKill === 'replaced') {
      this.finishStop()
      return
    }
    if (beforeKill === 'same') {
      try { process.kill(pid, 'SIGKILL') } catch { /* checked below */ }
    }
    // final drain
    const drainDeadline = Date.now() + 500
    while (Date.now() < drainDeadline) {
      const status = this.trackedProcessState(pid)
      if (status === 'gone' || status === 'replaced') { this.finishStop(); return }
      await new Promise((r) => setTimeout(r, 25))
    }
    const finalStatus = this.trackedProcessState(pid)
    if (finalStatus === 'same' || finalStatus === 'unknown') {
      this.failStop(`${this.opts.name} process ${pid} did not stop`)
    }
    this.finishStop()
  }

  private spawnOnce(): void {
    // Clear any orphan still holding our port before binding a fresh child.
    // Without this, a process that survived a crash/stop (e.g. stop() killed a
    // stale tracked pid while the real listener lived on) makes every spawn hit
    // EADDRINUSE and die immediately — leaving a dead tracked pid + a live
    // orphan, the exact loop that wedges restarts.
    this.reapPortOrphan()
    this.child = spawn(this.opts.binaryPath, this.opts.args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...(this.opts.env ?? {}) },
    })
    this.child.unref()
    this.pid = this.child.pid ?? 0
    if (!this.pid) throw new Error(`failed to spawn ${this.opts.name}`)
    this.trackedProcessIdentity = this.readProcessIdentity(this.pid)
    this.persist()
    this.exitHandler = () => {
      if (this.stopping || this.stopFailurePending) { this.finishStop(); return }
      // Ignore if we've completed shutdown or have given up.
      if (this.state === 'idle' || this.state === 'degraded') return
      this.onChildCrash()
    }
    this.child.once('exit', this.exitHandler)
  }

  private onChildCrash(): void {
    const now = Date.now()
    const max = this.opts.maxRestartsPerMinute ?? 5
    const backoff = this.opts.restartBackoffMs ?? 2_000
    if (now - this.restartWindowStart > 60_000) {
      this.restartWindowStart = now
      this.restartCount = 0
    }
    this.restartCount++
    if (this.restartCount > max) {
      this.setState('degraded')
      return
    }
    setTimeout(() => {
      try { this.spawnOnce() } catch { this.setState('degraded') }
    }, backoff).unref()
  }

  private async waitForReady(): Promise<boolean> {
    const timeoutMs = this.opts.probeTimeoutMs ?? 10_000
    const intervalMs = this.opts.probeIntervalMs ?? 250
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try { if (await this.opts.probe()) return true } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return false
  }

  private setState(s: ServiceState): void {
    // Reaching ready clears the crash budget: a service that has been healthy
    // shouldn't stay permanently disabled because of an old restart storm.
    // Without this, once restartCount exceeds maxRestartsPerMinute the supervisor
    // gives up forever (onChildCrash → setState('degraded'); return).
    if (s === 'ready') { this.restartCount = 0; this.restartWindowStart = 0 }
    if (this.state === s) return
    this.state = s
    this.opts.onStateChange?.(this.opts.name, s)
  }

  private isProcessAlive(): boolean {
    if (!this.pid) return false
    const status = this.trackedProcessState(this.pid)
    return status === 'same' || status === 'unknown'
  }

  /**
   * Identify the tracked process before interpreting PID liveness. A different
   * non-null token proves the original lifetime ended even when the numeric PID
   * now responds to signal 0; missing identity evidence remains fail-closed.
   */
  private trackedProcessState(pid: number): TrackedProcessState {
    const currentIdentity = this.readProcessIdentity(pid)
    const liveness = probeProcessLiveness(pid)
    if (liveness.state === 'gone' || liveness.state === 'invalid') return 'gone'
    if (!this.trackedProcessIdentity || !currentIdentity) return 'unknown'
    if (currentIdentity !== this.trackedProcessIdentity) return 'replaced'
    return 'same'
  }

  private readProcessIdentity(pid: number): string | null {
    return (this.opts.processIdentity ?? readProcessIdentity)(pid)
  }

  /**
   * Best-effort: SIGKILL any process (other than our own tracked child) listening
   * on our port, so a fresh spawn can bind cleanly. Linux-only via `ss`; on other
   * platforms or if `ss` is absent this is a no-op (execFileSync throws → caught).
   */
  private reapPortOrphan(): void {
    if (process.platform !== 'linux') return
    try {
      const out = execFileSync('ss', ['-H', '-ltnp', `sport = :${this.opts.port}`], { encoding: 'utf-8' })
      for (const m of out.matchAll(/pid=(\d+)/g)) {
        const pid = Number(m[1])
        if (pid && pid !== this.pid) {
          try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
        }
      }
    } catch { /* ss missing or nothing on the port — nothing to reap */ }
  }

  private startHealthLoop(): void {
    this.stopHealthLoop()
    const interval = this.opts.healthIntervalMs ?? 30_000
    const threshold = this.opts.healthFailureThreshold ?? 2
    this.healthTimer = setInterval(async () => {
      if (this.state === 'idle') return

      if (this.stopping) {
        if (!this.isProcessAlive()) this.finishStop()
        return
      }

      if (this.stopFailurePending) {
        if (!this.isProcessAlive()) this.finishStop()
        return
      }

      if (!this.isProcessAlive()) {
        // Attempt recovery from any live state (idle already returned above).
        // Previously this only fired from ready/starting, so a supervisor that
        // hit 'degraded' with a dead pid would wedge forever — the loop returned
        // without respawning or probing. onChildCrash still rate-limits, and the
        // 60s window plus the restartCount reset on ready make this self-healing.
        this.onChildCrash()
        return
      }

      try {
        const ok = await this.opts.probe()
        if (ok) {
          this.consecutiveFailures = 0
          if (this.state === 'degraded') this.setState('ready')
        } else {
          this.consecutiveFailures++
          if (this.consecutiveFailures >= threshold && this.state === 'ready') {
            this.setState('degraded')
          }
        }
      } catch {
        this.consecutiveFailures++
        if (this.consecutiveFailures >= threshold && this.state === 'ready') {
          this.setState('degraded')
        }
      }
    }, interval)
    this.healthTimer.unref()
  }

  private stopHealthLoop(): void {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null }
  }

  private finishStop(): void {
    this.stopHealthLoop()
    if (this.child && this.exitHandler) this.child.off('exit', this.exitHandler)
    this.exitHandler = null
    this.cleanupState()
    this.stopping = false
    this.stopFailurePending = false
    this.setState('idle')
  }

  private failStop(message: string): never {
    this.stopping = false
    this.stopFailurePending = true
    this.setState('degraded')
    throw new Error(message)
  }

  private stateFile(): string { return join(this.opts.stateDir, `${this.opts.name}.state.json`) }

  private persist(): void {
    const s: SupervisorState = {
      pid: this.pid,
      ...(this.trackedProcessIdentity
        ? { processIdentity: this.trackedProcessIdentity }
        : {}),
      binaryPath: this.opts.binaryPath,
      binaryHash: '',
      port: this.opts.port,
      startedAt: Date.now(),
    }
    writeFileSync(this.stateFile(), JSON.stringify(s, null, 2))
  }

  private cleanupState(): void {
    const f = this.stateFile()
    if (existsSync(f)) {
      try { unlinkSync(f) } catch { /* ignore */ }
    }
    this.pid = 0
    this.child = null
    this.trackedProcessIdentity = null
  }

  private tryAdopt(): AdoptedProcess | null {
    if (!existsSync(this.stateFile())) return null
    try {
      const s = JSON.parse(readFileSync(this.stateFile(), 'utf-8')) as SupervisorState
      if (!isSupportedProcessId(s.pid)) return null
      const currentIdentity = this.readProcessIdentity(s.pid)
      const liveness = probeProcessLiveness(s.pid)
      if (liveness.state === 'gone' || liveness.state === 'invalid') return null
      if (!currentIdentity) return null
      if (s.processIdentity && currentIdentity !== s.processIdentity) return null
      // A legacy state file has no lifetime token. Only adopt it when the
      // configured binary-name check can independently identify the process.
      if (!s.processIdentity && !this.opts.expectedBinaryName) return null
      // Validate the binary name if an expected name was provided
      if (this.opts.expectedBinaryName) {
        const actual = getProcessName(s.pid)
        if (!actual || !actual.includes(this.opts.expectedBinaryName)) return null
      }
      return { pid: s.pid, processIdentity: currentIdentity }
    } catch {
      return null
    }
  }
}

function getProcessName(pid: number): string | null {
  if (process.platform === 'linux') {
    try { return readlinkSync(`/proc/${pid}/exe`) } catch { return null }
  }
  if (process.platform === 'darwin') {
    try { return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' }).trim() } catch { return null }
  }
  return null
}
