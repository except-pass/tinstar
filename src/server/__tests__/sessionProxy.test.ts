import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import httpProxy from 'http-proxy'
import {
  SESSION_PROXY_HOST,
  TERMINAL_AUTH_HEADER,
  createSessionRequestHandler,
  createSessionUpgradeHandler,
  handleSessionProxyError,
  isUpgradeOriginAllowed,
  loopbackOriginsForPort,
  resolveSessionProxyTarget,
} from '../sessionProxy'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

function track(server: Server) {
  // An upgraded socket is detached from the server's connection tracking, so
  // closeAllConnections() misses it and close() would hang. Keep our own list.
  const sockets: Socket[] = []
  server.on('connection', s => { sockets.push(s) })
  closers.push(() => new Promise<void>(resolve => {
    for (const s of sockets) s.destroy()
    server.closeAllConnections()
    const done = setTimeout(resolve, 500)
    server.close(() => { clearTimeout(done); resolve() })
  }))
  return server
}

function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port)
  }))
}

/**
 * Stand-in for ttyd: answers an upgrade with a bare 101 and echoes back which
 * path/headers it saw, so a test can prove the request really traversed the
 * proxy rather than being short-circuited.
 */
function startFakeTerminal() {
  const seen: {
    upgradePaths: string[]
    httpPaths: string[]
    httpHeaders: IncomingHttpHeaders[]
    upgradeHeaders: IncomingHttpHeaders[]
  } = { upgradePaths: [], httpPaths: [], httpHeaders: [], upgradeHeaders: [] }
  const server = track(createServer((req, res) => {
    seen.httpPaths.push(req.url ?? '')
    seen.httpHeaders.push(req.headers)
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`terminal:${req.url}`)
  }))
  server.on('upgrade', (req, socket) => {
    seen.upgradePaths.push(req.url ?? '')
    seen.upgradeHeaders.push(req.headers)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  return { server, seen, port: listen(server) }
}

/**
 * Raw handshake so the assertion is on the wire bytes (`101` vs a closed
 * socket), matching how the live hole was measured.
 */
function handshake(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '', '',
    ].join('\r\n')
    let buf = ''
    const sock: Socket = connect(port, '127.0.0.1', () => sock.write(lines))
    sock.setTimeout(4000, () => { sock.destroy(); reject(new Error('handshake timeout')) })
    sock.on('data', chunk => {
      buf += chunk.toString()
      if (buf.includes('\r\n\r\n')) { sock.destroy(); resolve(buf) }
    })
    sock.on('close', () => resolve(buf === '' ? 'CLOSED' : buf))
    sock.on('error', () => resolve(buf === '' ? 'CLOSED' : buf))
  })
}

describe('resolveSessionProxyTarget', () => {
  it('resolves to the IPv4 loopback literal and the run port', () => {
    expect(resolveSessionProxyTarget({ port: 7681 })).toEqual({
      host: '127.0.0.1',
      port: 7681,
      url: 'http://127.0.0.1:7681',
    })
    expect(SESSION_PROXY_HOST).toBe('127.0.0.1')
  })

  it('refuses a non-loopback host rather than producing a target for it', () => {
    expect(resolveSessionProxyTarget({ port: 7681 }, '10.0.0.5')).toBeNull()
    expect(resolveSessionProxyTarget({ port: 7681 }, 'evil.example.com')).toBeNull()
  })

  it('accepts the loopback literals', () => {
    expect(resolveSessionProxyTarget({ port: 22 }, '127.0.0.1')?.url).toBe('http://127.0.0.1:22')
    expect(resolveSessionProxyTarget({ port: 22 }, '::1')?.url).toBe('http://[::1]:22')
  })

  it('yields no target for a run with no port', () => {
    expect(resolveSessionProxyTarget({ port: null })).toBeNull()
    expect(resolveSessionProxyTarget({})).toBeNull()
    expect(resolveSessionProxyTarget(undefined)).toBeNull()
    expect(resolveSessionProxyTarget({ port: 0 })).toBeNull()
  })
})

describe('isUpgradeOriginAllowed', () => {
  const allowed = loopbackOriginsForPort(5273)

  it('admits an absent Origin (non-browser client)', () => {
    expect(isUpgradeOriginAllowed(undefined, allowed)).toBe(true)
  })

  it('admits every loopback origin form for the server port', () => {
    for (const origin of allowed) expect(isUpgradeOriginAllowed(origin, allowed)).toBe(true)
    expect(allowed).toEqual([
      'http://localhost:5273',
      'http://127.0.0.1:5273',
      'http://[::1]:5273',
    ])
  })

  it('refuses a foreign origin', () => {
    expect(isUpgradeOriginAllowed('https://evil.example.com', allowed)).toBe(false)
    expect(isUpgradeOriginAllowed('http://localhost:9999', allowed)).toBe(false)
    expect(isUpgradeOriginAllowed('null', allowed)).toBe(false)
    expect(isUpgradeOriginAllowed(['http://localhost:5273', 'https://evil.example.com'], allowed)).toBe(false)
  })
})

