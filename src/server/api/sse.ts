import type { ServerResponse } from 'node:http'
import type { DocumentStore } from '../stores/document-store'
import type { BusEventType } from '../types'

export class SSEBroadcaster {
  private clients = new Set<ServerResponse>()
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private readyQueue: string[] = []

  constructor(private store: DocumentStore) {
    this.store.changes.on('change', (change: { entity: string; id: string; data: unknown }) => {
      // Always broadcast space changes and clear-all
      // Suppress entity deltas for non-active spaces
      if (change.entity !== 'space' && change.entity !== 'all' && this.store.activeSpaceId) {
        const spaceId = (change.data as Record<string, unknown> | null)?.spaceId as string | undefined
        if (change.data !== null && spaceId && spaceId !== this.store.activeSpaceId) {
          return
        }
      }

      this.broadcast({
        type: 'delta',
        data: {
          eventType: `${change.entity}.updated` as BusEventType,
          entity: change.entity,
          id: change.id,
          data: change.data,
        },
      })
    })

    this.heartbeatInterval = setInterval(() => {
      this.broadcast({ type: 'heartbeat' })
    }, 15_000)
  }

  setReadyQueue(queue: string[]): void {
    this.readyQueue = queue
  }

  broadcastReadyQueueUpdate(): void {
    this.broadcastEvent('ready_queue_update', { queue: this.readyQueue })
  }

  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    // Send snapshot on connect
    const snapshot = { ...this.store.snapshot(), ready_queue: this.readyQueue }
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)

    this.clients.add(res)

    res.on('close', () => {
      this.clients.delete(res)
    })
  }

  private broadcast(message: { type: string; data?: unknown }): void {
    const event = message.type
    const data = message.data !== undefined ? JSON.stringify(message.data) : '{}'
    const payload = `event: ${event}\ndata: ${data}\n\n`

    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(payload)
      } else {
        this.clients.delete(client)
      }
    }
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

  /** Send a fresh snapshot to all connected clients (used on space switch) */
  broadcastSnapshot(): void {
    const snapshot = this.store.snapshot()
    const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(payload)
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
