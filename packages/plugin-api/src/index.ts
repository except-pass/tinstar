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
  /** Declarative capabilities, e.g. 'spawnable' (appears in the add-widget picker),
   *  'web-view', 'session-host'. Drives the grow-constellation affordance. */
  capabilities?: string[]
  /** How an instance is created. 'standalone' → one-shot create endpoint;
   *  'session-backed' → opens the session create flow. Defaults to 'standalone'. */
  creator?: 'standalone' | 'session-backed'
  /** Whether this widget participates in snapping (drag-to-snap, the [+] grow
   *  affordance, snap-on-create). Non-container leaves snap by DEFAULT; set
   *  `false` to opt out. Containers never snap regardless. */
  snappable?: boolean
  /** Free-form descriptive tags, reserved for future ordering/grouping. */
  tags?: string[]
  /** Declares named attachment points in the widget's normalized coord space
   *  (fractions of width/height, both in [0,1]). Validated and stored by the
   *  host; the host currently snaps using the 8 default anchors, so custom sets
   *  are reserved for future use. Omit to use the defaults. */
  anchors?: Array<{ name: string; x: number; y: number }>
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
  /** True when this peer shares a `snapped` edge with the calling widget.
   *  Optional: older V5 hosts predate this field and return `undefined`. */
  snapped?: boolean
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

/** Urgency of a widget's "needs attention" signal. */
export type AttentionLevel = 'urgent' | 'attention' | 'info'

/** A widget's current attention state as exposed to plugins. The host
 *  server-stamps `setAt` when the PATCH lands; plugins read this but
 *  don't construct it themselves. */
export interface AttentionState {
  level: AttentionLevel
  reason: string
  setAt: string
}

/** What plugins pass to setAttention — no setAt; the host stamps it. */
export interface AttentionInput {
  level: AttentionLevel
  reason: string
}

/** Per-widget host services available inside a plugin widget's React
 *  component. All hooks must be called at the top of the component
 *  (standard React rules). They read the host's per-widget context, so
 *  they only work inside a widget the host has mounted via the widget
 *  shell — calling them outside that shell throws. */
export interface PluginWidgetApi {
  /** React hook: returns `[data, setData]` for this widget's
   *  per-instance `data` blob. The setter PATCHes the host with a 250ms
   *  debounce; remote updates (e.g., another tab) re-render the caller
   *  via the host's SSE delta stream. */
  useData<T>(): [T | null, (next: T) => void]
  /** React hook: returns a stable callback that DELETEs this widget
   *  instance from the host. */
  useDelete(): () => Promise<void>
  /** React hook: returns the initial-context blob the spawn drag
   *  carried, or null. In V5.1 always null — reserved for the eventual
   *  `spawn: 'palette+context'` migration. */
  useInitialContext<T>(): T | null
  /** React hook: returns `[attention, setAttention]` for this widget's
   *  current attention signal. Call `setAttention({ level, reason })` to
   *  surface the widget in the Inbox view; pass `null` to clear. Identical
   *  re-sets (same level + reason) are no-ops and do not bump the row to
   *  "unread" again. Auto-purges when the widget instance is deleted. */
  useAttention(): [AttentionState | null, (next: AttentionInput | null) => void]
}

/** Edge a primitive-widget accessory pane is pinned to. */
export type AccessoryPlacement = 'left' | 'right' | 'top' | 'bottom'

/** Author-supplied accessory for a primitive-backed widget. */
export interface PrimitiveAccessory {
  placement: AccessoryPlacement
  /** Plugin React component. Mounted inside the widget shell, so it keeps all
   *  `api.*` hooks AND `api.primitives.useBrowser()` / `useTerminal()`. */
  component: ComponentType
  /** Fixed cross-axis size of the pane in px (width for left/right, height for
   *  top/bottom). Defaults to 220. */
  size?: number
}

/** Live handle to the embedded browser, read by the accessory via useBrowser(). */
export interface BrowserHandle {
  url: string
  navigate(url: string): void
  reload(): void
  /** Fires whenever the URL changes (user navigation or programmatic). */
  onUrlChange(cb: (url: string) => void): Disposable
}

