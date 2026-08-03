import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  writeFileSync,
  existsSync,
  linkSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ServiceState, SupervisorState } from './types.js'
import {
  compareProcessIdentity,
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
  /** Listener-owner reader; injectable for deterministic legacy migration tests. */
  listeningProcessIds?: (port: number) => Set<number> | null
}

type TrackedProcessState = 'same' | 'gone' | 'replaced' | 'unknown'

interface AdoptedProcess {
  pid: number
  processIdentity: string
  needsServiceValidation: boolean
}

type AdoptionResult =
  | { state: 'adopted'; process: AdoptedProcess }
  | { state: 'spawn' }
  | { state: 'unverified'; reason: string; quarantineGeneration?: string }

export class Supervisor {
  state: ServiceState = 'idle'
  pid = 0
  private child: ChildProcess | null = null
  private restartCount = 0
  private restartWindowStart = 0
  private exitHandler: ((code: number | null) => void) | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private consecutiveFailures = 0
  private stopping = false
  private stopFailurePending = false
  private trackedProcessIdentity: string | null = null
  private ownsStateFile = false
  private quarantineStateGeneration: string | null = null
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
    const adoption = this.tryAdopt()
    if (adoption.state === 'unverified') {
      this.quarantineStateGeneration = adoption.quarantineGeneration ?? null
      this.setState('degraded')
      throw new Error(adoption.reason)
    }
    if (adoption.state === 'adopted') {
      if (adoption.process.needsServiceValidation) {
        const serviceMatches = await this.waitForReady()
        const liveness = probeProcessLiveness(adoption.process.pid)
        const currentIdentity = this.readProcessIdentity(adoption.process.pid)
        const lifetimeMatches = liveness.state === 'alive'
          && currentIdentity !== null
          && compareProcessIdentity(adoption.process.processIdentity, currentIdentity) === 'same'
        const stillOwnsPort = this.processOwnsListeningPort(
          adoption.process.pid,
          this.opts.port,
        )
        if (!serviceMatches || !lifetimeMatches || !stillOwnsPort) {
          this.setState('degraded')
          throw new Error(
            `${this.opts.name} legacy process ${adoption.process.pid} could not be validated; refusing to adopt or replace it`,
          )
        }
      }
      this.pid = adoption.process.pid
      this.trackedProcessIdentity = adoption.process.processIdentity
      // Atomically refresh current records and upgrade a fully validated
      // released-format record with a boot-scoped process identity.
      this.persist()
      const ok = adoption.process.needsServiceValidation
        ? true
        : await this.waitForReady()
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
    if (!pid) {
      if (this.quarantineStateGeneration !== null) this.quarantineUnverifiedState()
      this.finishStop()
      return
    }
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
      if (!this.stopping) return
      const status = this.trackedProcessState(pid)
      if (status === 'gone' || status === 'replaced') { this.finishStop(); return }
      await new Promise((r) => setTimeout(r, 50))
    }

