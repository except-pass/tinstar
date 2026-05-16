import type { Disposable } from '@tinstar/plugin-api'

type Handler = (msg: unknown) => void

/**
 * Bridges the host's SSE stream to plugin event subscribers. One EventSource
 * per EventBridge instance. Subscribers attach to SSE event names exactly
 * (no wildcard matching in V5.0 — exact event names only).
 *
 * Real SSE event names emitted by the host (as of plan 2):
 *   'snapshot', 'delta', 'file_watch', 'nats_traffic',
 *   'telemetry:hud', 'canvas:viewport', 'projects_changed',
 *   'ready_queue_update', 'heartbeat'
 *
 * See src/server/api/sse.ts and src/hooks/useServerEvents.ts for the source
 * of truth on event names.
 */
export class EventBridge {
  private subs = new Map<string, Set<Handler>>()
  private esListeners = new Map<string, (ev: MessageEvent) => void>()
  private es: EventSource | null = null
  private endpoint: string

  constructor(endpoint: string) {
    this.endpoint = endpoint
  }

  subscribe(channel: string, handler: Handler): Disposable {
    if (!this.es) this.openConnection()
    let set = this.subs.get(channel)
    if (!set) {
      set = new Set()
      this.subs.set(channel, set)
      // Register a per-channel EventSource listener the first time anyone subscribes.
      const listener = (ev: MessageEvent) => this.dispatch(channel, ev)
      this.es!.addEventListener(channel, listener as EventListener)
      this.esListeners.set(channel, listener)
    }
    set.add(handler)

    return {
      dispose: () => {
        const s = this.subs.get(channel)
        if (!s) return
        s.delete(handler)
        if (s.size === 0) {
          this.subs.delete(channel)
          const l = this.esListeners.get(channel)
          if (l && this.es) this.es.removeEventListener(channel, l as EventListener)
          this.esListeners.delete(channel)
        }
        if (this.subs.size === 0) this.closeConnection()
      },
    }
  }

  private openConnection() {
    const ES = (globalThis as unknown as { EventSource: new (url: string, init?: EventSourceInit) => EventSource }).EventSource
    this.es = new ES(this.endpoint, { withCredentials: true })
    this.es.addEventListener('error', (ev) => {
      const readyState = this.es?.readyState
      // eslint-disable-next-line no-console
      console.error('[event-bridge] EventSource error', { endpoint: this.endpoint, readyState, ev })
    })
  }

  private closeConnection() {
    if (this.es) { this.es.close(); this.es = null }
    this.esListeners.clear()
  }

  private dispatch(channel: string, ev: MessageEvent) {
    let payload: unknown
    try {
      payload = JSON.parse(ev.data)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[event-bridge] malformed JSON; dropping frame', {
        channel,
        snippet: String(ev.data).slice(0, 200),
        err: e instanceof Error ? e.message : String(e),
      })
      return
    }
    const handlers = this.subs.get(channel)
    if (!handlers) return
    for (const h of handlers) {
      try { h(payload) } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[event-bridge] handler for channel "${channel}" threw`, e)
      }
    }
  }
}
