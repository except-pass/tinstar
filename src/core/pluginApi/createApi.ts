import type { TinstarPluginAPI, Disposable, WidgetRegistration, PluginLogger } from '@tinstar/plugin-api'
import type { PluginRecord } from '../pluginHost/registry'
import { registerWidgetComponent } from '../../widgets/widgetComponentRegistry'
import { apiFetch } from '../../apiClient'
import { registerActionHandler, deregisterActionHandler } from '../../hotkeys/actionHandlerRegistry'
import { fitWidgetToViewport } from '../../hotkeys/canvasActionsRegistry'
import { useHotgroupContext } from '../../hotkeys/HotgroupContext'
import { HotgroupBadge } from '../../components/HotgroupBadge'
import { EventBridge } from './eventBridge'

const NOOP_DISPOSABLE: Disposable = { dispose: () => {} }

let sharedBridge: EventBridge | null = null
function getBridge(): EventBridge {
  if (!sharedBridge) sharedBridge = new EventBridge()
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
        const d = registerWidgetComponent(reg)
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

  const hotkeys = {
    onAction(widgetId: string, handler: (action: string) => void): Disposable {
      registerActionHandler(widgetId, handler)
      const d: Disposable = { dispose: () => deregisterActionHandler(widgetId) }
      record.disposables.push(d)
      return d
    },
  }

  const canvas = {
    fitWidget(widgetId: string): void {
      fitWidgetToViewport(widgetId)
    },
  }

  const hotgroups = {
    useContext: (): { slotsForNode: (nodeId: string) => string[]; nodesInSlot: (slot: string) => string[] } => {
      const ctx = useHotgroupContext()
      return {
        slotsForNode: (nodeId: string) => ctx.slotsForNode(nodeId),
        nodesInSlot: (slot: string) => ctx.nodesInSlot(slot as never),
      }
    },
    Badge: HotgroupBadge,
  }

  return {
    pluginId: record.name,
    version: record.version,
    widgets,
    http,
    events,
    hotkeys,
    canvas,
    hotgroups,
    logger,
  }
}
