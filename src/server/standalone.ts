import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream, existsSync, statSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import httpProxy from 'http-proxy'

// Parse --cors-origins as early as possible so that downstream module imports
// (which capture process.env.TINSTAR_CORS_ORIGINS at load time) see the value.
{
  const args = process.argv.slice(2)
  const corsIdx = args.indexOf('--cors-origins')
  if (corsIdx !== -1 && args[corsIdx + 1]) {
    process.env.TINSTAR_CORS_ORIGINS = args[corsIdx + 1]
  }
}

import { initBackend } from './index'
import { handleRequest } from './api/routes'
import { handlePluginRuntime } from './api/pluginRuntime'
import { handlePluginsConfig } from './api/pluginsConfigRoute'
import { handleFileUpload } from './api/fileUploadRoute'
import { handleFileDownload } from './api/fileDownloadRoute'
import { handleFilePush } from './api/filePushRoute'
import { handleScreenshotUpload } from './api/screenshotsRoute'
import { log } from './logger'
import { getConfigRoot } from './configRoot'
import {
  acquireBackendSingleton,
  describeSingletonFailure,
  formatSingletonFailureForConsole,
} from './infra/lock'
import { openListeners, resolveBindTargets } from './bind'
import { decideStaticServe } from './staticServe'
import {
  createSessionRequestHandler,
  createSessionUpgradeHandler,
  handleSessionProxyError,
  loopbackOriginsForPort,
} from './sessionProxy'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ServerOptions {
  port: number
  clientDir: string
  open?: boolean
  /**
   * Optional bind address(es). When omitted/empty the server binds the
   * loopback pair only — reaching it from another device is an explicit act,
   * not the state you get by doing nothing. Pass an array (e.g. `['127.0.0.1',
   * '<tailscale-ip>']`) to bind multiple specific interfaces; 127.0.0.1 is
   * force-added to any explicit set so host-local hooks keep working. For
   * backwards-compat a single string is still accepted.
   */
  host?: string | string[]
  /**
   * Take over the config dir from a live backend instead of refusing. Without
   * this, a second backend on the same config dir exits rather than start a
   * port/ttyd war. Wired from the `--force` CLI flag.
   */
  force?: boolean
}

