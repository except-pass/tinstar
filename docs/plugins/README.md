# Plugin System

Tinstar's V5 plugin system lets sibling projects (and you) extend the canvas with new widgets, panes, and commands without forking core. Built-in widgets ship as bundled plugins through the same API external plugins use — there's no first/second class tier.

This doc is the canonical reference. Author guides:
- **Bundled (in-repo) plugin** → [`bundled-howto.md`](bundled-howto.md)
- **External (own repo) plugin** → [`external-quickstart.md`](external-quickstart.md)
- **npm consumers** → [`packages/plugin-api/README.md`](../../packages/plugin-api/README.md)

---

## Overview

A plugin is a JS module that exports an `activate(api)` function. At app boot, the host:

1. Reads `~/.config/tinstar/plugins.json` for the user's enable/disable list and external plugin entries.
2. Iterates bundled plugins (statically known at build time) plus external plugins (dynamically imported from local folders).
3. For each plugin: parses its manifest (a `tinstar` block in the plugin's `package.json`), checks `apiVersion`, builds a per-plugin `TinstarPluginAPI` instance, and calls `activate(api)`.
4. The plugin registers widgets/panes/commands. Returned `Disposable[]` is held by the registry for teardown.

Trusted in-process model: plugins share the host's React instance, have full DOM/network access, and run in the same realm as core. No sandbox in V5.0 — the motivation is composing sibling projects you trust, not hosting third-party code.

---

## Architecture

```
┌────────────────────────── Tinstar app ──────────────────────────┐
│                                                                  │
│  ┌─ Core (saloon, minimap, run-workspace, hierarchy sidebar) ─┐ │
│  │   - canvas + chrome + session backend + event bus          │ │
│  │   - exposes TinstarPluginAPI (per-plugin instance)         │ │
│  └────────────────────────────────────────────────────────────┘ │
│                            ▲                                     │
│                            │ activate(api)                       │
│         ┌──────────────────┼─────────────────────┐               │
│         │                  │                     │               │
│  ┌──────┴───────┐   ┌──────┴────────┐   ┌────────┴────────┐      │
│  │ bundled      │   │ bundled       │   │ external        │      │
│  │ browser-     │   │ nats-traffic  │   │ papershore      │      │
│  │ widget       │   │ file-editor   │   │ (npm / local fs)│      │
│  │ (in repo)    │   │ image-viewer  │   │                 │      │
│  └──────────────┘   └───────────────┘   └─────────────────┘      │
│                                                                  │
│   Same API surface for all three. Built-in vs external is a     │
│   loading-time distinction, not an API distinction.             │
└──────────────────────────────────────────────────────────────────┘
```

**Three pieces:**

- **Host** (`src/core/pluginHost/`, `src/core/pluginApi/`): keeps a `PluginRegistry`, exposes the API singleton per plugin, owns the canvas, session backend, and event bus. Saloon, minimap, run-workspace, and hierarchy sidebar are core — they don't go through the plugin API.
- **Plugin**: a package with a `tinstar` manifest field and an entry exporting `activate(api)`. Same shape for bundled and external.
- **Loader** (`src/core/pluginHost/loader.ts`): the boot pipeline. Reads config, validates manifests, calls `activate`, captures disposables. Continues past individual failures.

**Key paths:**

| Concern | File |
|---|---|
| Public types | `packages/plugin-api/src/index.ts` |
| Registry + lifecycle | `src/core/pluginHost/registry.ts` |
| Manifest parser | `src/core/pluginHost/manifest.ts` |
| Boot loader | `src/core/pluginHost/loader.ts` |
| Bundled plugin index | `src/core/pluginHost/bundled.ts` |
| External loader | `src/core/pluginHost/externalLoader.ts` |
| `plugins.json` reader/writer | `src/core/pluginHost/pluginsConfig.ts`, `writePluginsConfig.ts` |
| Per-plugin API factory | `src/core/pluginApi/createApi.ts` |
| SSE event bridge | `src/core/pluginApi/eventBridge.ts` |
| Client config helper | `src/core/pluginApi/pluginsConfigClient.ts` |
| Bundled plugin packages | `src/plugins/<name>/` |
| Server runtime route | `src/server/api/pluginRuntime.ts` |
| Server config route | `src/server/api/pluginsConfigRoute.ts` |
| Settings UI | `src/components/Settings/PluginsTab.tsx` |
| Failed banner | `src/components/PluginFailedBanner.tsx` |

---

## Plugin manifest

Lives in the plugin's `package.json` under a `tinstar` field. The host reads it before loading the entry, so the settings UI can enumerate what a plugin contributes even when it's disabled.

```jsonc
{
  "name": "papershore",
  "version": "0.3.0",
  "main": "dist/tinstar-plugin.js",
  "tinstar": {
    "apiVersion": "5",
    "displayName": "Papershore",
    "description": "Boards + cards on the canvas",
    "icon": "./icon.svg",
    "contributes": {
      "widgets": [
        { "type": "papershore-board", "label": "Board",
          "defaultSize": { "width": 400, "height": 320 } }
      ]
    },
    "permissions": ["sessions:read", "tasks:read", "nats:subscribe"]
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `apiVersion` | yes | Must equal `"5"`. Host hard-rejects mismatch with a clear error. Bumped only on breaking changes. |
| `displayName` | yes | Non-empty string. Shown in Settings → Plugins. |
| `description` | no | Free-form text shown in settings UI. |
| `icon` | no | Relative path to an SVG. Falls back to first letter of displayName. |
| `contributes.widgets` | no | Array of widget entries. Declarative — runtime registration in `activate()` is what actually works; this is for settings UI. |
| `permissions` | no | Free-form string array; not currently enforced (trusted model). Declared so settings UI can surface intent ("plugin will subscribe to NATS"). |

Each `widgets[]` entry accepts:

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | yes | Unique widget type identifier — passed to `api.widgets.register({ type, ... })` from your plugin's `activate(api)`. |
| `label` | string | yes | Display label shown in the WIDGETS palette. |
| `defaultSize` | `{ width, height }` | no | Initial canvas size. Defaults to `360 × 280`. |
| `description` | string | no | Short description shown in the palette under the label. |
| `icon` | string | no | Path to an SVG icon, relative to your plugin's `package.json`. |
| `singleton` | boolean | no | If `true`, the host rejects spawning a second instance per space. |
| `spawn` | `'palette' \| 'palette+context'` | no | Default `'palette'`. `'palette+context'` is reserved for entity-drag shortcuts in V5.2+; entries currently render greyed and non-draggable in the palette. |
| `snappable` | boolean | no | Whether the widget participates in canvas snapping (drag-to-snap, the `[+]` grow affordance, snap-on-create). Non-container leaf widgets snap by default; set `false` to opt out. Containers never snap. |
| `anchors` | `Array<{ name: string; x: number; y: number }>` | no | Named attachment points used for anchor snapping. `x` and `y` are fractions of the widget's width/height in `[0, 1]`. Omit to use the 8 defaults. Only relevant when `snappable` is `true` (or implicitly true). See [Anchor points](#anchor-points) below. |

If `activate()` registers a widget type not in the manifest, the host logs a warning and accepts it. If the manifest declares one not actually registered at runtime, the host quietly drops the stale entry.

### Anchor points

Anchor points are the named snap-attachment sites on a widget. When a user drags one snappable widget near another the host aligns the closest pair of anchor points; the `attach` spawn parameter (see [`Spawning with attach`](../agent-api.md#spawning-with-attach) in the agent API) lets agents name the exact pair to use.

**Default anchors (used when `anchors` is omitted):**

| Name | Position |
|---|---|
| `top-left` | top-left corner |
| `top-center` | top edge, horizontal center |
| `top-right` | top-right corner |
| `middle-left` | left edge, vertical center |
| `middle-right` | right edge, vertical center |
| `bottom-left` | bottom-left corner |
| `bottom-center` | bottom edge, horizontal center |
| `bottom-right` | bottom-right corner |

There is no center anchor by default.

**Declaring a custom anchor set** lets you name the attachment points that make sense for your widget's geometry — e.g. a timeline widget that should snap to an exact tick mark, or a widget with an asymmetric header. Declare them in the manifest:

```jsonc
{
  "tinstar": {
    "contributes": {
      "widgets": [
        {
          "type": "my-timeline",
          "label": "Timeline",
          "snappable": true,
          "anchors": [
            { "name": "header-right",  "x": 1.0, "y": 0.08 },
            { "name": "header-left",   "x": 0.0, "y": 0.08 },
            { "name": "bottom-center", "x": 0.5, "y": 1.0  }
          ]
        }
      ]
    }
  }
}
```

`x` and `y` are fractions of the widget's rendered width/height, both in `[0, 1]`. `(0, 0)` is the top-left corner; `(1, 1)` is the bottom-right.

A declared `anchors` array replaces the full default set — the 8 defaults are not merged in. Anchor `name` values are arbitrary strings; they must be unique within the widget type and non-empty.

> **Note:** Custom anchor sets are validated and stored by the host, but are **not yet honored** by drag-to-snap or the `attach` spawn parameter — both currently operate on the 8 default anchors. Custom declarations are forward-looking; this is reserved for a future release.

---

## TinstarPluginAPI

What the plugin receives in `activate(api)`. Every method scoped to the calling plugin: registrations are tracked on the plugin's record so they can be torn down on deactivate; the logger prefixes output with `[<pluginId>]`; `http.fetch` adds an identifying header.

```ts
interface TinstarPluginAPI {
  readonly pluginId: string         // matches name in package.json
  readonly version: string          // matches version in package.json

  widgets: {
    register(reg: WidgetRegistration): Disposable
  }

  http: {
    fetch(path: string, init?: RequestInit): Promise<Response>
    //   path is relative to tinstar's server origin; auth handled by host;
    //   auto-adds 'X-Tinstar-Plugin: <pluginId>' header
  }

  events: {
    subscribe<T = unknown>(channel: EventChannel, handler: (msg: T) => void): Disposable
    //   channel is an exact SSE event name (no wildcards in V5.0)
  }

  logger: {
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
}
```

### `widgets.register`

Registers a widget type the canvas can instantiate. Returns a `Disposable`; calling `dispose()` removes the type from the registry (and renders an "unavailable" placeholder for any widgets the user already dropped on the canvas).

```ts
api.widgets.register({
  type: 'my-widget',                          // unique; conventionally prefixed with plugin name
  component: MyComponent,                     // React component accepting WidgetProps
  isContainer: false,                         // does this widget visually contain other widgets?
  defaultSize: { width: 400, height: 300 },   // optional; used when first dropped
  minSize: { width: 200, height: 100 },       // required; canvas-enforced floor
  dragHandleSelector: '.widget-drag-handle',  // optional; default is the whole widget
  supportsMinimize: false,                    // optional; default false
  getFrameClass: ({ isSelected, isDragging }) => {
    // optional; return CSS classes for the outer frame
    if (isDragging) return 'widget-run-dragging'
    if (isSelected) return 'widget-run-selected'
    return ''
  },
})
```

**Errors:** if another plugin already registered the same `type`, the host logs `widgets.register("<type>") rejected: Widget type already registered` and returns a no-op `Disposable`. `activate()` continues — the rest of the plugin's registrations are not affected. Any *other* error from the internal registry (validation, etc.) is rethrown so the registry marks the plugin failed.

### `http.fetch`

```ts
const r = await api.http.fetch('/api/state')
const sessions = await r.json()
```

Thin wrapper over the existing `apiFetch`. Use **relative paths** — the host resolves to the server's origin (which is the dev server in dev, the standalone in prod). Adds `X-Tinstar-Plugin: <pluginId>` to every request for server-log traceability.

**Errors:** the underlying `fetch` rejection propagates to the caller. The wrapper does not catch — plugins handle their own request errors. `new Headers(invalid)` will throw synchronously on bad header inputs.

### `events.subscribe`

Subscribes to host SSE events. One shared `EventSource` per app process — plugins do not each open their own connection.

```ts
api.events.subscribe('nats_traffic', (msg) => {
  api.logger.info('NATS message', msg)
})
```

**Known channels (V5.0):**

| Channel | Payload | When |
|---|---|---|
| `snapshot` | Full workspace state | On connect, after replays |
| `delta` | Incremental state diff | Whenever server state changes |
| `nats_traffic` | NATS message envelope | Every NATS broker message |
| `file_watch` | `{ path, kind }` | File system changes in watched dirs |
| `telemetry:hud` | HUD telemetry snapshot | Periodic |
| `canvas:viewport` | `{ zoom, pan }` | Canvas pan/zoom events |
| `projects_changed` | Project list | Project add/remove |
| `ready_queue_update` | Queue snapshot | When ready queue changes |
| `heartbeat` | empty | Periodic, keep-alive |

Subscribe by **exact channel name**. Wildcards (`'nats.*'`) are not supported in V5.0 — see source of truth in `src/server/api/sse.ts`.

**Errors:**
- Malformed JSON in an SSE frame: dropped silently after `console.warn` with a snippet of the bad data.
- Handler throws: caught + logged as `[event-bridge] handler for channel "<channel>" threw`; other handlers on the same channel still fire.
- EventSource transport error (server restart, network loss): logged as `[event-bridge] EventSource error` with endpoint + readyState. The browser auto-retries connection.

### `logger`

```ts
api.logger.info('activating')              // → console.info('[my-plugin]', 'activating')
api.logger.error('oh no', { detail: 42 })  // → console.error('[my-plugin]', 'oh no', { detail: 42 })
```

`(...args: unknown[]) => void` — same shape as `console.*`. Pure pass-through after the pluginId prefix. Browser devtools object inspection still works because args are forwarded as-is, not stringified.

### Shipped in V5.0

Beyond `widgets`, `http`, `events`, and `logger`, these surfaces are live and usable today:

- `api.canvas.fitWidget(widgetId)` — zoom/pan the canvas to frame a specific widget.
- `api.hotkeys.onAction(widgetId, handler): Disposable` — handle hotkey action strings when a widget has focus.
- `api.theme.accent.{resolve,hexToRgba}` — accent-color utilities matching host chrome.
- `api.watch.file(sessionId, filePath)` — React hook: live file content over the host's SSE file-watcher.
- `api.watch.image(sessionId, filePath)` — React hook: image-change notifications.
- `api.widget.useData<T>()` — React hook returning `[data, setData]` for this widget instance's persistent state. The setter debounces 250ms and PATCHes the host; SSE deltas keep the value fresh across tabs.
- `api.widget.useDelete()` — returns a stable callback that DELETEs this widget's instance.
- `api.widget.useInitialContext<T>()` — returns the spawn-drag context blob, or `null` for palette spawns. Reserved for `spawn: 'palette+context'` in V5.2+; always `null` in V5.1.
- `api.widget.useAttention()` — React hook returning `[attention, setAttention]` for this widget's current attention signal. Plugins call `setAttention({ level, reason })` to surface the widget in the workspace **Inbox** view; pass `null` to clear. `level` is `'urgent' | 'attention' | 'info'`. `reason` is a short headline (≈80 chars; longer is truncated by the UI). The host server-stamps `setAt`. Identical re-sets (same level + reason) are no-ops and do not bump the row back to "unread". Attention is auto-purged when the widget instance is deleted.

  ```tsx
  function MyWidget() {
    const [, setAttention] = api.widget.useAttention()
    // when something needs the user's eyes:
    setAttention({ level: 'urgent', reason: 'Build failed: 3 tests red' })
    // when resolved:
    setAttention(null)
  }
  ```
- `api.constellations` — peer discovery, capability publish/invoke, slot membership, and arrange actions. See [Constellations & capabilities](#constellations--capabilities) below.
- `api.primitives.registerTerminalWidget(opts)` / `registerBrowserWidget(opts)` — register a widget whose main content is a host-owned terminal (tmux/ttyd) or browser primitive, with an optional edge-pinned `accessory` React pane.
- `api.primitives.useTerminal()` — React hook (call inside a terminal-primitive accessory): the live `TerminalHandle` for driving and observing the session. Imperative methods (safe from event handlers):
  - `sendText(text, { enter? })` — type text into the session; `enter` (default `true`) submits. Backed by `POST /api/sessions/:name/enter-prompt` (or `/send-keys` when `enter: false`).
  - `sendKeys(keys[])` — send raw/named keys (`['Up']`, `['C-c']`, `['Enter']`) to drive a TUI. Backed by `POST /api/sessions/:name/send-keys`.
  - `readScreen({ scrollback? })` — snapshot the rendered terminal screen. Backed by `GET /api/sessions/:name/screen`.
  - `exec(argv[]): Promise<{ stdout, stderr, code }>` — run a one-shot command (argv array, no shell) in the **session's working directory** and get structured output. A non-zero exit resolves with `code` set (callers branch on it); spawn failure/timeout rejects. Backed by `POST /api/sessions/:name/exec`. Because it runs in the session cwd, it is automatically scoped to that worktree's repo/branch — e.g. `exec(['roborev','list','--json'])`. Bundled/trusted-plugin scoped; no broader than the existing send-keys input surface.

### Session-view widgets

A terminal widget registered with `creator: 'session-backed'` is a **session-view**: its canvas node IS the session's run node — there is exactly one node per session, not a separate run-workspace alongside it. The run's `view` field stores the plugin widget type, and `renderNode` uses it to select which component renders the run.

**Spawning:** dragging a session-view widget from the palette opens the normal session-create flow. The created run gets `view = <widget type>`, and the canvas renders that plugin widget at the run node's position. No duplicate run-workspace is created.

**Inside a session-view component:**
- `api.primitives.useTerminal()` resolves the run's session automatically — the host injects `sessionId` into the component's `data` at render time; the plugin does not manage it.
- `api.widget.useData<T>()` reads and writes `run.viewData` (via `PATCH /api/runs/:id`, debounced 250 ms) instead of the per-instance plugin-widget store. This means the state persists on the run, survives tab reloads, and round-trips through SSE deltas like any other run field.

**Fallback safety:** `run-workspace` is the default session-view. If `run.view` names a plugin type that is not registered (e.g. the plugin is disabled), `resolveRunViewType` falls back to `run-workspace` so the session is always reachable on the canvas.

**Reference implementation:** `src/plugins/roborev/src/index.tsx` — the roborev cockpit is the first session-view. It registers as `creator: 'session-backed'`, reads its `launched` flag from `run.viewData` via `useData`, and gets its session from `useTerminal()`.

### Still future (V5.1)

These are deferred. If you need them today, drop a note — they're scoped, not blocked:

- `api.commands.register` — register commands + hotkeys
- `api.storage.{get,set}` — plugin-scoped server-backed storage
- `api.panes.register` — pane-shaped chrome contributions
- React hooks layer (`useSessions`, `useTask`, `useTelemetrySeries`, `useViewport`, `useNats`, `useSelection`)

---

## Constellations & capabilities

A constellation is a cluster of widgets that share a numbered slot (1–9), move together on the canvas, and can discover and RPC into each other through the capability system. Constellations are the primary composition primitive in V5.0: the way a plugin widget finds and talks to the session, file-editor, or other plugin widget it's sitting next to.

For the full narrative, worked examples, and failure-mode reference, see [`docs/plugins/constellations-and-capabilities.md`](constellations-and-capabilities.md).

### Reading your own membership

All `useX()` factories on `api.constellations` are React hooks — call them at component render top-level, not inside event handlers or effects. The closures they return (e.g. `fit()`, `publish()`, `invoke()`) are stable and safe to call from anywhere.

```tsx
function MyWidget() {
  const slot  = api.constellations.useMySlot()    // number | null
  const slots = api.constellations.useMySlots()   // string[] e.g. ['3']
  const id    = api.constellations.useMyNodeId()  // e.g. 'my-widget-abc'

  return <div>{slot !== null ? `Slot ${slot}` : 'Not in a constellation'}</div>
}
```

Use the `Badge` component to render the `⌨ 3` chip that users click to leave a slot:

```tsx
function MyWidget() {
  const slots  = api.constellations.useMySlots()
  const leave  = api.constellations.useLeave()
  const { slotsForNode } = api.constellations.useContext()

  return (
    <api.constellations.Badge
      slots={slotsForNode(myNodeId)}
      onLeave={(_slot) => leave()}
    />
  )
}
```

`useContext()` and `Badge` also exist for backward compatibility with pre-V5 `api.hotgroups.*` usage — they are available under `api.constellations.*` with the same signatures.

### Discovering peers

```tsx
const peers = api.constellations.usePeers()
// peers: Array<{ id: string; kind: string; capabilities: string[] }>
```

`usePeers()` returns peers in the same constellation (excluding the calling widget). It re-renders whenever membership or the capability registry changes. If the widget is not in any constellation, it returns `[]`.

### Publishing a capability

```tsx
const publish = api.constellations.usePublishCapability()

useEffect(() => {
  return publish('my.capability', async (args) => {
    // args is whatever the invoker passed
    return 'result'
  }).dispose
}, [publish])
```

Call `publish` inside a `useEffect`. Return `.dispose` as the cleanup so the capability is unpublished when the widget unmounts or the effect re-runs.

### Invoking a peer's capability

```tsx
const invoke = api.constellations.useInvokePeerCapability()

async function handleClick() {
  const result = await invoke(peerId, 'my.capability', { foo: 'bar' })
}
```

`invoke` rejects if the peer is not in the same constellation, or if the named capability has not been published.

### Host-published capabilities

Two built-in widget types publish capabilities your plugin can consume:

| Widget | Capability | Args | Returns |
|---|---|---|---|
| Run workspace | `session.prompt` | `{ text: string }` | `null` (posts text to the tmux session) |
| File editor | `file.path` | _(none)_ | The file path string |

### Action triggers

Each returns a stable callback safe to call from event handlers:

- `useFitToMine()` → `fit()` — frame all members of this constellation in the viewport.
- `useTidyMine()` → `tidy()` — grid-arrange this constellation around its centroid.
- `useAssignToSlot()` → `assign(slot: number)` — programmatically join a slot (1–9).
- `useLeave()` → `leave()` — remove this widget from its constellation.

### Trust boundary

- Capability invocations across constellation boundaries are rejected at the registry level.
- `usePeers()` only returns widgets in your own constellation — there is no cross-constellation discovery.
- A widget can only `leave()` itself, not remove peers.

---

## Loading & lifecycle

Boot sequence (`src/widgets/index.ts` is the entry):

1. Client calls `fetchPluginsConfig()` against `GET /api/plugins-config`. On error, falls back to an empty config (bundled plugins still load; externals don't).
2. `bootAllPlugins(BUNDLED_PLUGINS, config, registry, defaultImportExternalFn)` runs.
3. For each bundled plugin (statically imported from `src/plugins/<name>/`):
   - Parse manifest. On `ManifestError`: log + skip, no record created.
   - If `parsed.name` is in `config.disabled`: skip, no record created.
   - Build a `PluginRecord` with `state: 'pending'`. `registry.activate(record, module, createPluginApi)` is awaited.
4. After bundled, iterate external entries from config. For each `{ name, path }`:
   - Call `defaultImportExternalFn(entry)` (10s timeout on the package.json fetch).
   - Parse manifest, build record, activate. Same per-stage error handling as bundled.

Lifecycle states:

```
not-loaded → loading → active → (disposing) → not-loaded
                ↓
             failed (terminal until next boot)
```

**State transitions:**
- `pending → active`: `activate()` returned (or its returned Promise resolved). Disposables tracked.
- `pending → failed`: `activate()` threw or rejected. Partial registrations made via `api.widgets.register` are disposed; `record.error` and `record.errorStack` are captured.
- `active → pending`: explicit `registry.deactivate(name)`. All disposables fire. (V5.0 has no UI affordance for this beyond toggle-then-reload.)

**Re-activation guard:** calling `registry.activate()` on a record whose state is already `active` throws — prevents silent clobber of disposables. The loader catches this throw and logs `activate failed for "<key>"` so the boot loop continues past it (e.g., if two bundled entries shared a name).

---

## External plugin loading

External plugins live in their own repos and ship as pre-built ESM bundles. They share React and `@tinstar/plugin-api` with the host via an importmap:

```html
<!-- index.html injects this before any module loads -->
<script type="importmap">
{
  "imports": {
    "@tinstar/plugin-api": "/api/plugin-runtime/api.js",
    "react": "/api/plugin-runtime/react.js"
  }
}
</script>
```

The two `plugin-runtime` modules are served by `src/server/api/pluginRuntime.ts`:
- `api.js` is an empty ESM module — `@tinstar/plugin-api` is types-only at runtime; the actual `api` is delivered as the parameter to `activate(api)`.
- `react.js` re-exports `window.__tinstar_react`, which is mounted in `src/main.tsx` before React renders. This ensures plugins share the host's React instance (cross-realm React = "Invalid hook call").

For **local-folder externals** (`{ "path": "/abs/path" }`), the server also exposes `/api/plugin-runtime/local/<name>/<file>` to serve the plugin's built JS. Path-traversal and symlink-escape protection in place.

For npm-resolved externals (`{ "npm": "@scope/foo" }`), V5.0 raises an error — npm-resolved externals are V5.1.

`~/.config/tinstar/plugins.json` shape:

```jsonc
{
  "disabled": ["nats-traffic"],
  "external": [
    { "name": "papershore", "path": "/home/will/repo/papershore" }
  ]
}
```

Server route at `GET/PUT /api/plugins-config` reads and atomically writes this file. Validates body shape, drops invalid entries. 5s body-read timeout, 1MB body cap.

---

## Failure handling

Failures surface in two places:

- **`PluginRegistry.list()`** has every record with state + error + errorStack. The settings UI (`PluginsTab`) reads this list every 500ms and renders `failed: <message>` inline next to the toggle row.
- **`<PluginFailedBanner />`** renders a top-right toast for every failed plugin. Dismissible per-plugin per-session. Polls every 5s.

Partial failures during `activate()` are cleaned up automatically: anything registered via `api.widgets.register` before the throw is disposed, and `record.disposables` is cleared. The plugin lands in `failed` state with no leaked registrations.

Things that get silently filtered (not failures, but worth knowing):
- Manifest validation drops invalid `external[]` entries from `plugins.json` with a `console.warn` per dropped entry citing the reason.
- SSE frames with malformed JSON are dropped after a `console.warn` snippet.

---

## Design decisions

These are extracted from the V5 design conversation. The "what" is in the code; the "why" lives here.

### Trusted in-process, not sandboxed

Plugins are JS modules in the host's realm, with full DOM/network access and shared React. The alternative — iframe-per-plugin with postMessage RPC — was considered and rejected. Reason: the motivation is composing sibling projects (papershore, stretchplan) you own, not hosting untrusted third-party code. A sandbox would cost cross-realm hassles (drag/focus/z-index across iframe boundaries, frozen RPC API surface, double React instances) for a safety guarantee that doesn't pay rent against the actual threat model.

This is **not a one-way door**. A future sandboxed tier could be added as opt-in for a "webview-widget" surface (V5.2+) without changing the existing trusted model.

### Hybrid loading: bundled + external

Built-ins are statically imported into the tinstar bundle; externals are dynamically imported at runtime from local folders or (eventually) npm. Rejected alternatives: pure-bundled (forces tinstar release for every plugin update, ties papershore release cadence to tinstar) and pure-runtime (pays full dynamic-loader cost before any plugins exist, slower dev loop for built-ins).

### Manifest + entry, not single entry

A `package.json` `tinstar` block declares what the plugin contributes; the entry's `activate()` actually registers it. The manifest is the source of truth for the settings UI before any plugin loads — without it, "disable a built-in plugin" would require loading the plugin just to render the toggle.

### `apiVersion: '5'` is a literal string type

Locked at compile time in `PluginManifest.apiVersion: '5'`. A V6 host will refuse to load a V5-manifest plugin, and vice versa. Bumping is a deliberate breaking-change signal — additive changes (new event channels, new API surfaces) do not bump.

### Widgets, panes, commands only — no server-side plugin code

V5 plugins only extend the frontend. They can call HTTP endpoints (via `api.http`) and subscribe to SSE events (via `api.events`), but they cannot register their own server routes or backend event handlers. This kept the trust model coherent (frontend-only = trusted-by-install; backend plugin code would force a server-side sandbox conversation) and the scope finite. If a future use case demands server-side plugin code, it'd be a separate plugin category, not an extension of this one.

### Built-ins migrate through the same API

Tinstar's own widgets (browser, nats-traffic, file-editor, image-viewer) are bundled plugins — they activate through `activate(api)` like any external. This dogfooded the API throughout V5 development and means there's no "first-class internal API" vs "second-class external API" drift to maintain.

Saloon, minimap, run-workspace, and hierarchy sidebar stay in core. They're tinstar's identity surfaces — hard-wired to the canvas's existence — and don't benefit from being plugins.

### Disposables, everywhere

Every registration call returns a `Disposable`. The registry tracks them per plugin. On `deactivate`, every disposable fires. This is the only teardown mechanism — there's no separate "unregister" call per resource type, which kept the API small and the teardown contract obvious.

---

## References

- Public types: [`packages/plugin-api/src/index.ts`](../../packages/plugin-api/src/index.ts)
- npm consumer README: [`packages/plugin-api/README.md`](../../packages/plugin-api/README.md)
- External plugin author guide: [`external-quickstart.md`](external-quickstart.md)
- Bundled plugin author guide: [`bundled-howto.md`](bundled-howto.md)
- SSE event source of truth: [`src/server/api/sse.ts`](../../src/server/api/sse.ts), [`src/hooks/useServerEvents.ts`](../../src/hooks/useServerEvents.ts)
