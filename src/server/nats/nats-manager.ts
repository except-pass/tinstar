import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { connect } from 'nats'
import { Supervisor } from '../infra/supervisor.js'
import { installBinary } from '../infra/binaries.js'
import { resolveNatsTarget } from './manifest.js'
import { log } from '../logger.js'
import type { ServiceState } from '../infra/types.js'

const DEFAULT_PORT = 4222

export class NatsManager {
  state: ServiceState = 'idle'
  url: string

  private supervisor: Supervisor | null = null
  private readonly port: number
  private readonly configRoot: string
  private readonly external: boolean

  constructor(opts?: { configRoot?: string; port?: number }) {
    const externalUrl = process.env.NATS_URL
    this.external = !!externalUrl
    this.port = externalUrl
      ? 0
      : parseInt(process.env.NATS_PORT ?? String(opts?.port ?? DEFAULT_PORT), 10)
    this.url = externalUrl ?? `nats://127.0.0.1:${this.port}`
    this.configRoot = opts?.configRoot ?? join(homedir(), '.config', 'tinstar')
  }

  async start(): Promise<void> {
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

    try {
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
    if (!this.external) this.state = 'idle'
    log.info('nats', 'nats-server stopped')
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
