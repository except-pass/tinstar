/**
 * NATS Traffic Bridge
 *
 * Connects to NATS and subscribes to _tinstar.traffic.> to receive
 * traffic events from channel-servers, then broadcasts them via SSE.
 */

import { connect, StringCodec, type NatsConnection, type Subscription } from 'nats'
import type { SSEBroadcaster } from './api/sse'
import { log } from './logger'

export interface NatsTrafficEvent {
  timestamp: string
  sessionName: string
  direction: 'inbound' | 'outbound'
  subject: string
  from: string
  replyTo: string | null
  body: string  // Full body from channel-server
}

export class NatsTrafficBridge {
  private nc: NatsConnection | null = null
  private sub: Subscription | null = null
  private sc = StringCodec()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private sse: SSEBroadcaster,
    private natsUrl: string = 'nats://localhost:4222',
  ) {}

  async start(): Promise<void> {
    try {
      this.nc = await connect({ servers: this.natsUrl })
      log.info('nats-traffic', `connected to ${this.natsUrl}`)

      // Subscribe to all traffic events
      this.sub = this.nc.subscribe('_tinstar.traffic.>')
      this.processMessages()

      // Handle connection close
      this.nc.closed().then(() => {
        log.info('nats-traffic', 'connection closed')
        this.scheduleReconnect()
      })
    } catch (err) {
      log.warn('nats-traffic', `failed to connect: ${(err as Error).message}`)
      this.scheduleReconnect()
    }
  }

  private async processMessages(): Promise<void> {
    if (!this.sub) return

    try {
      for await (const msg of this.sub) {
        try {
          const event = JSON.parse(this.sc.decode(msg.data)) as NatsTrafficEvent
          this.sse.broadcastEvent('nats_traffic', event)
        } catch (err) {
          log.warn('nats-traffic', `failed to parse message: ${(err as Error).message}`)
        }
      }
    } catch (err) {
      log.warn('nats-traffic', `subscription error: ${(err as Error).message}`)
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.start()
    }, 5000)
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.sub) {
      this.sub.unsubscribe()
      this.sub = null
    }
    if (this.nc) {
      await this.nc.drain()
      this.nc = null
    }
  }
}
