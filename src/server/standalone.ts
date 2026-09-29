import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import httpProxy from 'http-proxy'
import { CockpitFleet, handleCockpitRequest } from './fleet/cockpit'
import { CcQuotaService } from './cc-quota/service'
import { ProviderCurrentObservationStores } from './providers/observation-stores'
import { readBody } from './api/readBody'
import { ok, fail } from './api/envelope'
import { currentOriginAllowlist, seedOriginAllowlist, sessionUpgradeOrigins } from './api/originAllowlist'
import { resolveCorsHeaders } from './api/cors'
import { getConfigRoot } from './configRoot'
import { acquireBackendSingleton, describeSingletonFailure, formatSingletonFailureForConsole } from './infra/lock'
import { openListeners, resolveBindTargets } from './bind'
import { announceBindChangeOnce } from './bindNotice'
import { getReachCoordinator } from './reach'
import { decideStaticServe } from './staticServe'
import { log } from './logger'
import { createSessionRequestHandler, createSessionUpgradeHandler, handleSessionProxyError, isUpgradeOriginAllowed } from './sessionProxy'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ServerOptions {
  port: number
  clientDir: string
  open?: boolean
  host?: string | string[]
  force?: boolean
}

function rawJson(res: ServerResponse, value: unknown, headers: Record<string, string>) {
  res.writeHead(200, { ...headers, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

export function startServer(opts: ServerOptions) {
  opts.clientDir = resolve(opts.clientDir)
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
  const observations = new ProviderCurrentObservationStores()
  const quota = new CcQuotaService({ observationStores: observations })
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

  async function handleCoreApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url?.split('?')[0] ?? '/'
    const method = req.method ?? 'GET'
    const headers = resolveCorsHeaders({ origin: req.headers.origin, allowlist: currentOriginAllowlist() }) as Record<string, string>
    if (method === 'OPTIONS' && url.startsWith('/api/')) { res.writeHead(204, headers); res.end(); return true }
    if (method === 'GET' && url === '/api/cc-quota') { rawJson(res, quota.getSnapshot(), headers); return true }
    if (method === 'POST' && url === '/api/cc-quota/ingest') {
      let payload: unknown
      try { payload = JSON.parse(await readBody(req)) } catch { return fail(res, 'BAD_REQUEST', 'malformed_json', { headers }) }
      rawJson(res, quota.ingest(payload), headers)
      return true
    }
    if (method === 'GET' && url === '/api/provider-observations') {
      rawJson(res, observations.toWire(), headers); return true
    }
    if (method === 'GET' && url === '/api/provider-observation-view') {
      rawJson(res, { version: 1, observations: observations.toWire(), managedSessions: [] }, headers)
      return true
    }
    if (method === 'GET' && url === '/api/reach') { return ok(res, await getReachCoordinator().status(), { headers }) }
    if (method === 'POST' && url === '/api/reach') {
      const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (contentType !== 'application/json') return fail(res, 'BAD_REQUEST', 'Content-Type must be application/json', { status: 415, headers })
      const origin = req.headers.origin
      if (!isUpgradeOriginAllowed(origin, currentOriginAllowlist())) return fail(res, 'FORBIDDEN', `origin ${origin ?? '(none)'} may not change reach`, { headers })
      let body: { enabled?: unknown } | null = null
      try { body = JSON.parse(await readBody(req)) as { enabled?: unknown } } catch { /* invalid */ }
      if (typeof body?.enabled !== 'boolean') return fail(res, 'BAD_REQUEST', 'body must be {"enabled": true|false}', { headers })
      const coordinator = getReachCoordinator()
      const status = body.enabled ? await coordinator.enable(boundPort) : await coordinator.disable()
      if (status.state === 'refused') return fail(res, 'BAD_REQUEST', status.detail ?? 'reach refused', { headers })
      return ok(res, status, { headers })
    }
    if (method === 'GET' && url === '/api/events') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write('event: snapshot\ndata: {}\n\n')
      const heartbeat = setInterval(() => res.write('event: heartbeat\ndata: {}\n\n'), 15_000)
      res.on('close', () => clearInterval(heartbeat))
      return true
    }
    return false
  }

  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (sessionRequestHandler(req, res)) return
      if (await handleCockpitRequest(fleet, req, res)) return
      if (await handleCoreApi(req, res)) return
      if (req.url?.startsWith('/api/')) { res.writeHead(404); res.end('Not found'); return }
      const pathname = (req.url ?? '/').split('?')[0]!
      const decision = decideStaticServe(pathname, opts.clientDir, existsSync)
      if (decision.kind === 'forbidden') { res.writeHead(403); res.end('Forbidden'); return }
      if (decision.kind === 'file') {
        try {
          if (statSync(decision.filePath).isFile()) {
            res.writeHead(200, { 'Content-Type': decision.mime })
            createReadStream(decision.filePath).pipe(res)
            return
          }
        } catch { /* not found */ }
      }
      if (decision.kind === 'spa') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        createReadStream(decision.indexPath).pipe(res)
        return
      }
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