export function startServer(opts: ServerOptions) {
  opts.clientDir = resolve(opts.clientDir)

  // Last-resort safety net. The orchestrator runs many subsystems (fs watchers,
  // child processes, NATS, SSE) and a single stray error — e.g. an FSWatcher
  // emitting 'error' on ENOSPC as new dirs appear during a session spawn — must
  // not be allowed to take the whole server down. Log the cause and keep
  // running; systemd-style hard restarts on these are worse than degrading.
  process.on('uncaughtException', (err) => {
    log.error('server', 'uncaught exception (kept alive)', { error: err.message, stack: err.stack })
  })
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : null
    log.error('server', 'unhandled rejection (kept alive)', { reason: err?.message ?? String(reason), stack: err?.stack })
  })

  // Enforce one backend per config dir BEFORE starting anything. Two backends
  // sharing a config dir collide on ttyd ports (separate in-memory port sets)
  // → restart-wars and proxy mis-binding (a run shows another run's terminal).
  // Refuse by default; `--force` SIGTERMs the live owner and takes over. A
  // deliberate second instance uses TINSTAR_CONFIG_HOME (a different dir).
  const configDir = getConfigRoot()
  const pidFile = join(configDir, 'server.pid')
  const lockPath = join(configDir, 'server.lock')
  const lockResult = acquireBackendSingleton(lockPath, { force: opts.force })
  if (!lockResult.acquired) {
    const description = describeSingletonFailure(lockResult, configDir)
    log.error('server', description.logMessage)
    console.error(formatSingletonFailureForConsole(description))
    process.exit(1)
  }
  // The lock marker outlives only this process; drop it on exit so the next
  // start sees a clean (or stale-but-stealable) lock.
  process.on('exit', () => { try { rmSync(`${lockPath}.mark`, { recursive: true, force: true }) } catch { /* gone */ } })

  const ctx = initBackend()
  const proxy = httpProxy.createProxyServer({ ws: true })

  function safeWriteHead(res: import('node:http').ServerResponse, status: number, headers: Record<string, string>) {
    if (res.headersSent || res.writableEnded) return false
    res.writeHead(status, headers)
    return true
  }

  proxy.on('error', (err, _req, res) => {
    handleSessionProxyError(err, res, message => log.warn('proxy', message))
  })

  // The port the server actually bound (listenAll may bump it), read fresh on
  // every upgrade so the allowed-origin list matches the live URL.
  let boundPort = opts.port

  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'

    // 1. Session proxy — runs BEFORE static files
    if (sessionRequestHandler(req, res)) return

    // 2. API requests
    try {
      if (await handlePluginRuntime(req, res, { configRoot: configDir })) return
      if (await handlePluginsConfig(req, res, { configRoot: configDir })) return
      if (await handleFileUpload(req, res, { sessDir: ctx.sessionConfig?.dirs.sessions ?? '', configRoot: configDir })) return
      if (await handleFileDownload(req, res, { sessDir: ctx.sessionConfig?.dirs.sessions ?? '' })) return
      if (await handleFilePush(req, res, { sessDir: ctx.sessionConfig?.dirs.sessions ?? '', sse: ctx.sse })) return
      if (await handleScreenshotUpload(req, res, { configRoot: configDir })) return
      const handled = await handleRequest(ctx, req, res)
      if (handled) return
    } catch (err) {
      log.error('api', `request error: ${(err as Error).message}`)
      if (safeWriteHead(res, 500, { 'Content-Type': 'text/plain' })) res.end('Internal server error')
      return
    }

    // 3. Static file serving with SPA fallback. A request that looks like a file
    //    (has an extension) and doesn't exist 404s — it must NOT fall back to
    //    index.html, or a missing/stale hashed chunk would be served as text/html
    //    and break dynamic import() (the mermaid "Rendering diagram…" hang).
    const pathname = url.split('?')[0]!
    const decision = decideStaticServe(pathname, opts.clientDir, existsSync)

    if (decision.kind === 'forbidden') {
      if (safeWriteHead(res, 403, { 'Content-Type': 'text/plain' })) res.end('Forbidden')
      return
    }

    if (decision.kind === 'file') {
      try {
        if (statSync(decision.filePath).isFile()) {
          if (safeWriteHead(res, 200, { 'Content-Type': decision.mime })) {
            createReadStream(decision.filePath).pipe(res)
          }
          return
        }
      } catch {
        // fall through to 404 (path is a directory, or vanished mid-request)
      }
      if (safeWriteHead(res, 404, { 'Content-Type': 'text/plain' })) res.end('Not found')
      return
    }

    if (decision.kind === 'spa') {
      if (safeWriteHead(res, 200, { 'Content-Type': 'text/html' })) {
        createReadStream(decision.indexPath).pipe(res)
      }
      return
    }

    // decision.kind === 'not-found'
    if (safeWriteHead(res, 404, { 'Content-Type': 'text/plain' })) res.end('Not found')
  }

  const sessionRequestHandler = createSessionRequestHandler({
    getRun: name => ctx.docStore.getRun(name),
    proxyWeb: (req, res, options) => proxy.web(req, res, options),
    onNoTarget: (sessionName, res) => {
      if (safeWriteHead(res, 404, { 'Content-Type': 'text/plain' })) {
        res.end(`Session "${sessionName}" not found or has no port`)
      }
    },
  })

  const upgradeHandler = createSessionUpgradeHandler({
    getRun: name => ctx.docStore.getRun(name),
    allowedOrigins: () => loopbackOriginsForPort(boundPort),
    proxyWs: (req, socket, head, options) => proxy.ws(req, socket, head, options),
    onRefused: detail => log.warn('proxy', `upgrade refused (${detail.reason})`, detail),
    onClientSocketError: detail => log.warn('proxy', `upgrade client socket error: ${detail.error}`, detail),
  })

  function makeServer(): Server {
    const s = createServer(requestHandler)
    s.on('upgrade', upgradeHandler)
    return s
  }

  const portFile = join(configDir, 'server.port')
  const hostFile = join(configDir, 'server.host')

  function writePortFile(port: number) {
    try { writeFileSync(portFile, String(port)) } catch { /* best effort */ }
  }

  function removePortFile() {
    try { unlinkSync(portFile) } catch { /* already gone */ }
  }

  function writeHostFile(h: string) {
    try { writeFileSync(hostFile, h) } catch { /* best effort */ }
  }

  function removeHostFile() {
    try { unlinkSync(hostFile) } catch { /* already gone */ }
  }

  function writePidFile() {
    try { writeFileSync(pidFile, String(process.pid)) } catch { /* best effort */ }
  }

  function removePidFile() {
    try { unlinkSync(pidFile) } catch { /* already gone */ }
  }

  process.on('exit', () => { removePortFile(); removeHostFile(); removePidFile() })

  // One listener per address, all on the same port. No explicit host no longer
  // means the unspecified address — see resolveBindTargets for why that default
  // was the whole exposure.
  const bind = resolveBindTargets(opts.host)

  async function listenAll(port: number, isRetry = false): Promise<void> {
    try {
      const bound: string[] = []
      const opened = await openListeners(
        bind.targets,
        port,
        makeServer,
        (target, err) => log.warn(
          'server',
          `skipping best-effort bind on ${target.host}: ${err.code ?? err.message}`,
        ),
      )
      for (const s of opened) {
        s.on('error', (err) => log.warn('server', `listener error: ${err.message}`))
        const addr = s.address()
        bound.push(typeof addr === 'object' && addr ? addr.address : String(addr))
      }
      onAllListening(port, bound)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e?.code === 'EADDRINUSE') {
        if (process.env.TINSTAR_NO_PORT_FALLBACK === '1') {
          process.stderr.write(`[standalone] Port ${port} in use and TINSTAR_NO_PORT_FALLBACK=1 — exiting\n`)
          process.exit(1)
        }
        if (!isRetry) {
          // The singleton lock already ensured no live tinstar backend owns
          // this config dir, so this is usually a lingering OS socket from the
          // instance we just replaced. Wait briefly and retry the same port.
          setTimeout(() => { void listenAll(port, true) }, 500)
        } else {
          log.warn('server', `port ${port} in use, trying ${port + 1}`)
          console.log(`  Port ${port} in use, trying ${port + 1}...`)
          void listenAll(port + 1)
        }
        return
      }
      throw err
    }
  }

  function onAllListening(port: number, bound: string[]) {
    boundPort = port
    const url = `http://${bind.preferredHost}:${port}`
    writePortFile(port)
    writeHostFile(bind.hostFileValue)
    writePidFile()
    // Report what actually bound, not what was asked for: the IPv6 loopback is
    // best-effort, and a note that names an address nobody can reach is worse
    // than no note.
    const bindNote = ` (bound to ${bound.join(', ')})`
    log.info('server', `Tinstar running at ${url}${bindNote}`)
    console.log(`\n  Tinstar running at ${url}${bindNote}\n`)
    if (opts.open) {
      import('node:child_process').then(({ execFile }) => {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        execFile(cmd, [url])
      })
    }
  }

  // Startup must fail fast: listenAll() handles EADDRINUSE internally (retry /
  // port-bump / explicit exit), but any other bind error rethrows. Without this
  // catch that rejection would be swallowed by the process-wide handler above,
  // leaving a live process with no HTTP listener. The keep-alive net is for
  // *runtime* stray errors, not a failed boot.
  listenAll(opts.port).catch((err) => {
    const e = err as NodeJS.ErrnoException
    log.error('server', 'fatal startup error — exiting', { error: e?.message, code: e?.code, stack: e?.stack })
    process.exit(1)
  })
}

// Auto-start when run directly (not when imported by CLI)
const isDirectRun = process.argv[1]?.includes('standalone')
if (isDirectRun) {
  const args = process.argv.slice(2)
  const portIdx = args.indexOf('--port')
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1]!) : parseInt(process.env.TINSTAR_BACKEND_PORT ?? '5273')
  // Support repeated --host flags and/or a comma-separated list. Like
  // bin/tinstar.js, this carries no default of its own — an empty list means
  // "whatever resolveBindTargets decides", so the two entry points cannot
  // disagree about what no `--host` means.
  const hosts: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && args[i + 1]) {
      hosts.push(...args[i + 1]!.split(',').map(s => s.trim()).filter(Boolean))
      i++
    }
  }
  if (hosts.length === 0 && process.env.TINSTAR_HOST) {
    hosts.push(...process.env.TINSTAR_HOST.split(',').map(s => s.trim()).filter(Boolean))
  }
  const noOpen = args.includes('--no-open')
  startServer({ port, host: hosts, clientDir: join(__dirname, '../../dist/client'), open: !noOpen, force: args.includes('--force') })
}
