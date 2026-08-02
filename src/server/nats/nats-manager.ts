import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { connect } from 'nats'
import { Supervisor } from '../infra/supervisor.js'
import { installBinary } from '../infra/binaries.js'
import { resolveNatsTarget } from './manifest.js'
import { log } from '../logger.js'
import { getConfigRoot } from '../configRoot.js'
import type { ServiceState } from '../infra/types.js'
import { DEFAULT_NATS_PORT, natsBrokerUrl } from './url.js'

export class NatsManager {
  state: ServiceState = 'idle'
  url: string

  private supervisor: Supervisor | null = null
  private supervisorStarted = false
  private readonly port: number
  private readonly configRoot: string
  private readonly external: boolean

  constructor(opts?: { configRoot?: string; port?: number }) {
    const externalUrl = process.env.NATS_URL
    this.external = !!externalUrl
    this.port = externalUrl
      ? 0
      : parseInt(process.env.NATS_PORT ?? String(opts?.port ?? DEFAULT_NATS_PORT), 10)
    this.url = natsBrokerUrl(process.env, opts?.port)
    this.configRoot = opts?.configRoot ?? getConfigRoot()
  }

  async start(): Promise<void> {
    try {
      if (this.supervisor && !this.supervisorStarted) {
        const staleSupervisor = this.supervisor
        this.supervisor = null
        this.supervisorStarted = false
        await staleSupervisor.stop()
      }
      if (this.external) {
        this.state = 'ready'
        log.info('nats', `using external NATS server at ${this.url}`)
        return
      }

      if (process.env.TINSTAR_FAST_SIM === '1') {
        this.state = 'ready'
        log.info('nats', 'fast-sim mode: skipping real NATS server')
        return
      }

      if (process.platform !== 'darwin' && process.platform !== 'linux') {
        this.state = 'disabled'
        log.info('nats', `disabled: unsupported platform ${process.platform}`)
        return
      }

      const binRoot = join(this.configRoot, 'bin')
      const stateDir = join(this.configRoot, 'nats')
      // JetStream needs its own dir for stream storage; keep it under the
      // existing nats state dir but separate from the supervisor's state files.
      // Always-on so channel-servers passing --jetstream just work; clients
      // that don't pass it use core pub/sub unchanged.
      const jetstreamDir = join(stateDir, 'jetstream')
      mkdirSync(stateDir, { recursive: true })
      mkdirSync(jetstreamDir, { recursive: true })

      this.state = 'downloading'
      const target = resolveNatsTarget(process.platform, process.arch)
      log.info('nats', `installing nats-server@${target.version}`)
      const install = await installBinary(target, binRoot)
      log.info('nats', 'nats-server installed', { binaryPath: install.binaryPath })

      this.state = 'starting'
      this.supervisor = new Supervisor({
        name: 'nats-server',
        binaryPath: install.binaryPath,
        args: ['-a', '127.0.0.1', '-p', String(this.port), '-js', '-sd', jetstreamDir],
        stateDir,
        port: this.port,
        probe: () => this.probe(),
        expectedBinaryName: 'nats-server',
        onStateChange: (_name, s) => { this.state = s },
      })

      await this.supervisor.start()
      this.supervisorStarted = true
      this.state = this.supervisor.state
      if (this.state === 'ready') {
        log.info('nats', `nats-server ready on ${this.url}`, { pid: this.supervisor.pid })
      } else {
        log.warn('nats', `nats-server degraded after start: ${this.state}`)
      }
    } catch (err) {
      this.state = 'degraded'
      log.error('nats', `failed to start nats-server: ${(err as Error).message}`)
    }
  }

  async stop(): Promise<void> {
    if (this.supervisor) {
      await this.supervisor.stop()
      this.supervisor = null
    }
    this.supervisorStarted = false
    if (!this.external) this.state = 'idle'
    log.info('nats', 'nats-server stopped')
  }

  /** A started degraded supervisor owns its health/restart loop and is reused. */
  hasSelfHealingSupervisor(): boolean {
    return this.supervisor !== null && this.supervisorStarted
  }

  private async probe(): Promise<boolean> {
    try {
      const nc = await connect({ servers: this.url })
      await nc.close()
      return true
    } catch {
      return false
    }
  }
}

interface ProcessNatsManagerOwner {
  manager: NatsManager
  startPromise: Promise<void> | null
}

export const PROCESS_NATS_MANAGER_KEY = Symbol.for('tinstar.nats-manager-owner.v1')

