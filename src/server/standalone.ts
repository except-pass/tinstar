import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import httpProxy from 'http-proxy'
import { CockpitFleet, handleCockpitRequest } from './fleet/cockpit'
import { QuotaAxiPoller } from './quota/poller'
import { ProviderCurrentObservationStores } from './providers/observation-stores'
import { ProviderObservationIngestor } from './providers/observation-ingestor'
import { OtlpExporter } from './stores/otlp-exporter'
import { ObservabilityStack } from './observability/index'
import { CodexOtelReceiver } from './observability/codex-otel'
import { SSEBroadcaster } from './api/sse'
import { createTelemetryRoutes } from './api/telemetry'
import { handleCoreApi } from './api/coreRoutes'
import { seedOriginAllowlist, sessionUpgradeOrigins } from './api/originAllowlist'
import { handleScreenshotUpload } from './api/screenshotsRoute'
import { getConfigRoot } from './configRoot'
import { acquireBackendSingleton, describeSingletonFailure, formatSingletonFailureForConsole } from './infra/lock'
import { openListeners, resolveBindTargets } from './bind'
import { announceBindChangeOnce } from './bindNotice'
import { getReachCoordinator } from './reach'
import { decideStaticServe } from './staticServe'
import { log } from './logger'
import { createSessionRequestHandler, createSessionUpgradeHandler, handleSessionProxyError } from './sessionProxy'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ServerOptions {
  port: number
  clientDir: string
  open?: boolean
  host?: string | string[]
  force?: boolean
}

function streamFile(res: ServerResponse, filePath: string, mime: string) {
  createReadStream(filePath)
    .once('open', () => res.writeHead(200, { 'Content-Type': mime }))
    .once('error', () => {
      if (!res.headersSent) res.writeHead(404)
      res.end('Not found')
    })
    .pipe(res)
}

