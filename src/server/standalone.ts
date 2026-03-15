import { createServer } from 'node:http'
import { join, extname, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream, existsSync, statSync } from 'node:fs'
import httpProxy from 'http-proxy'
import { initBackend } from './index'
import { handleRequest } from './api/routes'
import { log } from './logger'

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
}

export function startServer(opts: ServerOptions) {
  opts.clientDir = resolve(opts.clientDir)
  const ctx = initBackend()
  const proxy = httpProxy.createProxyServer({ ws: true })

  proxy.on('error', (err, _req, res) => {
    log.warn('proxy', `proxy error: ${err.message}`)
    if (res && 'writeHead' in res) {
      const sRes = res as import('node:http').ServerResponse
      if (!sRes.headersSent) {
        sRes.writeHead(502, { 'Content-Type': 'text/plain' })
        sRes.end('Session proxy error')
      }
    }
  })

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/'

    // 1. Session proxy — runs BEFORE static files
    const sessionMatch = url.match(/^\/s\/([^/]+)(\/.*)$/)
    if (sessionMatch) {
      const sessionName = sessionMatch[1]!
      const run = ctx.docStore.getRun(sessionName)
      if (!run?.port) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end(`Session "${sessionName}" not found or has no port`)
        return
      }
      // Strip the /s/{name} prefix before proxying
      req.url = sessionMatch[2]!
      proxy.web(req, res, { target: `http://localhost:${run.port}` })
      return
    }

    // 2. API requests
    try {
      const handled = await handleRequest(ctx, req, res)
      if (handled) return
    } catch (err) {
      log.error('api', `request error: ${(err as Error).message}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal server error')
      }
      return
    }

    // 3. Static file serving with SPA fallback
    const pathname = url.split('?')[0]!
    const ext = extname(pathname)
    const filePath = resolve(join(opts.clientDir, pathname))

    // Prevent path traversal outside clientDir
    if (!filePath.startsWith(opts.clientDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }

    // Try to serve the exact file if it has an extension and exists
    if (ext && existsSync(filePath)) {
      try {
        const stat = statSync(filePath)
        if (stat.isFile()) {
          const mime = MIME_TYPES[ext] ?? 'application/octet-stream'
          res.writeHead(200, { 'Content-Type': mime })
          createReadStream(filePath).pipe(res)
          return
        }
      } catch {
        // fall through to SPA fallback
      }
    }

    // SPA fallback — serve index.html for non-file routes
    const indexPath = join(opts.clientDir, 'index.html')
    if (existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      createReadStream(indexPath).pipe(res)
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
    }
  })

  // WebSocket upgrades for session proxy
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/'
    const sessionMatch = url.match(/^\/s\/([^/]+)(\/.*)$/)
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
    req.url = sessionMatch[2]!
    proxy.ws(req, socket, head, { target: `http://localhost:${run.port}` })
  })

  function listen(port: number) {
    server.listen(port, () => {
      const url = `http://localhost:${port}`
      log.info('server', `Tinstar running at ${url}`)
      console.log(`\n  Tinstar running at ${url}\n`)
      if (opts.open) {
        import('node:child_process').then(({ exec }) => {
          const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
          exec(`${cmd} ${url}`)
        })
      }
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.warn('server', `port ${port} in use, trying ${port + 1}`)
        console.log(`  Port ${port} in use, trying ${port + 1}...`)
        listen(port + 1)
      } else {
        throw err
      }
    })
  }

  listen(opts.port)
}

// Auto-start when run directly
const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const port = portIdx !== -1 ? parseInt(args[portIdx + 1]!) : 5273
const noOpen = args.includes('--no-open')
startServer({ port, clientDir: join(__dirname, '../../dist/client'), open: !noOpen })
