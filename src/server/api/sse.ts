import type { ServerResponse } from 'node:http'
import type { CorsHeaders } from './cors'

export class SSEBroadcaster {
  private clients = new Set<ServerResponse>()
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.heartbeatInterval = setInterval(() => {
      this.broadcastEvent('heartbeat', {})
    }, 15_000)
  }

  addClient(res: ServerResponse, corsHeaders?: CorsHeaders): void {
    const cors = corsHeaders ?? { 'Access-Control-Allow-Origin': '*' }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(cors as Record<string, string>),
    })
    res.flushHeaders()

    this.clients.add(res)

    res.on('close', () => {
      this.clients.delete(res)
    })
    res.on('error', () => {
      this.clients.delete(res)
    })
  }

  /** Broadcast a custom named SSE event to all clients */
  broadcastEvent(type: string, data: unknown): void {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(payload)
      } else {
        this.clients.delete(client)
      }
    }
  }

  destroy(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    for (const client of this.clients) {
      if (!client.destroyed) client.end()
    }
    this.clients.clear()
  }
}
