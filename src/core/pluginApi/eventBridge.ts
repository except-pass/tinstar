import type { Disposable } from '@tinstar/plugin-api'

type Handler = (msg: unknown) => void

/**
 * Bridges the host's SSE stream to plugin event subscribers. One ES per
 * EventBridge instance; channels matched by suffix-wildcard (`foo.*`) or
 * exact (`foo.bar`). All matching channels fire (multi-cast).
 */
export class EventBridge {
  private subs = new Map<string, Set<Handler>>()
  private es: EventSource | null = null
  private endpoint: string

  constructor(endpoint: string) {
    this.endpoint = endpoint
  }

  subscribe(channel: string, handler: Handler): Disposable {
    if (!this.es) this.openConnection()
    let set = this.subs.get(channel)
    if (!set) { set = new Set(); this.subs.set(channel, set) }
    set.add(handler)

    return {
      dispose: () => {
        const s = this.subs.get(channel)
        if (!s) return
        s.delete(handler)
        if (s.size === 0) this.subs.delete(channel)
        if (this.subs.size === 0) this.closeConnection()
      },
    }
  }

  private openConnection() {
    const ES = (globalThis as unknown as { EventSource: new (url: string) => EventSource }).EventSource
    this.es = new ES(this.endpoint)
    this.es.addEventListener('message', (ev) => this.routeRaw((ev as MessageEvent).data))
  }

  private closeConnection() {
    if (this.es) { this.es.close(); this.es = null }
  }

  private routeRaw(raw: string) {
    let parsed: { type?: string } & Record<string, unknown>
    try { parsed = JSON.parse(raw) } catch { return }
    const type = parsed.type
    if (typeof type !== 'string') return
    for (const [channel, handlers] of this.subs) {
      if (this.channelMatches(channel, type)) {
        for (const h of handlers) {
          try { h(parsed) } catch (e) {
            // eslint-disable-next-line no-console
            console.error(`[event-bridge] handler for channel "${channel}" threw`, e)
          }
        }
      }
    }
  }

  private channelMatches(channel: string, eventType: string): boolean {
    if (channel === eventType) return true
    if (channel.endsWith('*')) {
      const prefix = channel.slice(0, -1)
      return eventType.startsWith(prefix)
    }
    return false
  }
}
