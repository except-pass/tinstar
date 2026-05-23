import type { Disposable } from '@tinstar/plugin-api'
import { subscribeToChannel } from '../../hooks/useServerEvents'

type Handler = (msg: unknown) => void

/**
 * Plugin-facing wrapper around the host's singleton SSE stream. Subscribers
 * attach to SSE event names exactly (no wildcard matching in V5.0).
 *
 * Real SSE event names emitted by the host:
 *   'snapshot', 'delta', 'file_watch', 'nats_traffic',
 *   'telemetry:hud', 'canvas:viewport', 'projects_changed',
 *   'ready_queue_update', 'heartbeat'
 *
 * Before V5.0 each EventBridge instance opened its own EventSource — every
 * plugin contributed to the browser's 6-connection HTTP/1.1 cap, which the
 * React app's singleton was already hitting. This wrapper now routes every
 * subscription through the single shared connection in useServerEvents.
 */
export class EventBridge {
  subscribe(channel: string, handler: Handler): Disposable {
    const unsubscribe = subscribeToChannel(channel, handler)
    return { dispose: unsubscribe }
  }
}
