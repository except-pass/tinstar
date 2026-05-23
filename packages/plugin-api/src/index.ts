import type { ComponentType } from 'react'

/** Resource that can be torn down. Returned from every register() call. */
export interface Disposable {
  dispose(): void
}

/** Props a host passes to every widget component. `T` is the shape of the
 *  widget's `data` payload — typically the plugin's own domain type (e.g.
 *  `WidgetProps<BrowserWidget>`). Defaults to `unknown` for the host registry,
 *  which is type-agnostic across widget kinds. */
export interface WidgetProps<T = unknown> {
  data: T
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

/** Hotkey action dispatch. The host's focus-path router decides which
 *  action strings fire (e.g. `'fit-viewport'`) when bindings activate
 *  while a widget has focus. Plugins react to those actions here. */
export interface PluginHotkeysApi {
  /** Register an action handler for `widgetId`. The returned Disposable
   *  removes the handler when disposed. Two handlers for the same widget
   *  id is a misuse — only the last registration wins. */
  onAction(widgetId: string, handler: (action: string) => void): Disposable
}

/** Canvas integration: zoom/pan operations bound to widget ids. */
export interface PluginCanvasApi {
  /** Zoom and pan the canvas so the given widget fits in the viewport.
   *  No-op if the widget is not currently in the layout. */
  fitWidget(widgetId: string): void
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
  hotkeys: PluginHotkeysApi
  canvas: PluginCanvasApi
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

/**
 * Compile-time constant matching the spec's apiVersion. Use this in your
 * plugin to assert the version it was built against, or as a runtime
 * sanity-check.
 */
export const TINSTAR_API_VERSION = '5' as const

/**
 * Identity helper for type inference of `activate` signatures.
 *
 * @example
 * export default definePlugin({
 *   activate(api) {
 *     return [api.widgets.register({ ... })]
 *   }
 * })
 */
export function definePlugin(p: Plugin): Plugin { return p }
