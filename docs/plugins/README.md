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
| `contributes.widgets` | no | Array of `{ type, label, defaultSize? }`. Declarative — runtime registration in `activate()` is what actually works; this is for settings UI. |
| `permissions` | no | Free-form string array; not currently enforced (trusted model). Declared so settings UI can surface intent ("plugin will subscribe to NATS"). |

If `activate()` registers a widget type not in the manifest, the host logs a warning and accepts it. If the manifest declares one not actually registered at runtime, the host quietly drops the stale entry.

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

### Out of scope for V5.0

These are deferred to V5.1. If you need them today, drop a note — they're scoped, not blocked:

- `api.commands.register` — register commands + hotkeys
- `api.storage.{get,set}` — plugin-scoped server-backed storage
- `api.panes.register` — pane-shaped chrome contributions
- React hooks layer (`useSessions`, `useTask`, `useTelemetrySeries`, `useViewport`, `useNats`, `useSelection`)

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
