import type { ComponentType } from 'react'

/** Resource that can be torn down. Returned from every register() call. */
export interface Disposable {
  dispose(): void
}

/** Props a host passes to every widget component. */
export interface WidgetProps {
  data: unknown
  zoom: number
  isSelected: boolean
  isDragging: boolean
  isHovered: boolean
  isDropTarget: boolean
}

/** State a widget frame's chrome can react to (used by getFrameClass). */
export interface WidgetFrameState {
  isDragging: boolean
  isSelected: boolean
  isHovered: boolean
  isDropTarget: boolean
}

/**
 * Describes a widget type a plugin contributes — the component, sizing, and
 * behavior the host uses to render it on the canvas.
 */
export interface WidgetRegistration {
  type: string
  component: ComponentType<WidgetProps>
  isContainer: boolean
  defaultSize?: { width: number; height: number }
  minSize: { width: number; height: number }
  dragHandleSelector?: string
  /** Optional function returning CSS class names for the widget's outer frame, given the current chrome state. */
  getFrameClass?: (state: WidgetFrameState) => string
  supportsMinimize?: boolean
}

export interface PluginLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** HTTP helper that goes through tinstar's auth context. Relative paths only. */
export interface PluginHttpApi {
  fetch(path: string, init?: RequestInit): Promise<Response>
}

/** SSE event names emitted by the host. Subscribe by exact name; wildcards
 * are not supported in v5.0.
 *
 * Known channels: 'snapshot', 'delta', 'file_watch', 'nats_traffic',
 * 'telemetry:hud', 'canvas:viewport', 'projects_changed',
 * 'ready_queue_update', 'heartbeat'.
 *
 * Subscribe before app boot is fully ready (the bridge connects lazily and
 * the host's SSE stream replays the latest snapshot on connect).
 */
export type EventChannel = string

/** Payload shape is channel-dependent; plugins cast to the type they expect. */
export interface PluginEventsApi {
  subscribe<T = unknown>(channel: EventChannel, handler: (msg: T) => void): Disposable
}

/** Surface handed to plugins in activate(api). V5.0 minimum surface. */
export interface TinstarPluginAPI {
  readonly pluginId: string
  /** The plugin's own version, copied from its package.json at activation time. */
  readonly version: string
  widgets: {
    register(reg: WidgetRegistration): Disposable
  }
  http: PluginHttpApi
  events: PluginEventsApi
  logger: PluginLogger
}

/** The shape of a plugin module's default export (or named `activate` export).
 *
 * `activate` may be synchronous (returns `Disposable[] | void`) or asynchronous
 * (returns a `Promise`). The host awaits the result before marking the plugin active,
 * so async setup (e.g. dynamic imports, deferred fetches) is fully supported.
 */
export interface Plugin {
  activate(api: TinstarPluginAPI): Disposable[] | void | Promise<Disposable[] | void>
}

/** Manifest stored under `tinstar` in a plugin's package.json. */
export interface PluginManifest {
  apiVersion: '5'
  displayName: string
  description?: string
  icon?: string
  contributes?: {
    widgets?: Array<{
      type: string
      label: string
      defaultSize?: { width: number; height: number }
    }>
  }
  permissions?: string[]
}