describe('session upgrade handler', () => {
  async function startProxyServer(opts: { terminalPort: number, serverPortRef: { port: number } }) {
    const proxy = httpProxy.createProxyServer({ ws: true })
    proxy.on('error', () => { /* absorbed; asserted separately */ })
    const proxyWs = vi.fn((req, socket, head, options) => proxy.ws(req, socket, head, options))
    const server = track(createServer((_req, res) => { res.writeHead(404); res.end() }))
    server.on('upgrade', createSessionUpgradeHandler({
      getRun: name => (name === 'run-1' ? { port: opts.terminalPort } : undefined),
      allowedOrigins: () => loopbackOriginsForPort(opts.serverPortRef.port),
      proxyWs,
    }))
    const port = await listen(server)
    opts.serverPortRef.port = port
    return { port, proxyWs }
  }

  it('refuses a foreign Origin before any proxying happens', async () => {
    const terminal = startFakeTerminal()
    const terminalPort = await terminal.port
    const ref = { port: 0 }
    const { port, proxyWs } = await startProxyServer({ terminalPort, serverPortRef: ref })

    const res = await handshake(port, '/s/run-1/ws', { Origin: 'https://evil.example.com' })
    expect(res).not.toContain('101')
    expect(res).toBe('CLOSED')
    expect(proxyWs).not.toHaveBeenCalled()
    expect(terminal.seen.upgradePaths).toEqual([])
  })

  it('admits an upgrade with no Origin', async () => {
    const terminal = startFakeTerminal()
    const terminalPort = await terminal.port
    const ref = { port: 0 }
    const { port } = await startProxyServer({ terminalPort, serverPortRef: ref })

    const res = await handshake(port, '/s/run-1/ws')
    expect(res).toContain('101 Switching Protocols')
    expect(terminal.seen.upgradePaths).toEqual(['/ws'])
  })

  it('admits each loopback Origin form for the server port', async () => {
    const terminal = startFakeTerminal()
    const terminalPort = await terminal.port
    const ref = { port: 0 }
    const { port } = await startProxyServer({ terminalPort, serverPortRef: ref })

    for (const origin of loopbackOriginsForPort(port)) {
      const res = await handshake(port, '/s/run-1/ws', { Origin: origin })
      expect(res, `origin ${origin}`).toContain('101 Switching Protocols')
    }
  })

  it('destroys the socket for a run with no port instead of proxying', async () => {
    const terminal = startFakeTerminal()
    const terminalPort = await terminal.port
    const ref = { port: 0 }
    const { port, proxyWs } = await startProxyServer({ terminalPort, serverPortRef: ref })

    const res = await handshake(port, '/s/unknown/ws')
    expect(res).toBe('CLOSED')
    expect(proxyWs).not.toHaveBeenCalled()
  })

  it('absorbs a client socket error raised mid-handshake', () => {
    const socket = new PassThrough() as unknown as import('node:stream').Duplex
    const handler = createSessionUpgradeHandler({
      getRun: () => ({ port: 7681 }),
      allowedOrigins: () => [],
      proxyWs: () => { /* handshake still in flight */ },
    })
    handler({ url: '/s/run-1/ws', headers: {} } as never, socket, Buffer.alloc(0))

    // An EventEmitter with no 'error' listener rethrows — this emit standing in
    // for the client's ECONNRESET is exactly what took the process down.
    expect(() => socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).not.toThrow()
  })
})

describe('handleSessionProxyError', () => {
  it('destroys the client socket on the ws path', () => {
    const warn = vi.fn()
    const socket = { destroy: vi.fn() }
    handleSessionProxyError(new Error('ECONNREFUSED'), socket as never, warn)
    expect(socket.destroy).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })

  it('still writes a 502 on the http path', () => {
    const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false, writableEnded: false }
    handleSessionProxyError(new Error('boom'), res as never, vi.fn())
    expect(res.writeHead).toHaveBeenCalledWith(502, { 'Content-Type': 'text/plain' })
    expect(res.end).toHaveBeenCalledWith('Session proxy error')
  })

  it('does not double-write when headers already went out', () => {
    const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: true, writableEnded: false }
    handleSessionProxyError(new Error('boom'), res as never, vi.fn())
    expect(res.writeHead).not.toHaveBeenCalled()
  })
})

