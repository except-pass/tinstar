import { createServer } from 'node:http'
import { join, extname, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream, existsSync, statSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
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
import { log } from './logger'
import { getConfigRoot } from './configRoot'

const __dirname = dirname(fileURLToPath(import.meta.url))

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

interface ServerOptions {
  port: number
  clientDir: string
  open?: boolean
  /**
   * Optional bind address. When omitted, Node binds to the unspecified address
   * (all interfaces). Set to e.g. the tailscale IPv4 to restrict reachability
   * to the tailnet without firewall rules.
   */
  host?: string
}

function killStalePidSync(pidFilePath: string): void {
  try {
    const raw = readFileSync(pidFilePath, 'utf8').trim()
    const pid = parseInt(raw, 10)
    if (isNaN(pid) || pid === process.pid) return
    try { process.kill(pid, 0) } catch { return }
    process.kill(pid, 'SIGTERM')
    log.info('server', `killed stale server process ${pid}`)
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      try { process.kill(pid, 0) } catch { return }
      const waitMs = 50
      const start = Date.now()
      while (Date.now() - start < waitMs) { /* spin */ }
    }
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  } catch { /* no pid file or process already gone */ }
}

export function startServer(opts: ServerOptions) {
  opts.clientDir = resolve(opts.clientDir)

  // Kill any stale server BEFORE starting the backend — the old server's shutdown
  // handler will clean up its observability supervisors. If we init first, we risk
  // adopting pids that are about to die.
  const configDir = getConfigRoot()
  const pidFile = join(configDir, 'server.pid')
  killStalePidSync(pidFile)

  const ctx = initBackend()
  const proxy = httpProxy.createProxyServer({ ws: true })

  function safeWriteHead(res: import('node:http').ServerResponse, status: number, headers: Record<string, string>) {
    if (res.headersSent || res.writableEnded) return false
    res.writeHead(status, headers)
    return true
  }

  proxy.on('error', (err, _req, res) => {
    log.warn('proxy', `proxy error: ${err.message}`)
    if (res && 'writeHead' in res) {
      const sRes = res as import('node:http').ServerResponse
      if (safeWriteHead(sRes, 502, { 'Content-Type': 'text/plain' })) sRes.end('Session proxy error')
    }
  })

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/'

    // 1. Session proxy — runs BEFORE static files
    const sessionMatch = url.match(/^\/s\/([^/]+)(\/.*)?$/)
    if (sessionMatch) {
      const sessionName = sessionMatch[1]!
      const run = ctx.docStore.getRun(sessionName)
      if (!run?.port) {
        if (safeWriteHead(res, 404, { 'Content-Type': 'text/plain' })) {
          res.end(`Session "${sessionName}" not found or has no port`)
        }
        return
      }
      // Strip the /s/{name} prefix before proxying
      req.url = sessionMatch[2] || '/'
      proxy.web(req, res, { target: `http://localhost:${run.port}` })
      return
    }

    // 2. API requests
    try {
      const handled = await handleRequest(ctx, req, res)
      if (handled) return
    } catch (err) {
      log.error('api', `request error: ${(err as Error).message}`)
      if (safeWriteHead(res, 500, { 'Content-Type': 'text/plain' })) res.end('Internal server error')
      return
    }

    // 3. Static file serving with SPA fallback
    const pathname = url.split('?')[0]!
    const ext = extname(pathname)
    const filePath = resolve(join(opts.clientDir, pathname))

    // Prevent path traversal outside clientDir
    if (!filePath.startsWith(opts.clientDir)) {
      if (safeWriteHead(res, 403, { 'Content-Type': 'text/plain' })) res.end('Forbidden')
      return
    }

    // Try to serve the exact file if it has an extension and exists
    if (ext && existsSync(filePath)) {
      try {
        const stat = statSync(filePath)
        if (stat.isFile()) {
          const mime = MIME_TYPES[ext] ?? 'application/octet-stream'
          if (safeWriteHead(res, 200, { 'Content-Type': mime })) {
            createReadStream(filePath).pipe(res)
          }
          return
        }
      } catch {
        // fall through to SPA fallback
      }
    }

    // SPA fallback — serve index.html for non-file routes
    const indexPath = join(opts.clientDir, 'index.html')
    if (existsSync(indexPath)) {
      if (safeWriteHead(res, 200, { 'Content-Type': 'text/html' })) {
        createReadStream(indexPath).pipe(res)
      }
    } else {
      if (safeWriteHead(res, 404, { 'Content-Type': 'text/plain' })) res.end('Not found')
    }
  })

  // WebSocket upgrades for session proxy
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/'
    const sessionMatch = url.match(/^\/s\/([^/]+)(\/.*)?$/)
    if (!sessionMatch) {
      socket.destroy()
      return
    }
    const sessionName = sessionMatch[1]!
    const run = ctx.docStore.getRun(sessionName)
    if (!run?.port) {
      socket.destroy()
      return
    }
    req.url = sessionMatch[2] || '/'
    proxy.ws(req, socket, head, { target: `http://localhost:${run.port}` })
  })

  const portFile = join(configDir, 'server.port')

  function writePortFile(port: number) {
    try { writeFileSync(portFile, String(port)) } catch { /* best effort */ }
  }

  function removePortFile() {
    try { unlinkSync(portFile) } catch { /* already gone */ }
  }

  function writePidFile() {
    try { writeFileSync(pidFile, String(process.pid)) } catch { /* best effort */ }
  }

  function removePidFile() {
    try { unlinkSync(pidFile) } catch { /* already gone */ }
  }

  process.on('exit', () => { removePortFile(); removePidFile() })

  const host = opts.host

  function listen(port: number, isRetry = false) {
    const onListening = () => {
      const displayHost = host ?? 'localhost'
      const url = `http://${displayHost}:${port}`
      writePortFile(port)
      writePidFile()
      const bindNote = host ? ` (bound to ${host})` : ''
      log.info('server', `Tinstar running at ${url}${bindNote}`)
      console.log(`\n  Tinstar running at ${url}${bindNote}\n`)
      if (opts.open) {
        import('node:child_process').then(({ exec }) => {
          const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
          exec(`${cmd} ${url}`)
        })
      }
    }
    if (host) server.listen(port, host, onListening)
    else server.listen(port, onListening)

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        if (process.env.TINSTAR_NO_PORT_FALLBACK === '1') {
          process.stderr.write(`[standalone] Port ${port} in use and TINSTAR_NO_PORT_FALLBACK=1 — exiting\n`)
          process.exit(1)
        }
        if (!isRetry) {
          killStalePidSync(pidFile)
          setTimeout(() => listen(port, true), 500)
        } else {
          log.warn('server', `port ${port} in use, trying ${port + 1}`)
          console.log(`  Port ${port} in use, trying ${port + 1}...`)
          listen(port + 1)
        }
      } else {
        throw err
      }
    })
  }

  listen(opts.port)
}

// Auto-start when run directly (not when imported by CLI)
const isDirectRun = process.argv[1]?.includes('standalone')
if (isDirectRun) {
  const args = process.argv.slice(2)
  const portIdx = args.indexOf('--port')
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1]!) : parseInt(process.env.TINSTAR_BACKEND_PORT ?? '5273')
  const hostIdx = args.indexOf('--host')
  const host = hostIdx !== -1 ? args[hostIdx + 1] : process.env.TINSTAR_HOST
  const noOpen = args.includes('--no-open')
  startServer({ port, host, clientDir: join(__dirname, '../../dist/client'), open: !noOpen })
}
