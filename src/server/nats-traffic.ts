/**
 * NATS Traffic Bridge
 *
 * Subscribes to NATS subjects based on widget configurations and broadcasts
 * traffic events via SSE for display in traffic monitor widgets.
 */

import { connect, StringCodec, type NatsConnection, type Subscription } from 'nats'
import type { SSEBroadcaster } from './api/sse'
import { log } from './logger'

export interface NatsTrafficEvent {
  timestamp: string
  subject: string
  data: string
  direction: 'inbound' | 'outbound'
  sender?: string  // Extracted from subject or known from publish
}

/** Broker reachability from a connection handle. 'up' iff we hold a live,
 *  non-closed connection. Pure so it can be unit-tested without a real broker. */
export function brokerConnection(nc: { isClosed(): boolean } | null): 'up' | 'down' {
  return nc !== null && !nc.isClosed() ? 'up' : 'down'
}

export class NatsTrafficBridge {
  private nc: NatsConnection | null = null
  private sc = StringCodec()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // Per-widget subscriptions
  private widgetSubscriptions = new Map<string, Set<string>>()
  // Active NATS subscriptions (subject -> Subscription)
  private activeSubs = new Map<string, Subscription>()

  constructor(
    private sse: SSEBroadcaster,
    private natsUrl: string = 'nats://localhost:4222',
  ) {}

  /** Host NATS broker reachability for the Saloon's palette health light.
   *  Reflects the live observer connection (cleared on close, auto-reconnecting). */
  status(): { connection: 'up' | 'down' } {
    return { connection: brokerConnection(this.nc) }
  }

  async start(): Promise<void> {
    try {
      this.nc = await connect({ servers: this.natsUrl })
      log.info('nats-traffic', `connected to ${this.natsUrl}`)

      // Handle connection close
      this.nc.closed().then(() => {
        log.info('nats-traffic', 'connection closed')
        this.activeSubs.clear()
        this.scheduleReconnect()
      })

      // Re-establish any subscriptions that were declared while we were
      // disconnected (or before we ever started). `widgetSubscriptions` is
      // preserved across stop()/start() so an explicit bounce resumes
      // observing without callers having to re-register.
      this.syncSubscriptions()
    } catch (err) {
      log.warn('nats-traffic', `failed to connect: ${(err as Error).message}`)
      this.scheduleReconnect()
    }
  }

  /**
   * Update subscriptions for a widget. Computes the diff and adds/removes
   * NATS subscriptions as needed.
   */
  updateWidgetSubscriptions(widgetId: string, subjects: string[]): void {
    const subjectSet = new Set(subjects)
    this.widgetSubscriptions.set(widgetId, subjectSet)
    this.syncSubscriptions()
  }

  /**
   * Remove a widget and its subscriptions.
   */
  removeWidget(widgetId: string): void {
    this.widgetSubscriptions.delete(widgetId)
    this.syncSubscriptions()
  }

  /**
   * Publish a message to a NATS subject.
   */
  publish(subject: string, message: string, sender?: string): void {
    if (!this.nc) {
      log.warn('nats-traffic', 'cannot publish: not connected')
      return
    }
    try {
      this.nc.publish(subject, this.sc.encode(message))
      // Broadcast the publish event to UI (marked as outbound)
      const event: NatsTrafficEvent = {
        timestamp: new Date().toISOString(),
        subject,
        data: message,
        direction: 'outbound',
        sender: sender ?? 'tinstar',
      }
      this.sse.broadcastEvent('nats_traffic', event)
      log.info('nats-traffic', `published to ${subject}`)
    } catch (err) {
      log.warn('nats-traffic', `failed to publish: ${(err as Error).message}`)
    }
  }

  /**
   * Sync active NATS subscriptions with the union of all widget subscriptions.
   */
  private syncSubscriptions(): void {
    if (!this.nc) return

    // Compute union of all widget subscriptions
    const needed = new Set<string>()
    for (const subs of this.widgetSubscriptions.values()) {
      for (const s of subs) needed.add(s)
    }

    // Add new subscriptions
    for (const subject of needed) {
      if (!this.activeSubs.has(subject)) {
        try {
          const sub = this.nc.subscribe(subject)
          this.activeSubs.set(subject, sub)
          this.processSubscription(subject, sub)
          log.info('nats-traffic', `subscribed to ${subject}`)
        } catch (err) {
          log.warn('nats-traffic', `failed to subscribe to ${subject}: ${(err as Error).message}`)
        }
      }
    }

    // Remove old subscriptions
    for (const [subject, sub] of this.activeSubs) {
      if (!needed.has(subject)) {
        sub.unsubscribe()
        this.activeSubs.delete(subject)
        log.info('nats-traffic', `unsubscribed from ${subject}`)
      }
    }
  }

  /**
   * Extract sender from NATS subject.
   * Subject format: tinstar.<space>.<init>.<epic>.<task>.<session>
   * Returns the last segment (session name) as sender.
   */
  private extractSender(subject: string): string | undefined {
    const parts = subject.split('.')
    // tinstar subjects have the session as the last segment
    if (parts[0] === 'tinstar' && parts.length >= 2) {
      return parts[parts.length - 1]
    }
    return undefined
  }

  /**
   * Process messages from a subscription and broadcast to SSE.
   */
  private async processSubscription(subject: string, sub: Subscription): Promise<void> {
    try {
      for await (const msg of sub) {
        try {
          const data = this.sc.decode(msg.data)
          const event: NatsTrafficEvent = {
            timestamp: new Date().toISOString(),
            subject: msg.subject,
            data,
            direction: 'inbound',
            sender: this.extractSender(msg.subject),
          }
          this.sse.broadcastEvent('nats_traffic', event)
        } catch (err) {
          log.warn('nats-traffic', `failed to decode message on ${subject}: ${(err as Error).message}`)
        }
      }
    } catch (err) {
      // Subscription ended (possibly due to unsubscribe or disconnect)
      log.info('nats-traffic', `subscription ${subject} ended`)
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.start()
    }, 5000)
  }

  /**
   * Drain the active connection and clear active subscriptions. Does NOT clear
   * `widgetSubscriptions` — that map is the authority for which subjects we
   * need on the next connect, and is preserved across an explicit bounce.
   */
  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const sub of this.activeSubs.values()) {
      sub.unsubscribe()
    }
    this.activeSubs.clear()
    if (this.nc) {
      await this.nc.drain()
      this.nc = null
    }
  }
}
