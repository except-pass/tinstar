import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ObservabilityState, SupervisorState } from './types.js'

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
}

export class Supervisor {
  state: ObservabilityState = 'idle'
  pid = 0
  private child: ChildProcess | null = null
  private adopted = false
  private restartCount = 0
  private restartWindowStart = 0
  private exitHandler: ((code: number | null) => void) | null = null
  constructor(private readonly opts: SupervisorOpts) {}

  async start(): Promise<void> {
    this.state = 'starting'
    mkdirSync(this.opts.stateDir, { recursive: true })

    // Try to adopt an existing process recorded in the state file.
    const adopted = this.tryAdopt()
    if (adopted) {
      this.pid = adopted
      this.adopted = true
      const ok = await this.waitForReady()
      this.state = ok ? 'ready' : 'degraded'
      return
    }

    this.spawnOnce()

    const ok = await this.waitForReady()
    this.state = ok ? 'ready' : 'degraded'
  }

  async stop(): Promise<void> {
    if (!this.child || this.adopted) {
      // adopted children are not directly killed by this instance
      if (this.pid) {
        try { process.kill(this.pid, 'SIGTERM') } catch { /* gone */ }
      }
      this.cleanupState()
      this.state = 'idle'
      return
    }
    try { this.child.kill('SIGTERM') } catch { /* gone */ }
    // grace window
    await new Promise((r) => setTimeout(r, 100))
    if (this.child.exitCode === null) {
      try { this.child.kill('SIGKILL') } catch { /* gone */ }
    }
    this.cleanupState()
    this.state = 'idle'
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
    this.exitHandler = (_code) => {
      // ignore if we're stopping
      if (this.state === 'idle') return
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
      this.state = 'degraded'
      return
    }
    setTimeout(() => {
      try { this.spawnOnce() } catch { this.state = 'degraded' }
    }, backoff)
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
