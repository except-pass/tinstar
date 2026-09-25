import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import httpProxy from 'http-proxy'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WorkerDescriptor } from '../../../v6/contract/descriptor'
import { LOOPBACK_BIND_ADDRESS, LOOPBACK_BIND_ADDRESS_V6 } from '../../bind'
import { guestEnv } from '../../sessions/guestEnv'
import { TERMINAL_AUTH_HEADER, TERMINAL_AUTH_VALUE, stripProviderIdentityHeaders } from '../../sessionProxy'
import { ttydVersionRefusalNow } from '../../sessions/backends/tmux'
import { parseEndpointTarget, v6TmuxSocket, type WindowRef } from './sessionGuard'

export const VIEW_SCRIPT_NAME = 'tinstar-v6-view'

export function resolveV6ViewScript(startDir = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'bin', VIEW_SCRIPT_NAME)
    if (existsSync(candidate)) return candidate
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

export function v6ViewTtydArgv(opts: {
  port: number
  bind: string
  script: string
  socket: string
  session: string
  windowId: string
  windowName: string
}): string[] {
  return [
    '-W',
    '-i', opts.bind,
    '-H', TERMINAL_AUTH_HEADER,
    '-p', String(opts.port),
    '-t', 'titleFixed=Tinstar V6',
    '-t', 'theme={"background":"#000000"}',
    opts.script,
    opts.socket,
    opts.session,
    opts.windowId,
    opts.windowName,
  ]
}

export function descriptorChanged(
  seen: { spawnGen: string | null; target: string | null },
  fresh: WorkerDescriptor,
): boolean {
  return seen.spawnGen !== fresh.spawnGen || seen.target !== fresh.endpoint.target
}

export interface V6ViewDeps {
  tmux(socket: string, args: string[]): Promise<string>
  spawnTtyd(argv: string[], env: Record<string, string>): ChildProcess
  ttydRefusal(): string | null
  healthCheck(port: number): Promise<boolean>
  claimPort(): Promise<number>
  releasePort(port: number): void
}

const AVOID_PORTS = new Set([5280, 5281])

export async function claimLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, LOOPBACK_BIND_ADDRESS, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => {
        if (!port || AVOID_PORTS.has(port)) reject(new Error('no loopback port'))
        else resolve(port)
      })
    })
  })
}

function tmuxEnv(): Record<string, string> {
  const extra: Record<string, string> = {}
  if (process.env.TMUX_TMPDIR) extra.TMUX_TMPDIR = process.env.TMUX_TMPDIR
  const env = guestEnv(extra)
  delete env.TMUX
  return env
}

function defaultTmux(socket: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', socket, ...args], { env: tmuxEnv(), timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        const error = new Error(String(stderr || err.message))
        reject(error)
        return
      }
      resolve(String(stdout ?? ''))
    })
  })
}

