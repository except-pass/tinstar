import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * The session proxy always talks to the terminal over the IPv4 loopback
 * literal. A resolvable name ("localhost") would re-introduce DNS ambiguity
 * plus a per-request Happy-Eyeballs fallback penalty on dual-stack hosts.
 */
export const SESSION_PROXY_HOST = '127.0.0.1'

export interface SessionProxyTarget {
  host: string
  port: number
  /** Ready-to-pass `target` for http-proxy. */
  url: string
}

/**
 * Loopback IP literals only — never a name. A name would let a future caller
 * pass something DNS-controlled, turning the proxy into a request-forgery
 * pivot: the run record decides the port, so the host must be pinned here.
 */
function isLoopbackLiteral(host: string): boolean {
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return host.split('.').every(part => Number(part) <= 255)
  }
  return host === '::1' || host === '[::1]'
}

/**
 * Turns a run record into a proxy target, or null when there is nothing safe
 * to proxy to. Returning null (rather than a half-formed URL) is what keeps a
 * portless run from producing `http://127.0.0.1:undefined`.
 */
export function resolveSessionProxyTarget(
  run: { port?: number | null } | null | undefined,
  host: string = SESSION_PROXY_HOST,
): SessionProxyTarget | null {
  const port = run?.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  if (!isLoopbackLiteral(host)) return null
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return { host, port, url: `http://${authority}:${port}` }
}

/**
 * The origins a browser may legitimately be on when it opens a terminal today:
 * this server's own loopback URLs. U9 makes this list runtime-registrable so a
 * tailnet origin can join it — the handler already reads it through a resolver
 * function, so that swap does not touch the check itself.
 */
export function loopbackOriginsForPort(port: number): string[] {
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]
}

/**
 * An **absent** Origin passes: that is a non-browser client (curl, the desktop
 * shell, an agent), which the header-based gate covers instead. A *present*
 * Origin means a page opened this socket, and only known origins may.
 */
export function isUpgradeOriginAllowed(
  origin: string | string[] | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined) return true
  // A duplicated Origin header is never legitimate — refuse rather than pick.
  if (Array.isArray(origin)) return false
  const normalized = origin.trim().toLowerCase().replace(/\/$/, '')
  return allowed.some(a => a.trim().toLowerCase().replace(/\/$/, '') === normalized)
}

/**
 * On the `ws` path http-proxy hands back a `net.Socket`, not a ServerResponse
 * — hence the `writeHead` discrimination rather than a type check. An errored
 * upgrade socket must be destroyed: nothing else will ever write to it, and
 * leaving it open leaks a connection per failed handshake.
 */
export function handleSessionProxyError(
  err: Error,
  res: ServerResponse | Duplex | undefined,
  warn: (message: string) => void,
): void {
  warn(`proxy error: ${err.message}`)
  if (!res) return
  if ('writeHead' in res) {
    const sRes = res as ServerResponse
    if (sRes.headersSent || sRes.writableEnded) return
    sRes.writeHead(502, { 'Content-Type': 'text/plain' })
    sRes.end('Session proxy error')
    return
  }
  res.destroy()
}

export interface SessionUpgradeDeps {
  getRun(sessionName: string): { port?: number | null } | null | undefined
  /** Read fresh on every upgrade so a later runtime registration is picked up. */
  allowedOrigins(): readonly string[]
  proxyWs(req: IncomingMessage, socket: Duplex, head: Buffer, options: { target: string }): void
  onRefused?(detail: { reason: string, origin?: string, url: string }): void
  onClientSocketError?(detail: { error: string, url: string }): void
}

export function createSessionUpgradeHandler(deps: SessionUpgradeDeps) {
  return function upgradeHandler(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = req.url ?? '/'
    const sessionMatch = url.match(/^\/s\/([^/]+)(\/.*)?$/)
    if (!sessionMatch) {
      socket.destroy()
      return
    }

    // Checked before anything reaches the proxy: the terminal's own gate is a
    // proxy-injected header, which a hostile page would inherit by riding this
    // very hop. The Origin refusal is what stops that page.
    const origin = req.headers.origin
    if (!isUpgradeOriginAllowed(origin, deps.allowedOrigins())) {
      deps.onRefused?.({ reason: 'origin', origin: Array.isArray(origin) ? origin.join(', ') : origin, url })
      socket.destroy()
      return
    }

    const sessionName = sessionMatch[1]!
    const target = resolveSessionProxyTarget(deps.getRun(sessionName))
    if (!target) {
      socket.destroy()
      return
    }

    // http-proxy only guards the *outgoing* leg on the ws path. A client that
    // dies mid-handshake emits ECONNRESET here with no listener attached, and
    // an unhandled 'error' on an EventEmitter takes the process down.
    socket.on('error', (err: Error) => {
      deps.onClientSocketError?.({ error: err.message, url })
    })

    req.url = sessionMatch[2] || '/'
    deps.proxyWs(req, socket, head, { target: target.url })
  }
}
