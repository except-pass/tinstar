import { Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { registerAccountRoutes } from './account'
import { registerNeedsYouRoutes } from './needsyou'
import { handleObjectiveRequest, registerObjectiveRoutes } from './objective'
import { registerPortfolioRoutes } from './portfolio'
import { registerQuotaRoutes } from './quota'
import { createThreadHandler, registerThreadRoutes, type ThreadListener } from './threads'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

/** Listener shape the module registrars attach to. Not a listening socket. */
class RouteHub {
  on(event: 'request', listener: (req: IncomingMessage, res: ServerResponse) => void): this {
    void event
    void listener
    return this
  }
}

const MODULE_PREFIXES = [
  '/api/v6/account',
  '/api/v6/needsyou',
  '/api/v6/portfolio',
  '/api/v6/quota',
  '/api/v6/threads',
  '/api/v6/objectives',
  '/api/v6/launches',
]

let handlers: Handler[] | null = null
let emitWrapped = false

function isModuleRequest(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('url' in value)) return false
  const url = (value as { url?: unknown }).url
  if (typeof url !== 'string') return false
  const path = url.split('?')[0] ?? ''
  return MODULE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

/**
 * Call every module registrar once and keep the boolean handlers.
 * Objective and portfolio also attach to the hub; the composed handler
 * awaits the boolean functions so a request is answered one time.
 */
export function v6ModuleHandlers(): Handler[] {
  if (handlers) return handlers
  const hub = new RouteHub()
  const account = registerAccountRoutes()
  const needsYou = registerNeedsYouRoutes()
  const portfolio = registerPortfolioRoutes(hub as unknown as Server)
  registerObjectiveRoutes(hub as unknown as Server)
  const quota = registerQuotaRoutes()
  const threads = createThreadHandler({ exclusive: false })
  registerThreadRoutes(hub as unknown as ThreadListener, { exclusive: false })
  handlers = [
    account,
    needsYou,
    portfolio,
    quota,
    threads,
    (req, res) => handleObjectiveRequest(req, res),
  ]
  return handlers
}

/** Run the wired module routes. False means the shell still owns the request. */
export async function handleWiredHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  for (const handler of v6ModuleHandlers()) {
    if (await handler(req, res)) return true
  }
  return false
}

function installEmitWrap(): void {
  if (emitWrapped) return
  emitWrapped = true
  const current = Server.prototype.emit
  const wrapped = function accountEmit(this: Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'request' && isModuleRequest(args[0])) {
      const req = args[0] as IncomingMessage
      const res = args[1] as ServerResponse
      void handleWiredHttp(req, res).then(handled => {
        if (!handled && !res.headersSent) current.apply(this, [event, ...args] as Parameters<typeof current>)
      }).catch((err: unknown) => {
        if (res.headersSent || res.writableEnded) return
        const message = err instanceof Error ? err.message : 'v6 module route failed'
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message } }))
      })
      return true
    }
    return current.apply(this, [event, ...args] as Parameters<typeof current>)
  }
  Server.prototype.emit = wrapped as typeof current
}

/** Production caller. registerV6 invokes this before it installs the shell emit patch. */
export function wireV6Modules(): void {
  v6ModuleHandlers()
  queueMicrotask(installEmitWrap)
}