function processNatsManagerOwner(): ProcessNatsManagerOwner {
  const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
  let owner = processGlobal[PROCESS_NATS_MANAGER_KEY] as ProcessNatsManagerOwner | undefined
  if (!owner) {
    owner = {
      manager: new NatsManager(),
      startPromise: null,
    }
    processGlobal[PROCESS_NATS_MANAGER_KEY] = owner
  }
  // The owner survives module reloads; normalize instances created before the
  // start-promise field existed.
  owner.startPromise ??= null
  return owner
}

/**
 * Compatibility probe for a NatsManager instance created by an older HMR
 * module generation. Those instances predate hasSelfHealingSupervisor(), so
 * the only durable signal that Supervisor.start() reached its recovery loop is
 * the runtime healthTimer field. Keep the coupling named and covered by a real
 * Supervisor lifecycle test; changing Supervisor's runtime representation must
 * update this cross-generation probe deliberately.
 */
export function legacyNatsManagerHasRunningHealthLoop(manager: NatsManager): boolean {
  const legacySupervisor = (manager as unknown as {
    supervisor?: { healthTimer?: unknown } | null
  }).supervisor
  return legacySupervisor?.healthTimer != null
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH is the only definitive evidence that the process is gone. EPERM
    // and unknown failures must fail closed so we never start a second broker.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * A failed legacy stop is safe to abandon only when its runtime Supervisor
 * proves it no longer owns recovery state or a live process. Missing runtime
 * fields are treated as unknown, not inactive, so HMR cannot create two broker
 * owners merely to recover availability. A missing Supervisor is the one safe
 * exception: initialization can fail before one is installed, leaving no
 * recovery loop or broker process for that manager to own.
 */
function legacyNatsManagerResourcesAreInactive(manager: NatsManager): boolean {
  const legacySupervisor = (manager as unknown as {
    supervisor?: { healthTimer?: unknown; pid?: unknown } | null
  }).supervisor
  if (legacySupervisor == null) return true
  if (legacyNatsManagerHasRunningHealthLoop(manager)) return false
  if (typeof legacySupervisor.pid !== 'number') return false
  return legacySupervisor.pid <= 0 || !processIsAlive(legacySupervisor.pid)
}

/**
 * Start or reuse the one broker supervisor owned by this process.
 *
 * HMR backends share it deliberately: two independent Supervisors can adopt
 * the same persisted PID, after which retiring the older backend would kill
 * the broker beneath the newer one.
 */
export async function startProcessNatsManager(): Promise<NatsManager> {
  const owner = processNatsManagerOwner()
  const canInspectSupervisor = typeof owner.manager.hasSelfHealingSupervisor === 'function'
  const replaceLegacyManager = owner.manager.state === 'degraded'
    && !canInspectSupervisor
    && !legacyNatsManagerHasRunningHealthLoop(owner.manager)
  const retryableFailedInitialization = replaceLegacyManager
    || (owner.manager.state === 'degraded'
      && canInspectSupervisor
      && !owner.manager.hasSelfHealingSupervisor())
  if (
    owner.manager.state !== 'idle'
    && !retryableFailedInitialization
    && !owner.startPromise
  ) return owner.manager
  if (!owner.startPromise) {
    let settled!: Promise<void>
    settled = (async () => {
      if (replaceLegacyManager) {
        const legacyManager = owner.manager
        try {
          await legacyManager.stop()
        } catch (error) {
          log.error(
            'nats',
            `failed to retire legacy nats manager before retry: ${error instanceof Error ? error.message : String(error)}`,
          )
          if (!legacyNatsManagerResourcesAreInactive(legacyManager)) {
            throw new Error(
              'legacy nats manager retirement was not confirmed; refusing duplicate broker ownership',
              { cause: error },
            )
          }
        }
        if (owner.manager === legacyManager) owner.manager = new NatsManager()
      }
      await owner.manager.start()
    })().finally(() => {
      if (owner.startPromise === settled) owner.startPromise = null
    })
    owner.startPromise = settled
  }
  await owner.startPromise
  return owner.manager
}

/** Stop the shared broker only at process shutdown, never during HMR cleanup. */
export async function stopProcessNatsManager(): Promise<void> {
  const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
  const owner = processGlobal[PROCESS_NATS_MANAGER_KEY] as ProcessNatsManagerOwner | undefined
  if (!owner) return
  await owner.startPromise
  await owner.manager.stop()
  if (processGlobal[PROCESS_NATS_MANAGER_KEY] === owner) {
    delete processGlobal[PROCESS_NATS_MANAGER_KEY]
  }
}

/** Test-only reset for process-global ownership left by lifecycle tests. */
export async function resetProcessNatsManagerForTests(): Promise<void> {
  await stopProcessNatsManager()
}