/** Live handle to the embedded terminal, read by the accessory via useTerminal().
 *  Unlike BrowserHandle (whose url changes as the user navigates), `sessionId` is
 *  fixed for the widget's lifetime, so there is no change subscription. */
export interface TerminalHandle {
  sessionId: string
  focus(): void
  /** Type literal text into the session. `enter` (default true) submits with Enter. */
  sendText(text: string, opts?: { enter?: boolean }): Promise<void>
  /** Send raw/named keys (e.g. ['Up'], ['C-c'], ['Enter']) to drive a TUI. */
  sendKeys(keys: string[]): Promise<void>
  /** Snapshot the rendered terminal screen (optionally including scrollback lines). */
  readScreen(opts?: { scrollback?: number }): Promise<string>
  /** Run a one-shot command (argv, no shell) in the session's working dir. */
  exec(argv: string[]): Promise<{ stdout: string; stderr: string; code: number }>
}

export interface RegisterBrowserWidgetOptions {
  type: string
  accessory?: PrimitiveAccessory
  defaultUrl?: string
  defaultSize?: { width: number; height: number }
  minSize?: { width: number; height: number }
}

export interface RegisterTerminalWidgetOptions {
  type: string
  accessory?: PrimitiveAccessory
  /** Initial session id for the embedded terminal. The plugin may instead (or
   *  later) persist `sessionId` into the widget's `data` blob; widget data wins. */
  defaultSessionId?: string
  defaultSize?: { width: number; height: number }
  minSize?: { width: number; height: number }
  /** Mark this terminal widget as a session-view: its canvas node IS a session's
   *  run node (run.view). 'session-backed' lists it in the palette, routes spawn
   *  through the session-create flow, and renders it at the run node. Default 'standalone'. */
  creator?: 'standalone' | 'session-backed'
}

/** Embeddable browser/terminal primitives for plugin authors. The host owns the
 *  primitive (chrome, proxy, tty); the plugin owns the edge-pinned accessory. */
export interface PluginPrimitivesApi {
  /** Register a widget whose main content is a browser primitive. */
  registerBrowserWidget(opts: RegisterBrowserWidgetOptions): Disposable
  /** Register a widget whose main content is a terminal primitive. The session is
   *  resolved from the widget's `data.sessionId` (or `opts.defaultSessionId`); the
   *  plugin is responsible for putting a session id there. */
  registerTerminalWidget(opts: RegisterTerminalWidgetOptions): Disposable
  /** React hook (call inside an accessory component): the live browser handle.
   *  Throws if called outside a browser-primitive widget. */
  useBrowser(): BrowserHandle
  /** React hook (call inside an accessory component): the live terminal handle.
   *  Throws if called outside a terminal-primitive widget. */
  useTerminal(): TerminalHandle
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
  widget: PluginWidgetApi
  primitives: PluginPrimitivesApi
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
      /** Free-form description shown in the WIDGETS palette. */
      description?: string
      /** Path to an SVG icon, relative to the plugin's package.json. */
      icon?: string
      /** If true, host rejects spawning a second instance per space. */
      singleton?: boolean
      /** 'palette' (default) — draggable in the WIDGETS sidebar.
       *  'palette+context' — reserved for entity-drag shortcuts; in V5.1
       *  the palette entry renders greyed and non-draggable. */
      spawn?: 'palette' | 'palette+context'
      capabilities?: string[]
      creator?: 'standalone' | 'session-backed'
      /** Whether this widget participates in snapping. Non-container leaves snap
       *  by DEFAULT; set `false` to opt out. Containers never snap regardless. */
      snappable?: boolean
      tags?: string[]
      /** When set, this widget is primitive-backed: the plugin registers it via
       *  api.primitives.register{Browser,Terminal}Widget rather than api.widgets.register. */
      primitive?: 'browser' | 'terminal'
      /** Declares named attachment points in the widget's normalized coord space
       *  (fractions of width/height, both in [0,1]). Validated and stored by the
       *  host; the host currently snaps using the 8 default anchors, so custom sets
       *  are reserved for future use. Omit to use the defaults. */
      anchors?: Array<{ name: string; x: number; y: number }>
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
