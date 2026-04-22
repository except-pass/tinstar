import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ServiceState, SupervisorState } from './types.js'

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
}

export class Supervisor {
  state: ServiceState = 'idle'
  pid = 0
  private child: ChildProcess | null = null
  private adopted = false
  private restartCount = 0
  private restartWindowStart = 0
  private exitHandler: ((code: number | null) => void) | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private consecutiveFailures = 0
  constructor(private readonly opts: SupervisorOpts) {}

  async start(): Promise<void> {
    this.state = 'starting'
    this.consecutiveFailures = 0
    mkdirSync(this.opts.stateDir, { recursive: true })

    // Try to adopt an existing process recorded in the state file.
    const adopted = this.tryAdopt()
    if (adopted) {
      this.pid = adopted
      this.adopted = true
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
    this.state = 'idle'
    this.stopHealthLoop()
    // remove crash handler so we don't loop-restart during shutdown
    if (this.child && this.exitHandler) { this.child.off('exit', this.exitHandler); this.exitHandler = null }

    const pid = this.pid
    if (!pid) { this.cleanupState(); return }

    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }

    // wait up to `grace` ms for the process to exit
    const deadline = Date.now() + grace
    while (Date.now() < deadline) {
      try { process.kill(pid, 0) } catch { this.cleanupState(); return }
      await new Promise((r) => setTimeout(r, 50))
    }

    // escalate
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    // final drain
    const drainDeadline = Date.now() + 500
    while (Date.now() < drainDeadline) {
      try { process.kill(pid, 0) } catch { this.cleanupState(); return }
      await new Promise((r) => setTimeout(r, 25))
    }
    this.cleanupState()
  }

  private spawnOnce(): void {
    this.child = spawn(this.opts.binaryPath, this.opts.args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...(this.opts.env ?? {}) },
    })
    this.child.unref()
    this.pid = this.child.pid ?? 0
    if (!this.pid) throw new Error(`failed to spawn ${this.opts.name}`)
    this.persist()
    this.exitHandler = () => {
      // Ignore if we're stopping or have given up.
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
    if (this.state === s) return
    this.state = s
    this.opts.onStateChange?.(this.opts.name, s)
  }

  private isProcessAlive(): boolean {
    if (!this.pid) return false
    try { process.kill(this.pid, 0); return true } catch { return false }
  }

  private startHealthLoop(): void {
    this.stopHealthLoop()
    const interval = this.opts.healthIntervalMs ?? 30_000
    const threshold = this.opts.healthFailureThreshold ?? 2
    this.healthTimer = setInterval(async () => {
      if (this.state === 'idle') return

      if (!this.isProcessAlive()) {
        if (this.state === 'ready' || this.state === 'starting') {
          this.onChildCrash()
        }
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

  private stateFile(): string { return join(this.opts.stateDir, `${this.opts.name}.state.json`) }

  private persist(): void {
    const s: SupervisorState = {
      pid: this.pid,
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
    this.adopted = false
  }

  private tryAdopt(): number | null {
    if (!existsSync(this.stateFile())) return null
    try {
      const s = JSON.parse(readFileSync(this.stateFile(), 'utf-8')) as SupervisorState
      if (!Number.isInteger(s.pid) || s.pid <= 0) return null
      // kill(pid, 0) throws if the process doesn't exist
      try { process.kill(s.pid, 0) } catch { return null }
      // Validate the binary name if an expected name was provided
      if (this.opts.expectedBinaryName) {
        const actual = getProcessName(s.pid)
        if (actual && !actual.includes(this.opts.expectedBinaryName)) return null
      }
      return s.pid
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
