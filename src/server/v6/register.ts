import { Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { handleV6Http, handleV6Upgrade, isV6Path } from './shell/routes'
import { wireV6Modules } from './wire'

let installed = false

/** Install V6 routes on every HTTP server created after the backend boots. */
export function registerV6(): void {
  if (installed) return
  installed = true
  wireV6Modules()
  const original = Server.prototype.emit
  Server.prototype.emit = function patched(this: Server, event: string | symbol, ...args: unknown[]): boolean {
    const req = args[0] as IncomingMessage | undefined
    if ((event === 'request' || event === 'upgrade') && isV6Path(req?.url)) {
      if (event === 'request') {
        const res = args[1] as ServerResponse
        void handleV6Http(req as IncomingMessage, res).catch(err => {
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              ok: false,
              error: { code: 'INTERNAL', message: (err as Error).message },
            }))
          }
        })
        return true
      }
      handleV6Upgrade(req as IncomingMessage, args[1] as Duplex, args[2] as Buffer)
      return true
    }
    return original.apply(this, [event, ...args] as Parameters<typeof original>)
  }
}
