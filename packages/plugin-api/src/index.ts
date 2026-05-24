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

/** Live file/image observation. Wrappers over the host's file-watch SSE
 *  channel. Plugin traffic from these hooks is not currently tagged with
 *  `X-Tinstar-Plugin` (the hooks call apiFetch directly); acceptable because
 *  they're observation, not state mutation. */
export interface PluginWatchApi {
  /** React hook: subscribes to file content updates for a workspace path.
   *  The host's file watcher pushes updates via SSE; this hook surfaces
   *  the current content and connection state. */
  file(sessionId: string, filePath: string): {
    content: string | null
    connected: boolean
    lastUpdatedAt: Date | null
  }
  /** React hook: subscribes to image-change notifications (no payload). */
  image(sessionId: string, filePath: string): {
    connected: boolean
    lastUpdatedAt: Date | null
  }
}

/** Accent color helpers (normalize + alpha blend). Mirrors the host's
 *  `runAccent` utility used to style widget chrome by run color. */
export interface PluginThemeApi {
  accent: {
    /** Normalize a color string to the default accent if missing/invalid. */
    resolve(color?: string): string
    /** Convert a hex color (with default fallback if invalid) to rgba(). */
    hexToRgba(hex: string, alpha: number): string
  }
}

/** A peer widget discovered in the same constellation. */
export interface ConstellationPeer {
  /** The peer widget's full node id (e.g. `editor-abc`, `run-R-241`). */
  id: string
  /** Coarse-grained widget kind, derived from the id prefix
   *  (`run`, `file-editor`, `browser`, `image`, `nats-traffic`, …). */
  kind: string
  /** Names of capabilities the peer has currently published. */
  capabilities: string[]
}

/** Constellation (keyboard slot) integration: read which slots a widget belongs to,
 *  discover peers, publish/invoke capabilities, and trigger host actions
 *  (fit / tidy / assign / leave) scoped to "this widget". */
export interface PluginConstellationsApi {
  /** React hook: read which keyboard constellation slots a node belongs to and
   *  which nodes are in a slot. Must be called from inside a host
   *  ConstellationProvider — the host wraps the canvas in this provider, so any
   *  widget component rendered inside the canvas is safe. */
  useContext(): {
    slotsForNode: (nodeId: string) => string[]
    nodesInSlot: (slot: string) => string[]
  }
  /** Renders the `⌨ 1 3 5` chip. Empty slot list renders nothing. The optional
   *  `onLeave` callback is invoked when the user clicks a slot chip to remove
   *  the widget from that slot. */
  Badge: ComponentType<{ slots: string[]; testId?: string; onLeave?: (slot: string) => void }>

  /** React hook: returns this widget's full host node id (e.g. `editor-abc`,
   *  `run-R-241`). Throws if called outside a host widget shell — plugin
   *  widgets are always wrapped, so this is safe from any component the
   *  plugin renders inside its widget. */
  useMyNodeId(): string

  /** React hook: returns the slots (as the underlying host string keys
   *  '1'..'9') this widget is assigned to. Empty array if not in any
   *  constellation. Useful for rendering `<Badge slots={...} />`. */
  useMySlots(): string[]

  /** React hook: returns the host widget's primary constellation slot as a
   *  number (1–9), or null if the widget is not assigned to any slot. */
  useMySlot(): number | null

  /** React hook: returns the peers sharing my constellation, with their
   *  currently-published capabilities. Re-renders whenever the capability
   *  registry changes. */
  usePeers(): ConstellationPeer[]

  /** React hook: returns a `publish(name, handler)` function bound to the
   *  current widget. Typical usage:
   *  ```ts
   *  const publish = api.constellations.usePublishCapability()
   *  useEffect(() => publish('file.path', async () => path).dispose, [path])
   *  ```
   */
  usePublishCapability(): (
    name: string,
    handler: (args: unknown) => Promise<unknown>,
  ) => Disposable

  /** React hook: returns an `invoke(peerId, name, args)` function bound to
   *  the current widget. The returned promise rejects if the peer is not in
   *  the same constellation, or if the peer hasn't published the capability.
   *  The function is safe to call from event handlers. */
  useInvokePeerCapability(): (
    peerId: string,
    name: string,
    args: unknown,
  ) => Promise<unknown>

  /** React hook: returns a `fit()` function that fits the canvas viewport
   *  to this widget's constellation. No-op if not in a constellation. */
  useFitToMine(): () => void

  /** React hook: returns a `tidy()` function that tidy-arranges this
   *  widget's constellation into a grid. No-op if not in a constellation. */
  useTidyMine(): () => void

  /** React hook: returns an `assign(slot)` function that assigns this widget
   *  to the given constellation slot (1–9). */
  useAssignToSlot(): (slot: number) => void

  /** React hook: returns a `leave()` function that removes this widget from
   *  its constellation. No-op if not in a constellation. */
  useLeave(): () => void
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
  constellations: PluginConstellationsApi
  watch: PluginWatchApi
  theme: PluginThemeApi
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
