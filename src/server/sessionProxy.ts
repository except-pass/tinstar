import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * The session proxy always talks to the terminal over the IPv4 loopback
 * literal. A resolvable name ("localhost") would re-introduce DNS ambiguity
 * plus a per-request Happy-Eyeballs fallback penalty on dual-stack hosts.
 */
export const SESSION_PROXY_HOST = '127.0.0.1'

/**
 * The header ttyd is told to require (`-H`). Its job is narrow and worth
 * stating exactly: it stops a **direct** hit on the terminal port. It does not
 * close the browser path, because a hostile page reaches the proxied hop and
 * this proxy injects the header on its behalf — that case is the `Origin`
 * refusal's job.
 *
 * Verified against ttyd 1.7.4, not read off the help text: `-H` gates every
 * HTTP request (a plain GET returns 407 without it), and it gates the
 * WebSocket upgrade too — a raw handshake without the header gets an empty
 * reply and a closed connection, with the header it gets 101 and the `tty`
 * subprotocol. Every Tinstar path that speaks to a terminal must present it,
 * including the readiness probe.
 */
export const TERMINAL_AUTH_HEADER = 'X-Tinstar-Proxy'

/** ttyd checks for the header's presence; the value is ours to choose. */
export const TERMINAL_AUTH_VALUE = 'tinstar-session-proxy'

/**
 * Identity headers a reach provider stamps on the inbound edge. They are
 * recorded, never treated as attested (KTD10): after loopback binding every
 * request appears local, so any local process can forge one. Dropping them at
 * this hop keeps a forged claim from reaching a terminal, which has no way to
 * judge it.
 */
export const PROVIDER_IDENTITY_HEADERS = [
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
] as const

/** Options every hop to a terminal is made with — one source for both passes. */
export function terminalProxyOptions(
  target: SessionProxyTarget,
): { target: string; headers: Record<string, string> } {
  return { target: target.url, headers: { [TERMINAL_AUTH_HEADER]: TERMINAL_AUTH_VALUE } }
}

/** Mutates the request in place; returns the header names actually dropped. */
export function stripProviderIdentityHeaders(
  headers: Record<string, unknown>,
): string[] {
  const dropped: string[] = []
  for (const name of PROVIDER_IDENTITY_HEADERS) {
    if (headers[name] !== undefined) {
      delete headers[name]
      dropped.push(name)
    }
  }
  return dropped
}

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

export interface SessionRequestDeps {
  getRun(sessionName: string): { port?: number | null } | null | undefined
  proxyWeb(
    req: IncomingMessage,
    res: ServerResponse,
    options: { target: string; headers: Record<string, string> },
  ): void
  /** Called when there is no session or no port; the caller has already stopped. */
  onNoTarget?(sessionName: string, res: ServerResponse): void
}

/**
 * The HTTP half of the session proxy, extracted for the same reason the
 * upgrade half was: importing `standalone.ts` from a test hangs on its
 * sessions/NATS import chain, so anything only reachable there is untestable.
 *
 * Returns false when the URL is not a session path, leaving the caller's other
 * routes untouched.
 */
export function createSessionRequestHandler(deps: SessionRequestDeps) {
  return function handleSessionRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    const sessionMatch = (req.url ?? '/').match(/^\/s\/([^/]+)(\/.*)?$/)
    if (!sessionMatch) return false

    const sessionName = sessionMatch[1]!
    const target = resolveSessionProxyTarget(deps.getRun(sessionName))
    if (!target) {
      deps.onNoTarget?.(sessionName, res)
      return true
    }

    stripProviderIdentityHeaders(req.headers as Record<string, unknown>)
    req.url = sessionMatch[2] || '/'
    deps.proxyWeb(req, res, terminalProxyOptions(target))
    return true
  }
}

export interface SessionUpgradeDeps {
  getRun(sessionName: string): { port?: number | null } | null | undefined
  /** Read fresh on every upgrade so a later runtime registration is picked up. */
  allowedOrigins(): readonly string[]
  proxyWs(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    options: { target: string; headers: Record<string, string> },
  ): void
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

    stripProviderIdentityHeaders(req.headers as Record<string, unknown>)
    req.url = sessionMatch[2] || '/'
    deps.proxyWs(req, socket, head, terminalProxyOptions(target))
  }
}
