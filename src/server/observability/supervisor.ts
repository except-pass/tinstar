import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
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
}

export class Supervisor {
  state: ObservabilityState = 'idle'
  pid = 0
  private child: ChildProcess | null = null
  private adopted = false
  constructor(private readonly opts: SupervisorOpts) {}

  async start(): Promise<void> {
    this.state = 'starting'
    mkdirSync(this.opts.stateDir, { recursive: true })

    this.child = spawn(this.opts.binaryPath, this.opts.args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...(this.opts.env ?? {}) },
    })
    this.child.unref()
    this.pid = this.child.pid ?? 0
    if (!this.pid) throw new Error(`failed to spawn ${this.opts.name}`)
    this.persist()

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
}
