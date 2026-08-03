import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  constants,
  copyFileSync,
  writeFileSync,
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
  onWarning?: (name: string, message: string) => void
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
  | { state: 'retire'; process: AdoptedProcess }
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
  private retiring = false
  private stopFailurePending = false
  private retirementFailurePending = false
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
      if (this.retirementFailurePending) {
        this.resetFailedRetirement()
      } else {
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
    if (adoption.state === 'retire') {
      this.pid = adoption.process.pid
      this.trackedProcessIdentity = adoption.process.processIdentity
      this.retiring = true
      try {
        await this.stop()
      } catch (error) {
        this.retirementFailurePending = true
        throw new Error(
          `${this.opts.name} recorded process ${adoption.process.pid} could not be retired; retry will revalidate it`,
          { cause: error },
        )
      } finally {
        this.retiring = false
      }
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
        if (stillOwnsPort === null) {
          this.opts.onWarning?.(
            this.opts.name,
            `listener ownership for process ${adoption.process.pid} could not be inspected; proceeding with executable, lifetime, and readiness evidence`,
          )
        }
        if (!serviceMatches || !lifetimeMatches || stillOwnsPort === false) {
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
      let quarantineError: unknown
      try {
        if (this.quarantineStateGeneration !== null) this.quarantineUnverifiedState()
      } catch (error) {
        quarantineError = error
      } finally {
        // Quarantine is recovery hygiene, not process ownership. A filesystem
        // failure must not leave shutdown timers or supervisor state wedged.
        this.finishStop(quarantineError !== undefined)
      }
      if (quarantineError !== undefined) throw quarantineError
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
    this.assertPortAvailable()
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

  /** Never signal an unverified listener merely because it owns our port. */
  private assertPortAvailable(): void {
    const listenerPids = this.readListeningProcessIds(this.opts.port)
    if (listenerPids === null) {
      throw new Error(
        `${this.opts.name} port ${this.opts.port} ownership could not be inspected; refusing to spawn without proving the port is free`,
      )
    }
    if (listenerPids && listenerPids.size > 0) {
      throw new Error(
        `${this.opts.name} port ${this.opts.port} is already owned by process ${[...listenerPids].join(', ')}; refusing to replace an unverified listener`,
      )
    }
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

  private finishStop(preserveQuarantine = false): void {
    this.stopHealthLoop()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (this.child && this.exitHandler) this.child.off('exit', this.exitHandler)
    this.exitHandler = null
    this.cleanupState(preserveQuarantine)
    this.stopping = false
    this.stopFailurePending = false
    this.retirementFailurePending = false
    this.setState(this.retiring ? 'starting' : 'idle')
  }

  private failStop(message: string): never {
    this.stopping = false
    this.stopFailurePending = true
    this.setState('degraded')
    throw new Error(message)
  }

  /** Forget a borrowed adoption candidate without deleting its durable record. */
  private resetFailedRetirement(): void {
    this.stopHealthLoop()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.pid = 0
    this.child = null
    this.trackedProcessIdentity = null
    this.stopping = false
    this.stopFailurePending = false
    this.retirementFailurePending = false
    this.ownsStateFile = false
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

  private cleanupState(preserveQuarantine = false): void {
    const f = this.stateFile()
    if (this.ownsStateFile && existsSync(f)) {
      try { unlinkSync(f) } catch { /* ignore */ }
    }
    this.ownsStateFile = false
    if (!preserveQuarantine) this.quarantineStateGeneration = null
    this.pid = 0
    this.child = null
    this.trackedProcessIdentity = null
  }

  private tryAdopt(): AdoptionResult {
    const stateFile = this.stateFile()
    const interruptedRecovery = this.restoreInterruptedQuarantine(stateFile)
    if (interruptedRecovery) {
      return {
        state: 'unverified',
        reason: `${this.opts.name} ${interruptedRecovery}; refusing to spawn a replacement`,
      }
    }
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
        if (s.port !== this.opts.port) {
          const recordedPortOwnership = this.processOwnsListeningPort(s.pid, s.port)
          if (recordedPortOwnership === true) {
            return {
              state: 'retire',
              process: {
                pid: s.pid,
                processIdentity: currentIdentity,
                needsServiceValidation: false,
              },
            }
          }
          if (recordedPortOwnership === false) return { state: 'spawn' }
          return {
            state: 'unverified',
            reason: `${this.opts.name} legacy process ${s.pid} uses recorded port ${s.port}, but listener ownership could not be inspected; refusing to adopt or replace it`,
          }
        }
        if (this.processOwnsListeningPort(s.pid, s.port) === false) {
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
      if (s.port !== this.opts.port) {
        const recordedPortOwnership = this.processOwnsListeningPort(s.pid, s.port)
        if (recordedPortOwnership === true) {
          return {
            state: 'retire',
            process: {
              pid: s.pid,
              processIdentity: currentIdentity,
              needsServiceValidation: false,
            },
          }
        }
        if (recordedPortOwnership === false) {
          const configuredPortOwnership = this.processOwnsListeningPort(s.pid, this.opts.port)
          if (configuredPortOwnership === true) {
            return {
              state: 'adopted',
              process: {
                pid: s.pid,
                processIdentity: currentIdentity,
                needsServiceValidation: false,
              },
            }
          }
          return {
            state: 'unverified',
            reason: configuredPortOwnership === false
              ? `${this.opts.name} process ${s.pid} owns neither recorded port ${s.port} nor configured port ${this.opts.port}; refusing to spawn while it is live`
              : `${this.opts.name} process ${s.pid} left recorded port ${s.port}, but configured-port ownership could not be inspected; refusing to spawn while it is live`,
          }
        }
        return {
          state: 'unverified',
          reason: `${this.opts.name} process ${s.pid} uses recorded port ${s.port}, but listener ownership could not be inspected; refusing to adopt or replace it`,
        }
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

  private processOwnsListeningPort(pid: number, port: number): boolean | null {
    const listenerPids = this.readListeningProcessIds(port)
    return listenerPids?.has(pid) ?? null
  }

  private readListeningProcessIds(port: number): Set<number> | null {
    return (this.opts.listeningProcessIds ?? getListeningProcessIds)(port)
  }

  private quarantineUnverifiedState(): void {
    const expectedGeneration = this.quarantineStateGeneration
    if (expectedGeneration === null) return
    const stateFile = this.stateFile()
    const token = `${Date.now()}-${randomUUID()}`
    let staging = `${stateFile}.quarantine-${token}`
    try {
      renameSync(stateFile, staging)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const matching = this.quarantineStagingFiles(stateFile).filter((candidate) => {
          try { return readFileSync(candidate, 'utf-8') === expectedGeneration } catch { return false }
        })
        if (matching.length === 0) {
          this.quarantineStateGeneration = null
          return
        }
        if (matching.length > 1) {
          throw new Error(`${this.opts.name} has multiple interrupted quarantine generations`)
        }
        staging = matching[0]!
      } else {
        throw error
      }
    }

    try {
      const displacedGeneration = readFileSync(staging, 'utf-8')
      if (displacedGeneration === expectedGeneration) {
        renameSync(staging, `${stateFile}.invalid-${token}`)
      } else {
        // The canonical path changed after validation. Restore that newer file
        // without overwriting a still-newer generation published concurrently.
        this.restoreDisplacedState(staging, stateFile, token)
      }
      this.quarantineStateGeneration = null
    } catch (error) {
      if (existsSync(staging)) {
        try {
          this.restoreDisplacedState(staging, stateFile, token)
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `${this.opts.name} state quarantine and restoration both failed`,
          )
        }
      }
      throw error
    }
  }

  private restoreDisplacedState(staging: string, stateFile: string, token: string): void {
    try {
      linkSync(staging, stateFile)
      unlinkSync(staging)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        renameSync(staging, `${stateFile}.displaced-${token}`)
        return
      }
    }

    // Some mounted filesystems do not support hard links. COPYFILE_EXCL keeps
    // the fallback non-clobbering even if another writer publishes meanwhile.
    try {
      copyFileSync(staging, stateFile, constants.COPYFILE_EXCL)
      unlinkSync(staging)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        renameSync(staging, `${stateFile}.displaced-${token}`)
        return
      }
      throw error
    }
  }

  private restoreInterruptedQuarantine(stateFile: string): string | null {
    const interrupted = this.quarantineStagingFiles(stateFile)
    if (interrupted.length === 0) return null
    try {
      const ranked = [...interrupted].sort((left, right) => {
        const timeDelta = statSync(left).mtimeMs - statSync(right).mtimeMs
        return timeDelta || left.localeCompare(right)
      })
      if (existsSync(stateFile)) {
        for (const candidate of ranked) {
          renameSync(candidate, `${stateFile}.displaced-recovered-${randomUUID()}`)
        }
        return null
      }
      const candidate = ranked.pop()!
      for (const older of ranked) {
        renameSync(older, `${stateFile}.displaced-recovered-${randomUUID()}`)
      }
      this.restoreDisplacedState(candidate, stateFile, `recovered-${randomUUID()}`)
      return null
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return `could not restore interrupted state quarantine in ${dirname(stateFile)}: ${detail}`
    }
  }

  private quarantineStagingFiles(stateFile: string): string[] {
    const prefix = `${basename(stateFile)}.quarantine-`
    try {
      return readdirSync(dirname(stateFile))
        .filter(name => name.startsWith(prefix))
        .sort()
        .map(name => join(dirname(stateFile), name))
    } catch {
      return []
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

interface ListenerInspectionFailure {
  code?: string | number
  status?: number | null
  stdout?: string | Buffer
  stderr?: string | Buffer
  killed?: boolean
  signal?: NodeJS.Signals | null
}

type ListenerInspectionExec = (
  file: string,
  args: string[],
  opts: { encoding: 'utf-8'; timeout: number },
) => string

function inspectionOutput(value: string | Buffer | undefined): string {
  return typeof value === 'string'
    ? value.trim()
    : value?.toString('utf-8').trim() ?? ''
}

function isCleanListenerMiss(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const failure = error as ListenerInspectionFailure
  return (
    (failure.status === 1 || failure.code === 1 || failure.code === '1')
    && inspectionOutput(failure.stdout) === ''
    && inspectionOutput(failure.stderr) === ''
    && failure.killed !== true
    && failure.signal == null
  )
}

export function getListeningProcessIds(
  port: number,
  run: ListenerInspectionExec = execFileSync as ListenerInspectionExec,
  platform: NodeJS.Platform = process.platform,
): Set<number> | null {
  if (platform !== 'linux' && platform !== 'darwin') return null
  let listenerObservedWithoutPid = false
  if (platform === 'linux') {
    try {
      const output = run(
        'ss',
        ['-H', '-ltnp', `sport = :${port}`],
        { encoding: 'utf-8', timeout: 2_000 },
      )
      const pids = new Set<number>()
      for (const match of output.matchAll(/pid=(\d+)/gu)) pids.add(Number(match[1]))
      if (pids.size > 0 || output.trim() === '') return pids
      // Restricted process visibility can show a listener without its owner.
      // Fall back to lsof before returning an inconclusive result.
      listenerObservedWithoutPid = true
    } catch { /* use the documented lsof dependency as a fallback */ }
  }
  try {
    const output = run(
      'lsof',
      ['-w', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'],
      { encoding: 'utf-8', timeout: 2_000 },
    )
    const pids = new Set<number>()
    for (const match of output.matchAll(/^p(\d+)$/gmu)) pids.add(Number(match[1]))
    if (pids.size > 0) return pids
    return output.trim() === '' && !listenerObservedWithoutPid ? pids : null
  } catch (error) {
    if (isCleanListenerMiss(error)) {
      return listenerObservedWithoutPid ? null : new Set()
    }
    return null
  }
}