async function probeTtyd(port: number): Promise<boolean> {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${LOOPBACK_BIND_ADDRESS}:${port}/`, {
        headers: { [TERMINAL_AUTH_HEADER]: TERMINAL_AUTH_VALUE },
      })
      if (response.ok) return true
    } catch {
      /* not ready */
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return false
}

export function defaultV6ViewDeps(): V6ViewDeps {
  return {
    tmux: defaultTmux,
    spawnTtyd: (argv, env) => spawn('ttyd', argv, { env, stdio: 'ignore' }),
    ttydRefusal: () => ttydVersionRefusalNow(),
    healthCheck: probeTtyd,
    claimPort: claimLoopbackPort,
    releasePort: () => undefined,
  }
}

export type TerminalResult =
  | { state: 'live'; port: number }
  | { state: 'unavailable'; reason: string }

interface LiveBind {
  port: number
  child: ChildProcess
}

interface LiveView {
  workerId: string
  key: string
  binds: LiveBind[]
}

function windowIdFromListing(listing: string, windowName: string): string | null {
  for (const line of listing.split('\n')) {
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const id = line.slice(0, space)
    if (line.slice(space + 1) === windowName && /^@\d+$/.test(id)) return id
  }
  return null
}

export class V6Views {
  private readonly live = new Map<string, LiveView>()
  readonly spawns: string[][] = []

  constructor(private readonly deps: V6ViewDeps = defaultV6ViewDeps(), private readonly script: string | null = resolveV6ViewScript()) {}

  portOf(workerId: string): number | null {
    return this.live.get(workerId)?.binds[0]?.port ?? null
  }

  /** Stop the view's ttyd processes. Does not address the worker's tmux window. */
  close(workerId: string): void {
    const view = this.live.get(workerId)
    if (!view) return
    this.live.delete(workerId)
    for (const bind of view.binds) {
      this.deps.releasePort(bind.port)
      try { bind.child.kill('SIGTERM') } catch { /* already gone */ }
    }
  }

  async open(worker: WorkerDescriptor, socket = v6TmuxSocket()): Promise<TerminalResult> {
    if (worker.backend !== 'tmux') {
      return { state: 'unavailable', reason: `${worker.backend || 'this backend'} is not a local tmux terminal` }
    }
    const ref = parseEndpointTarget(worker.endpoint.target)
    if (!ref) return { state: 'unavailable', reason: 'terminal target is unavailable' }
    if (!socket) return { state: 'unavailable', reason: 'private tmux socket is not configured' }
    if (!this.script) return { state: 'unavailable', reason: 'tinstar-v6-view is not installed' }
    const refusal = this.deps.ttydRefusal()
    if (refusal) return { state: 'unavailable', reason: refusal }

    let listing: string
    try {
      listing = await this.deps.tmux(socket, ['list-windows', '-t', `=${ref.session}`, '-F', '#{window_id} #{window_name}'])
    } catch {
      return { state: 'unavailable', reason: 'worker window is gone' }
    }
    const windowId = windowIdFromListing(listing, ref.windowName)
    if (!windowId) return { state: 'unavailable', reason: 'worker window is gone' }

    const key = `${worker.spawnGen ?? ''}\n${worker.endpoint.target ?? ''}\n${windowId}`
    const existing = this.live.get(worker.id)
    if (existing?.key === key && existing.binds[0]) return { state: 'live', port: existing.binds[0].port }
    if (existing) this.close(worker.id)

    const binds: LiveBind[] = []
    const primary = await this.spawnOne(LOOPBACK_BIND_ADDRESS, socket, ref, windowId)
    if (!primary) return { state: 'unavailable', reason: 'could not start the terminal' }
    binds.push(primary)
    const v6 = await this.spawnOne(LOOPBACK_BIND_ADDRESS_V6, socket, ref, windowId)
    if (v6) binds.push(v6)

    const healthy = await this.deps.healthCheck(primary.port)
    if (!healthy) {
      for (const bind of binds) {
        this.deps.releasePort(bind.port)
        try { bind.child.kill('SIGTERM') } catch { /* already gone */ }
      }
      return { state: 'unavailable', reason: 'terminal did not become ready' }
    }
    this.live.set(worker.id, { workerId: worker.id, key, binds })
    return { state: 'live', port: primary.port }
  }

  private async spawnOne(bind: string, socket: string, ref: WindowRef, windowId: string): Promise<LiveBind | null> {
    if (!this.script) return null
    let port: number
    try {
      port = await this.deps.claimPort()
    } catch {
      return null
    }
    const argv = v6ViewTtydArgv({
      port,
      bind,
      script: this.script,
      socket,
      session: ref.session,
      windowId,
      windowName: ref.windowName,
    })
    this.spawns.push(argv)
    let child: ChildProcess
    try {
      child = this.deps.spawnTtyd(argv, tmuxEnv())
    } catch {
      this.deps.releasePort(port)
      return null
    }
    return { port, child }
  }
}

export function upgradeOriginAllowed(origin: string | string[] | undefined): boolean {
  if (origin === undefined) return true
  const value = Array.isArray(origin) ? origin[0] : origin
  if (!value) return true
  try {
    const url = new URL(value)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  } catch {
    return false
  }
}

const proxy = httpProxy.createProxyServer({ ws: true })
proxy.on('error', (_err, _req, res) => {
  if (res && typeof (res as ServerResponse).writeHead === 'function') {
    const response = res as ServerResponse
    if (!response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'text/plain' })
      response.end('terminal unavailable')
    }
  }
})

export function proxyTerminalHttp(req: IncomingMessage, res: ServerResponse, port: number, suffix: string): void {
  stripProviderIdentityHeaders(req.headers as Record<string, unknown>)
  req.url = suffix || '/'
  proxy.web(req, res, {
    target: `http://${LOOPBACK_BIND_ADDRESS}:${port}`,
    headers: { [TERMINAL_AUTH_HEADER]: TERMINAL_AUTH_VALUE },
  })
}

export function proxyTerminalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number, suffix: string): void {
  if (!upgradeOriginAllowed(req.headers.origin)) {
    socket.destroy()
    return
  }
  stripProviderIdentityHeaders(req.headers as Record<string, unknown>)
  req.url = suffix || '/'
  socket.on('error', () => { /* client went away */ })
  proxy.ws(req, socket, head, {
    target: `http://${LOOPBACK_BIND_ADDRESS}:${port}`,
    headers: { [TERMINAL_AUTH_HEADER]: TERMINAL_AUTH_VALUE },
  })
}
