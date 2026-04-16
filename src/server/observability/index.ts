import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { Supervisor } from './supervisor.js'
import { installBinary, type ProgressFn } from './binaries.js'
import { resolveBinaryTarget } from './manifest.js'
import { acquireLock, type ReleaseFn } from './lock.js'
import { renderAlloyRiver, renderPrometheusYml } from './config-render.js'
import { TelemetryQuery } from './query.js'
import type { DownloadProgress, ObservabilityState } from './types.js'

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

  private prom: Supervisor | null = null
  private alloy: Supervisor | null = null
  private lockRelease: ReleaseFn | null = null
  private readonly root: string
  private readonly binRoot: string
  private readonly obsRoot: string

  constructor(opts: ObservabilityStackOpts = {}) {
    this.root = opts.configRoot ?? join(homedir(), '.config', 'tinstar')
    this.binRoot = join(this.root, 'bin')
    this.obsRoot = join(this.root, 'observability')
  }

  async start(): Promise<void> {
    if (process.env.TINSTAR_TELEMETRY === '0') { this.state = 'disabled'; return }
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      this.state = 'disabled'; return
    }

    mkdirSync(this.obsRoot, { recursive: true })
    this.lockRelease = await acquireLock(join(this.obsRoot, 'observability.lock'))

    try {
      this.state = 'downloading'
      const onProgress: ProgressFn = (p) => {
        const idx = this.progress.findIndex((q) => q.component === p.component)
        if (idx >= 0) this.progress[idx] = p
        else this.progress.push(p)
      }
      const promTarget = resolveBinaryTarget('prometheus', process.platform, process.arch)
      const alloyTarget = resolveBinaryTarget('alloy', process.platform, process.arch)
      const promInstall = await installBinary(promTarget, this.binRoot, onProgress)
      const alloyInstall = await installBinary(alloyTarget, this.binRoot, onProgress)

      // Render configs
      const promCfgPath = join(this.obsRoot, 'prometheus.yml')
      const alloyCfgPath = join(this.obsRoot, 'alloy-config.alloy')
      writeFileSync(promCfgPath, renderPrometheusYml({ port: 9090 }))
      writeFileSync(alloyCfgPath, renderAlloyRiver({
        otlpPort: 4318,
        prometheusUrl: 'http://127.0.0.1:9090/api/v1/write',
      }))

      this.state = 'starting'

      this.prom = new Supervisor({
        name: 'prometheus',
        binaryPath: promInstall.binaryPath,
        args: [
          `--config.file=${promCfgPath}`,
          `--storage.tsdb.path=${join(this.obsRoot, 'prometheus-data')}`,
          `--storage.tsdb.retention.time=7d`,
          `--web.listen-address=127.0.0.1:9090`,
          `--web.enable-remote-write-receiver`,
        ],
        stateDir: this.obsRoot,
        port: 9090,
        probe: async () => {
          try { const r = await fetch('http://127.0.0.1:9090/-/ready'); return r.ok } catch { return false }
        },
        expectedBinaryName: 'prometheus',
      })
      this.alloy = new Supervisor({
        name: 'alloy',
        binaryPath: alloyInstall.binaryPath,
        args: ['run', alloyCfgPath, '--server.http.listen-addr=127.0.0.1:12345'],
        stateDir: this.obsRoot,
        port: 4318,
        probe: async () => {
          try { const r = await fetch('http://127.0.0.1:12345/-/ready'); return r.ok } catch { return false }
        },
        expectedBinaryName: 'alloy',
      })

      await this.prom.start()
      await this.alloy.start()

      if (this.prom.state === 'ready' && this.alloy.state === 'ready') {
        this.query = new TelemetryQuery('http://127.0.0.1:9090')
        this.state = 'ready'
      } else {
        this.state = 'degraded'
      }
    } catch (err) {
      this.state = 'degraded'
      throw err
    }
  }

  async stop(): Promise<void> {
    await this.alloy?.stop()
    await this.prom?.stop()
    if (this.lockRelease) { await this.lockRelease(); this.lockRelease = null }
    this.state = 'idle'
  }

  async restart(): Promise<void> {
    await this.stop()
    this.progress = []
    await this.start()
  }
}