    // escalate
    if (!this.stopping) return
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
      if (!this.stopping) return
      const status = this.trackedProcessState(pid)
      if (status === 'gone' || status === 'replaced') { this.finishStop(); return }
      await new Promise((r) => setTimeout(r, 25))
    }
    if (!this.stopping) return
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
    if (this.restartTimer) return
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
    const failedPid = this.pid
    const failedIdentity = this.trackedProcessIdentity
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (
        this.stopping
        || this.stopFailurePending
        || this.state === 'idle'
        || this.pid !== failedPid
        || this.trackedProcessIdentity !== failedIdentity
      ) return
      try { this.spawnOnce() } catch { this.setState('degraded') }
    }, backoff)
    this.restartTimer.unref()
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
    const liveness = probeProcessLiveness(pid)
    if (liveness.state === 'gone' || liveness.state === 'invalid') return 'gone'
    const currentIdentity = this.readProcessIdentity(pid)
    if (!this.trackedProcessIdentity || !currentIdentity) return 'unknown'
    const comparison = compareProcessIdentity(this.trackedProcessIdentity, currentIdentity)
    if (comparison === 'different') return 'replaced'
    return comparison === 'same' ? 'same' : 'unknown'
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
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
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
    const target = this.stateFile()
    const pending = `${target}.pending-${randomUUID()}`
    try {
      writeFileSync(pending, JSON.stringify(s, null, 2))
      renameSync(pending, target)
      this.ownsStateFile = true
      this.quarantineStateGeneration = null
    } finally {
      try { unlinkSync(pending) } catch { /* published or already absent */ }
    }
  }

  private cleanupState(): void {
    const f = this.stateFile()
    if (this.ownsStateFile && existsSync(f)) {
      try { unlinkSync(f) } catch { /* ignore */ }
    }
    this.ownsStateFile = false
    this.quarantineStateGeneration = null
    this.pid = 0
    this.child = null
    this.trackedProcessIdentity = null
  }

  private tryAdopt(): AdoptionResult {
    const stateFile = this.stateFile()
    if (!existsSync(stateFile)) return { state: 'spawn' }
    let rawState: string | null = null
    try {
      rawState = readFileSync(stateFile, 'utf-8')
      const s = JSON.parse(rawState) as SupervisorState
      if (!isSupportedProcessId(s.pid)) {
        return {
          state: 'unverified',
          reason: `${this.opts.name} state ${stateFile} has an unsupported process id; restart to quarantine it before replacement`,
          quarantineGeneration: rawState,
        }
      }
      const liveness = probeProcessLiveness(s.pid)
      if (liveness.state === 'gone' || liveness.state === 'invalid') return { state: 'spawn' }
      const currentIdentity = this.readProcessIdentity(s.pid)
      if (!currentIdentity) {
        return {
          state: 'unverified',
          reason: `${this.opts.name} state ${stateFile} names live process ${s.pid}, but its identity is unavailable; refusing to spawn a replacement`,
        }
      }
      if (!s.processIdentity) {
        if (typeof s.binaryPath !== 'string' || !this.opts.expectedBinaryName) {
          return {
            state: 'unverified',
            reason: `${this.opts.name} legacy state ${stateFile} lacks enough service identity; refusing to adopt or replace it`,
          }
        }
        if (s.port !== this.opts.port) return { state: 'spawn' }
        const actual = getProcessName(s.pid)
        if (!actual) {
          return {
            state: 'unverified',
            reason: `${this.opts.name} state ${stateFile} names process ${s.pid}, but its binary is unavailable; refusing to spawn a replacement`,
          }
        }
        if (!actual.includes(this.opts.expectedBinaryName)) return { state: 'spawn' }
        if (!sameExecutable(actual, s.binaryPath)) {
          return {
            state: 'unverified',
            reason: `${this.opts.name} legacy process ${s.pid} executable does not match state ${stateFile}; refusing to adopt or replace it`,
          }
        }
        if (!this.processOwnsListeningPort(s.pid, s.port)) {
          return {
            state: 'unverified',
            reason: `${this.opts.name} legacy process ${s.pid} does not own the recorded service port in ${stateFile}; refusing to adopt or replace it`,
          }
        }
        return {
          state: 'adopted',
          process: {
            pid: s.pid,
            processIdentity: currentIdentity,
            needsServiceValidation: true,
          },
        }
      }
      const identityComparison = compareProcessIdentity(s.processIdentity, currentIdentity)
      if (identityComparison === 'different') {
        return { state: 'spawn' }
      }
      // A legacy Linux token has no boot identity. PID, start ticks, and binary
      // name can all repeat after reboot, so they cannot prove process lifetime.
      if (identityComparison === 'legacy-unscoped') {
        return {
          state: 'unverified',
          reason: `${this.opts.name} state ${stateFile} records process ${s.pid} without a boot-scoped lifetime identity; refusing to adopt or replace it`,
        }
      }
      // Validate the binary name if an expected name was provided
      if (this.opts.expectedBinaryName) {
        const actual = getProcessName(s.pid)
        if (!actual) {
          return {
            state: 'unverified',
            reason: `${this.opts.name} state ${stateFile} names process ${s.pid}, but its binary is unavailable; refusing to spawn a replacement`,
          }
        }
        if (!actual.includes(this.opts.expectedBinaryName)) return { state: 'spawn' }
      }
      return {
        state: 'adopted',
        process: {
          pid: s.pid,
          processIdentity: currentIdentity,
          needsServiceValidation: false,
        },
      }
    } catch {
      return {
        state: 'unverified',
        reason: `${this.opts.name} state ${stateFile} is unreadable; restart to quarantine it before replacement`,
        ...(rawState !== null ? { quarantineGeneration: rawState } : {}),
      }
    }
  }

  private processOwnsListeningPort(pid: number, port: number): boolean {
    const listenerPids = (this.opts.listeningProcessIds ?? getListeningProcessIds)(port)
    return listenerPids?.has(pid) ?? false
  }

  private quarantineUnverifiedState(): void {
    const expectedGeneration = this.quarantineStateGeneration
    if (expectedGeneration === null) return
    const stateFile = this.stateFile()
    const token = `${Date.now()}-${randomUUID()}`
    const staging = `${stateFile}.quarantine-${token}`
    try {
      renameSync(stateFile, staging)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.quarantineStateGeneration = null
        return
      }
      throw error
    }

    let displacedGeneration: string | null = null
    try { displacedGeneration = readFileSync(staging, 'utf-8') } catch { /* restore below */ }
    if (displacedGeneration === expectedGeneration) {
      renameSync(staging, `${stateFile}.invalid-${token}`)
      this.quarantineStateGeneration = null
      return
    }

    // The canonical path changed after validation. Restore that newer file
    // without overwriting any still-newer generation published concurrently.
    try {
      linkSync(staging, stateFile)
      unlinkSync(staging)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      renameSync(staging, `${stateFile}.displaced-${token}`)
    }
    this.quarantineStateGeneration = null
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

function sameExecutable(actual: string, recorded: string): boolean {
  const normalizedActual = actual.endsWith(' (deleted)')
    ? actual.slice(0, -' (deleted)'.length)
    : actual
  try {
    return realpathSync(normalizedActual) === realpathSync(recorded)
  } catch {
    return normalizedActual === recorded
  }
}

function getListeningProcessIds(port: number): Set<number> | null {
  try {
    const output = process.platform === 'linux'
      ? execFileSync('ss', ['-H', '-ltnp', `sport = :${port}`], { encoding: 'utf-8' })
      : process.platform === 'darwin'
        ? execFileSync(
            'lsof',
            ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'],
            { encoding: 'utf-8' },
          )
        : null
    if (output === null) return null
    const pids = new Set<number>()
    const pattern = process.platform === 'linux' ? /pid=(\d+)/gu : /^p(\d+)$/gmu
    for (const match of output.matchAll(pattern)) pids.add(Number(match[1]))
    return pids
  } catch {
    return null
  }
}