describe('terminal auth header — the gate on a direct hit', () => {
  it('injects the header on the http pass', async () => {
    const terminal = startFakeTerminal()
    const terminalPort = await terminal.port
    const proxy = httpProxy.createProxyServer({})
    const handle = createSessionRequestHandler({
      getRun: () => ({ port: terminalPort }),
      proxyWeb: (req, res, options) => proxy.web(req, res, options),
    })
    const server = track(createServer((req, res) => {
      if (!handle(req, res)) { res.writeHead(404); res.end('missed') }
    }))
    const port = await listen(server)

    const res = await fetch(`http://127.0.0.1:${port}/s/run-1/token`)
    expect(res.status).toBe(200)
    expect(terminal.seen.httpHeaders[0]?.[TERMINAL_AUTH_HEADER.toLowerCase()])
      .toBeTruthy()
  })

  it('injects the header on the upgrade pass', async () => {
    const terminal = startFakeTerminal()
    const terminalPort = await terminal.port
    const proxy = httpProxy.createProxyServer({ ws: true })
    const upgrade = createSessionUpgradeHandler({
      getRun: () => ({ port: terminalPort }),
      allowedOrigins: () => [],
      proxyWs: (req, socket, head, options) => proxy.ws(req, socket, head, options),
    })
    const server = track(createServer((_req, res) => { res.end() }))
    server.on('upgrade', upgrade)
    const port = await listen(server)

    expect(await handshake(port, '/s/run-1/ws')).toContain('101')
    expect(terminal.seen.upgradeHeaders[0]?.[TERMINAL_AUTH_HEADER.toLowerCase()])
      .toBeTruthy()
  })

  it('strips provider identity headers before the terminal sees them', async () => {
    // KTD10: identity headers are recorded, never trusted. Forwarding one to a
    // terminal would hand a forged claim to a process that has no way to judge
    // it — and after loopback binding any local process can forge one.
    const terminal = startFakeTerminal()
    const terminalPort = await terminal.port
    const proxy = httpProxy.createProxyServer({})
    const handle = createSessionRequestHandler({
      getRun: () => ({ port: terminalPort }),
      proxyWeb: (req, res, options) => proxy.web(req, res, options),
    })
    const server = track(createServer((req, res) => {
      if (!handle(req, res)) { res.writeHead(404); res.end('missed') }
    }))
    const port = await listen(server)

    await fetch(`http://127.0.0.1:${port}/s/run-1/`, {
      headers: {
        'Tailscale-User-Login': 'someone@example.com',
        'Tailscale-User-Name': 'Someone',
      },
    })
    expect(terminal.seen.httpHeaders[0]?.['tailscale-user-login']).toBeUndefined()
    expect(terminal.seen.httpHeaders[0]?.['tailscale-user-name']).toBeUndefined()
  })

  it('strips provider identity headers on the upgrade pass too', async () => {
    const terminal = startFakeTerminal()
    const terminalPort = await terminal.port
    const proxy = httpProxy.createProxyServer({ ws: true })
    const upgrade = createSessionUpgradeHandler({
      getRun: () => ({ port: terminalPort }),
      allowedOrigins: () => [],
      proxyWs: (req, socket, head, options) => proxy.ws(req, socket, head, options),
    })
    const server = track(createServer((_req, res) => { res.end() }))
    server.on('upgrade', upgrade)
    const port = await listen(server)

    await handshake(port, '/s/run-1/ws', { 'Tailscale-User-Login': 'someone@example.com' })
    expect(terminal.seen.upgradeHeaders[0]?.['tailscale-user-login']).toBeUndefined()
  })

  it('leaves the session-proxy branch alone for a non-session URL', () => {
    const proxyWeb = vi.fn()
    const handle = createSessionRequestHandler({
      getRun: () => ({ port: 7681 }),
      proxyWeb,
    })
    expect(handle({ url: '/api/runs', headers: {} } as never, {} as never)).toBe(false)
    expect(proxyWeb).not.toHaveBeenCalled()
  })
})

describe('http through the session proxy', () => {
  it('reaches the terminal using the resolved target', async () => {
    const terminal = startFakeTerminal()
    const terminalPort = await terminal.port
    const proxy = httpProxy.createProxyServer({})
    const server = track(createServer((req, res) => {
      const match = (req.url ?? '/').match(/^\/s\/([^/]+)(\/.*)?$/)!
      const target = resolveSessionProxyTarget({ port: terminalPort })!
      req.url = match[2] || '/'
      proxy.web(req, res, { target: target.url })
    }))
    const port = await listen(server)

    const res = await fetch(`http://127.0.0.1:${port}/s/run-1/token`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('terminal:/token')
    expect(terminal.seen.httpPaths).toEqual(['/token'])
  })
})