export function startServer(opts: ServerOptions) {
  opts.clientDir = resolve(opts.clientDir)
  process.on('uncaughtException', (err) => {
    log.error('server', 'uncaught exception (kept alive)', { error: err.message, stack: err.stack })
  })
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : null
    log.error('server', 'unhandled rejection (kept alive)', { reason: err?.message ?? String(reason), stack: err?.stack })
  })
  const configDir = getConfigRoot()
  const lockPath = join(configDir, 'server.lock')
  const lockResult = acquireBackendSingleton(lockPath, { force: opts.force })
  if (!lockResult.acquired) {
    const description = describeSingletonFailure(lockResult, configDir)
    log.error('server', description.logMessage)
    console.error(formatSingletonFailureForConsole(description))
    process.exit(1)
  }
  process.on('exit', () => { try { rmSync(`${lockPath}.mark`, { recursive: true, force: true }) } catch { /* gone */ } })

  const fleet = new CockpitFleet()
  fleet.start()
  process.on('exit', () => fleet.stop())
  const otlpExporter = new OtlpExporter()
  otlpExporter.start()
  const observations = new ProviderCurrentObservationStores()
  const quota = new QuotaAxiPoller({ onError: message => log.warn('quota', message) })
  quota.start()
  const codexOtel = new CodexOtelReceiver({
    ingestor: new ProviderObservationIngestor({ stores: observations, sink: otlpExporter }),
    metricSink: otlpExporter,
    statePath: join(configDir, 'observability', 'codex-otel-state.json'),
  })
  void codexOtel.start().catch(err => log.warn('codex-otel', `receiver unavailable: ${(err as Error).message}`))
  const observability = new ObservabilityStack()
  void observability.start()
  const sse = new SSEBroadcaster()
  const telemetry = createTelemetryRoutes({
    sse,
    get providerQuery() { return observability.query },
    getState: () => observability.state,
    getProgress: () => observability.progress,
    getLastError: () => observability.lastError,
    restart: () => observability.restart(),
    getDefaultUserEmail: () => process.env.TINSTAR_USER_EMAIL ?? '',
  })
  const shutdown = async () => {
    quota.stop()
    telemetry.stopPolling()
    try { await observability.stop() } catch (err) { log.debug('shutdown', `observability: ${(err as Error).message}`) }
    try { await codexOtel.stop() } catch (err) { log.debug('shutdown', `codexOtel: ${(err as Error).message}`) }
    try { await getReachCoordinator().shutdown() } catch (err) { log.debug('shutdown', `reach: ${(err as Error).message}`) }
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  const proxy = httpProxy.createProxyServer({ ws: true })
  proxy.on('error', (err, _req, res) => handleSessionProxyError(err, res, message => log.warn('proxy', message)))
  let boundPort = opts.port
  seedOriginAllowlist(boundPort)

  const getRun = (name: string) => {
    const port = fleet.portOf(name)
    return port ? { port } : null
  }
  const sessionRequestHandler = createSessionRequestHandler({
    getRun,
    proxyWeb: (req, res, options) => proxy.web(req, res, options),
    onNoTarget: (_name, res) => { res.writeHead(404); res.end('Terminal unavailable') },
  })
  const upgradeHandler = createSessionUpgradeHandler({
    getRun,
    allowedOrigins: () => sessionUpgradeOrigins(boundPort),
    proxyWs: (req, socket, head, options) => proxy.ws(req, socket, head, options),
    onRefused: detail => log.warn('proxy', `upgrade refused (${detail.reason})`, detail),
    onClientSocketError: detail => log.warn('proxy', `upgrade client socket error: ${detail.error}`, detail),
  })

  const coreApi = { quota, observations, sse, telemetry, boundPort: () => boundPort }

  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (sessionRequestHandler(req, res)) return
      if (await handleCockpitRequest(fleet, req, res)) return
      if (await handleScreenshotUpload(req, res, { configRoot: getConfigRoot() })) return
      if (await handleCoreApi(coreApi, req, res)) return
      if (req.url?.startsWith('/api/')) { res.writeHead(404); res.end('Not found'); return }
      const pathname = (req.url ?? '/').split('?')[0]!
      const decision = decideStaticServe(pathname, opts.clientDir, existsSync)
      if (decision.kind === 'forbidden') { res.writeHead(403); res.end('Forbidden'); return }
      if (decision.kind === 'file') {
        try {
          if (statSync(decision.filePath).isFile()) { streamFile(res, decision.filePath, decision.mime); return }
        } catch { /* not found */ }
      }
      if (decision.kind === 'spa') { streamFile(res, decision.indexPath, 'text/html'); return }
      res.writeHead(404); res.end('Not found')
    } catch (err) {
      log.error('api', `request error: ${(err as Error).message}`)
      if (!res.headersSent) res.writeHead(500)
      if (!res.writableEnded) res.end('Internal server error')
    }
  }

  const portFile = join(configDir, 'server.port')
  const hostFile = join(configDir, 'server.host')
  const pidFile = join(configDir, 'server.pid')
  process.on('exit', () => {
    for (const file of [portFile, hostFile, pidFile]) try { unlinkSync(file) } catch { /* gone */ }
  })
  const bind = resolveBindTargets(opts.host)
  const noticeMarker = join(configDir, 'bind-notice')
  announceBindChangeOnce({
    read: () => existsSync(noticeMarker) ? readFileSync(noticeMarker, 'utf8').trim() : null,
    write: value => writeFileSync(noticeMarker, value),
  }, message => { log.warn('server', message); console.log(`\n${message}\n`) },
  { existingInstall: existsSync(join(configDir, 'docstore.json')) })

  function makeServer() {
    const server = createServer(requestHandler)
    server.on('upgrade', upgradeHandler)
    return server
  }
  async function listenAll(port: number, retry = false): Promise<void> {
    try {
      const opened = await openListeners(bind.targets, port, makeServer,
        (target, err) => log.warn('server', `skipping best-effort bind on ${target.host}: ${err.code ?? err.message}`))
      const bound = opened.map(server => {
        server.on('error', err => log.warn('server', `listener error: ${err.message}`))
        const address = server.address()
        return typeof address === 'object' && address ? address.address : String(address)
      })
      boundPort = port
      seedOriginAllowlist(port)
      for (const [file, value] of [[portFile, String(port)], [hostFile, bind.hostFileValue], [pidFile, String(process.pid)]] as Array<[string, string]>) {
        try { writeFileSync(file, value) } catch { /* best effort */ }
      }
      const url = `http://${bind.preferredHost}:${port}`
      log.info('server', `Tinstar running at ${url} (bound to ${bound.join(', ')})`)
      console.log(`\n  Tinstar running at ${url} (bound to ${bound.join(', ')})\n`)
      void getReachCoordinator().onListening(port).catch(err => log.warn('reach', `reconcile failed: ${(err as Error).message}`))
      if (opts.open) {
        const { execFile } = await import('node:child_process')
        execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open', [url])
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'EADDRINUSE') {
        if (process.env.TINSTAR_NO_PORT_FALLBACK === '1') throw err
        if (!retry) setTimeout(() => { void listenAll(port, true) }, 500)
        else void listenAll(port + 1)
        return
      }
      throw err
    }
  }
  void listenAll(opts.port).catch(err => { log.error('server', 'fatal startup error', { error: String(err) }); process.exit(1) })
}

const isDirectRun = process.argv[1]?.includes('standalone')
if (isDirectRun) {
  const args = process.argv.slice(2)
  const portIdx = args.indexOf('--port')
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1]!) : parseInt(process.env.TINSTAR_BACKEND_PORT ?? '5273')
  const hosts: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && args[i + 1]) { hosts.push(...args[i + 1]!.split(',').map(s => s.trim()).filter(Boolean)); i++ }
  }
  if (!hosts.length && process.env.TINSTAR_HOST) hosts.push(...process.env.TINSTAR_HOST.split(',').map(s => s.trim()).filter(Boolean))
  startServer({ port, host: hosts, clientDir: join(__dirname, '../../dist/client'), open: !args.includes('--no-open'), force: args.includes('--force') })
}
