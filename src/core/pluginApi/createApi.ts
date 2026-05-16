import type { TinstarPluginAPI, Disposable, WidgetRegistration, PluginLogger } from '@tinstar/plugin-api'
import type { PluginRecord } from '../pluginHost/registry'
import { registerWidgetComponent } from '../../widgets/widgetComponentRegistry'
import { apiFetch } from '../../apiClient'
import { EventBridge } from './eventBridge'

const NOOP_DISPOSABLE: Disposable = { dispose: () => {} }

let sharedBridge: EventBridge | null = null
function getBridge(): EventBridge {
  if (!sharedBridge) sharedBridge = new EventBridge('/s/events')
  return sharedBridge
}

function makeLogger(pluginId: string): PluginLogger {
  const prefix = `[${pluginId}]`
  return {
    /* eslint-disable no-console */
    debug: (...args) => console.debug(prefix, ...args),
    info:  (...args) => console.info(prefix, ...args),
    warn:  (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    /* eslint-enable no-console */
  }
}

export function createPluginApi(record: PluginRecord): TinstarPluginAPI {
  const logger = makeLogger(record.name)

  const widgets = {
    register(reg: WidgetRegistration): Disposable {
      try {
        // plugin-api.WidgetRegistration is a subset of widgetComponentRegistry.WidgetRegistration
        // (the registry adds an optional getFrameClass field). Cast is safe widening.
        const d = registerWidgetComponent(reg as Parameters<typeof registerWidgetComponent>[0])
        record.disposables.push(d)
        return d
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // Only the "already registered" throw is recoverable via no-op + warn.
        // Anything else (validation errors, future host-internal failures) must
        // propagate to registry.activate's catch so the plugin is marked failed.
        if (msg.startsWith('Widget type already registered:')) {
          logger.warn(`widgets.register("${reg.type}") rejected: ${msg}`)
          return NOOP_DISPOSABLE
        }
        throw e
      }
    },
  }

  const http = {
    fetch(path: string, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers)
      headers.set('X-Tinstar-Plugin', record.name)
      return apiFetch(path, { ...init, headers })
    },
  }

  const events = {
    subscribe<T = unknown>(channel: string, handler: (msg: T) => void): Disposable {
      const d = getBridge().subscribe(channel, handler as (msg: unknown) => void)
      record.disposables.push(d)
      return d
    },
  }

  return {
    pluginId: record.name,
    version: record.version,
    widgets,
    http,
    events,
    logger,
  }
}
