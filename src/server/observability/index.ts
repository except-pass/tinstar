import { join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { Supervisor } from './supervisor.js'
import { installBinary, type ProgressFn } from '../infra/binaries.js'
import { resolveBinaryTarget } from './manifest.js'
import { acquireLock, type ReleaseFn } from '../infra/lock.js'
import { renderAlloyRiver, renderPrometheusYml } from './config-render.js'
import { TelemetryQuery } from './query.js'
import type { DownloadProgress, ObservabilityState } from './types.js'
import { log } from '../logger.js'
import { getConfigRoot } from '../configRoot.js'

const PROM_PORT = 9090
const ALLOY_OTLP_PORT = 4318
const ALLOY_ADMIN_PORT = 12345

export * from './types.js'
export { TelemetryQuery } from './query.js'

export interface ObservabilityStackOpts {
  /** Root of persistent state. Default ~/.config/tinstar. */
  configRoot?: string
}

export class ObservabilityStack {
  state: ObservabilityState = 'idle'
  progress: DownloadProgress[] = []
  query: TelemetryQuery | null = null
  lastError: string | null = null

  private prom: Supervisor | null = null
  private alloy: Supervisor | null = null
  private lockRelease: ReleaseFn | null = null
  private readonly root: string
  private readonly binRoot: string
  private readonly obsRoot: string

  constructor(opts: ObservabilityStackOpts = {}) {
    this.root = opts.configRoot ?? getConfigRoot()
    this.binRoot = join(this.root, 'bin')
    this.obsRoot = join(this.root, 'observability')
  }

  async start(): Promise<void> {
    if (process.env.TINSTAR_TELEMETRY === '0') {
      this.state = 'disabled'
      log.info('observability', 'telemetry disabled via TINSTAR_TELEMETRY=0')
      return
    }
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      this.state = 'disabled'
      log.info('observability', `telemetry disabled: unsupported platform ${process.platform}`)
      return
    }

    if (process.env.TINSTAR_FAST_SIM === '1') {
      this.state = 'ready'
      this.query = null // fast-sim uses the fake path in telemetry.ts
      log.info('observability', 'fast-sim mode: synthesizing HUD snapshots, skipping real stack')
      return
    }

    // Clear any previous error before a fresh start attempt
    this.lastError = null
    log.info('observability', 'starting embedded telemetry stack', { binRoot: this.binRoot, obsRoot: this.obsRoot })

    mkdirSync(this.obsRoot, { recursive: true })
    try {
      this.lockRelease = await acquireLock(join(this.obsRoot, 'observability.lock'))
    } catch (err) {
      this.state = 'degraded'
      this.lastError = (err as Error).message
      log.error('observability', 'failed to acquire observability lock', { error: this.lastError })
      return
    }

    try {
      this.state = 'downloading'
      const onProgress: ProgressFn = (p) => {
        const idx = this.progress.findIndex((q) => q.component === p.component)
        if (idx >= 0) this.progress[idx] = p
        else this.progress.push(p)
      }
      const promTarget = resolveBinaryTarget('prometheus', process.platform, process.arch)
      const alloyTarget = resolveBinaryTarget('alloy', process.platform, process.arch)

      log.info('observability', `installing prometheus@${promTarget.version}`, { url: promTarget.url })
      const promInstall = await installBinary(promTarget, this.binRoot, onProgress)
      log.info('observability', 'prometheus installed', { binaryPath: promInstall.binaryPath })

      log.info('observability', `installing alloy@${alloyTarget.version}`, { url: alloyTarget.url })
      const alloyInstall = await installBinary(alloyTarget, this.binRoot, onProgress)
      log.info('observability', 'alloy installed', { binaryPath: alloyInstall.binaryPath })

      // Render configs
      const promCfgPath = join(this.obsRoot, 'prometheus.yml')
      const alloyCfgPath = join(this.obsRoot, 'alloy-config.alloy')
      writeFileSync(promCfgPath, renderPrometheusYml({ port: PROM_PORT }))
      writeFileSync(alloyCfgPath, renderAlloyRiver({
        otlpPort: ALLOY_OTLP_PORT,
        prometheusUrl: `http://127.0.0.1:${PROM_PORT}/api/v1/write`,
      }))

      this.state = 'starting'
      log.info('observability', 'starting supervisors', { promPort: PROM_PORT, alloyOtlpPort: ALLOY_OTLP_PORT, alloyAdminPort: ALLOY_ADMIN_PORT })

      const onSupervisorChange = (name: string, s: import('./types.js').ObservabilityState) => {
        this.onSupervisorStateChange(name, s)
      }

      this.prom = new Supervisor({
        name: 'prometheus',
        binaryPath: promInstall.binaryPath,
        args: [
          `--config.file=${promCfgPath}`,
          `--storage.tsdb.path=${join(this.obsRoot, 'prometheus-data')}`,
          `--storage.tsdb.retention.time=7d`,
          `--web.listen-address=127.0.0.1:${PROM_PORT}`,
          `--web.enable-remote-write-receiver`,
        ],
        stateDir: this.obsRoot,
        port: PROM_PORT,
        probe: async () => {
          try { const r = await fetch(`http://127.0.0.1:${PROM_PORT}/-/ready`); return r.ok } catch { return false }
        },
        expectedBinaryName: 'prometheus',
        onStateChange: onSupervisorChange,
      })
      this.alloy = new Supervisor({
        name: 'alloy',
        binaryPath: alloyInstall.binaryPath,
        // Pin the storage (WAL) path under obsRoot. Default is `<CWD>/data-alloy`,
        // which is CWD-dependent (breaks if the backend is launched elsewhere) and
        // NOT config-isolated — two backends sharing a launch dir would share one
        // WAL. obsRoot honors TINSTAR_CONFIG_HOME, so this keeps it per-instance.
        args: [
          'run', alloyCfgPath,
          `--server.http.listen-addr=127.0.0.1:${ALLOY_ADMIN_PORT}`,
          `--storage.path=${join(this.obsRoot, 'alloy-data')}`,
        ],
        stateDir: this.obsRoot,
        port: ALLOY_OTLP_PORT,
        probe: async () => {
          try { const r = await fetch(`http://127.0.0.1:${ALLOY_ADMIN_PORT}/-/ready`); return r.ok } catch { return false }
        },
        expectedBinaryName: 'alloy',
        onStateChange: onSupervisorChange,
      })

      await this.prom.start()
      await this.alloy.start()

      if (this.prom.state === 'ready' && this.alloy.state === 'ready') {
        this.query = new TelemetryQuery(`http://127.0.0.1:${PROM_PORT}`)
        this.state = 'ready'
        log.info('observability', 'telemetry stack ready', { promPid: this.prom.pid, alloyPid: this.alloy.pid })
      } else {
        this.state = 'degraded'
        this.lastError = `supervisor not ready: prom=${this.prom.state} alloy=${this.alloy.state}`
        log.error('observability', 'telemetry stack degraded after supervisor start', { promState: this.prom.state, alloyState: this.alloy.state })
      }
    } catch (err) {
      // Swallow-and-record: callers check state/lastError, no unhandled rejections
      this.state = 'degraded'
      this.lastError = (err as Error).message
      log.error('observability', 'telemetry stack failed to start', { error: this.lastError })
    }
  }

  private onSupervisorStateChange(name: string, s: ObservabilityState): void {
    if (s === 'degraded') {
      this.state = 'degraded'
      this.lastError = `${name} supervisor is unhealthy`
      this.query = null
      log.warn('observability', `${name} went degraded, stack is now degraded`)
    } else if (s === 'ready') {
      if (this.prom?.state === 'ready' && this.alloy?.state === 'ready') {
        this.state = 'ready'
        this.lastError = null
        this.query = new TelemetryQuery(`http://127.0.0.1:${PROM_PORT}`)
        log.info('observability', 'both supervisors healthy, stack is ready')
      }
    }
  }

  async stop(): Promise<void> {
    log.info('observability', 'stopping telemetry stack')
    try {
      try { await this.alloy?.stop() } catch (err) {
        log.warn('observability', 'alloy stop failed', { error: (err as Error).message })
      }
      try { await this.prom?.stop() } catch (err) {
        log.warn('observability', 'prometheus stop failed', { error: (err as Error).message })
      }
    } finally {
      if (this.lockRelease) {
        try { await this.lockRelease() } catch { /* best effort */ }
        this.lockRelease = null
      }
      this.state = 'idle'
      log.info('observability', 'telemetry stack stopped')
    }
  }

  async restart(): Promise<void> {
    log.info('observability', 'restarting telemetry stack')
    try { await this.stop() } catch (err) {
      log.warn('observability', 'stop during restart failed', { error: (err as Error).message })
    }
    this.progress = []
    await this.start()
  }
}
