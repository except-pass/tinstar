import { useSyncExternalStore } from 'react'
import type { TinstarPluginAPI, Disposable, WidgetRegistration, PluginLogger, ConstellationPeer } from '@tinstar/plugin-api'
import type { PluginRecord } from '../pluginHost/registry'
import { registerWidgetComponent } from '../../widgets/widgetComponentRegistry'
import { apiFetch } from '../../apiClient'
import { registerActionHandler, deregisterActionHandler } from '../../hotkeys/actionHandlerRegistry'
import { fitWidgetToViewport } from '../../hotkeys/canvasActionsRegistry'
import { useConstellationContext } from '../../hotkeys/ConstellationContext'
import { ConstellationBadge } from '../../components/ConstellationBadge'
import { useFileWatch } from '../../hooks/useFileWatch'
import { useImageWatch } from '../../hooks/useImageWatch'
import { resolveRunAccent, hexToRgba } from '../../components/runAccent'
import { EventBridge } from './eventBridge'
import { useWidgetId } from './widgetIdContext'
import { capabilityRegistry } from '../constellationCapabilities'

/** Derive a coarse widget "kind" from its full node id. Mirrors the
 *  prefix convention the host uses when constructing TreeNode ids
 *  (see src/domain/grouping.ts and the widget render path). */
function kindOfWidgetId(id: string): string {
  if (id.startsWith('run-')) return 'run'
  if (id.startsWith('editor-')) return 'file-editor'
  if (id.startsWith('browser-')) return 'browser'
  if (id.startsWith('image-')) return 'image'
  if (id.startsWith('nats-')) return 'nats-traffic'
  const dash = id.indexOf('-')
  return dash > 0 ? id.slice(0, dash) : id
}

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

  const constellations = {
    Badge: ConstellationBadge,

    useContext: (): { slotsForNode: (nodeId: string) => string[]; nodesInSlot: (slot: string) => string[] } => {
      const ctx = useConstellationContext()
      return {
        slotsForNode: (nodeId: string) => ctx.slotsForNode(nodeId),
        nodesInSlot: (slot: string) => ctx.nodesInSlot(slot),
      }
    },

    useMyNodeId(): string {
      return useWidgetId()
    },

    useMySlots(): string[] {
      const widgetId = useWidgetId()
      const ctx = useConstellationContext()
      return ctx.slotsForNode(widgetId)
    },

    useMySlot(): number | null {
      const widgetId = useWidgetId()
      const ctx = useConstellationContext()
      const slots = ctx.slotsForNode(widgetId)
      return slots.length > 0 ? Number(slots[0]) : null
    },

    usePeers(): ConstellationPeer[] {
      const widgetId = useWidgetId()
      const ctx = useConstellationContext()

      // Re-render whenever the capability registry changes — the snapshot
      // string is intentionally cheap and order-stable per widget.
      useSyncExternalStore(
        (listener) => capabilityRegistry.subscribe(listener),
        () => {
          const slots = ctx.slotsForNode(widgetId)
          if (slots.length === 0) return ''
          const peers = ctx.nodesInSlot(slots[0]!).filter((id) => id !== widgetId)
          return peers.map((id) => `${id}:${capabilityRegistry.capabilitiesOf(id).join(',')}`).join('|')
        },
        () => '',
      )

      const slots = ctx.slotsForNode(widgetId)
      if (slots.length === 0) return []
      const slot = slots[0]!
      const peerIds = ctx.nodesInSlot(slot).filter((id) => id !== widgetId)
      return peerIds.map((id) => ({
        id,
        kind: kindOfWidgetId(id),
        capabilities: capabilityRegistry.capabilitiesOf(id),
      }))
    },

    usePublishCapability(): (
      name: string,
      handler: (args: unknown) => Promise<unknown>,
    ) => Disposable {
      const widgetId = useWidgetId()
      return (name, handler) => {
        const undo = capabilityRegistry.publish(widgetId, name, handler)
        const d: Disposable = { dispose: undo }
        record.disposables.push(d)
        return d
      }
    },

    useInvokePeerCapability(): (
      peerId: string,
      name: string,
      args: unknown,
    ) => Promise<unknown> {
      const widgetId = useWidgetId()
      const ctx = useConstellationContext()
      return async (peerId, name, args) => {
        const mySlots = ctx.slotsForNode(widgetId)
        const peerSlots = ctx.slotsForNode(peerId)
        const shared = mySlots.find((s) => peerSlots.includes(s))
        if (!shared) throw new Error(`peer ${peerId} is not in the same constellation`)
        return capabilityRegistry.invoke(peerId, name, args)
      }
    },

    useFitToMine(): () => void {
      const widgetId = useWidgetId()
      return () => {
        window.dispatchEvent(new CustomEvent('constellation:fit-mine', { detail: { widgetId } }))
      }
    },
    useTidyMine(): () => void {
      const widgetId = useWidgetId()
      return () => {
        window.dispatchEvent(new CustomEvent('constellation:tidy-mine', { detail: { widgetId } }))
      }
    },
    useAssignToSlot(): (slot: number) => void {
      const widgetId = useWidgetId()
      return (slot) => {
        window.dispatchEvent(new CustomEvent('constellation:assign', { detail: { widgetId, slot } }))
      }
    },
    useLeave(): () => void {
      const widgetId = useWidgetId()
      return () => {
        window.dispatchEvent(new CustomEvent('constellation:leave', { detail: { widgetId } }))
      }
    },
  }

  const watch = {
    file: useFileWatch,
    image: useImageWatch,
  }

  const theme = {
    accent: {
      resolve: resolveRunAccent,
      hexToRgba,
    },
  }

  return {
    pluginId: record.name,
    version: record.version,
    widgets,
    http,
    events,
    hotkeys,
    canvas,
    constellations,
    watch,
    theme,
    logger,
  }
}
