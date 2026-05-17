# Adding a bundled plugin to tinstar

For plugins that live **inside the tinstar repo** and ship as part of the tinstar build. Sibling guide for external plugins (in their own repo, installed via `plugins.json`) is [`external-quickstart.md`](external-quickstart.md). Canonical reference is [`README.md`](README.md).

A bundled plugin is just an in-repo plugin: same activate(api) entry, same manifest shape. The only differences from external are (a) it's statically imported into the tinstar bundle at build time and (b) it can `import` from anywhere in `src/` via relative paths, including the existing `apiClient`/`apiFetch`. No build pipeline of its own.

Reference plugins to crib from: `src/plugins/browser/`, `src/plugins/nats-traffic/`, `src/plugins/file-editor/`, `src/plugins/image-viewer/`.

---

## 1. Create the plugin folder

```bash
mkdir -p src/plugins/my-thing/src
```

Conventionally `kebab-case` for the folder. The plugin's `name` (in its `package.json`) should match.

---

## 2. Write the manifest

`src/plugins/my-thing/package.json`:

```json
{
  "name": "my-thing",
  "version": "1.0.0",
  "private": true,
  "main": "src/index.tsx",
  "tinstar": {
    "apiVersion": "5",
    "displayName": "My thing",
    "description": "What this widget does",
    "contributes": {
      "widgets": [
        { "type": "my-widget", "label": "My widget", "defaultSize": { "width": 400, "height": 300 } }
      ]
    },
    "permissions": []
  }
}
```

Manifest field reference is in [`README.md`](README.md#plugin-manifest).

---

## 3. Write the widget component

`src/plugins/my-thing/src/MyWidget.tsx`:

```tsx
import type { WidgetProps } from '@tinstar/plugin-api'
import { apiFetch } from '../../../apiClient'   // bundled plugins can import tinstar internals

export function MyWidget({ data, zoom, isSelected }: WidgetProps) {
  // do stuff
  return <div style={{ fontSize: 12 / zoom }}>{String((data as { label?: string }).label ?? 'untitled')}</div>
}
```

**Import path depth from `src/plugins/<name>/src/`:** three levels up to `src/`. So `apiFetch` lives at `../../../apiClient`, `WidgetFrameState` at the top-level `@tinstar/plugin-api`, etc.

---

## 4. Write the plugin entry

`src/plugins/my-thing/src/index.tsx`:

```tsx
import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import { MyWidget } from './MyWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('my-thing plugin activating')
  return [
    api.widgets.register({
      type: 'my-widget',
      component: MyWidget,
      isContainer: false,
      defaultSize: { width: 400, height: 300 },
      minSize: { width: 200, height: 100 },
      dragHandleSelector: '.widget-drag-handle',
    }),
  ]
}
```

The `Disposable[]` return is what the host tracks for teardown. Anything `api.*.register(...)` returns is auto-tracked too — but it's a good habit to include returns in the array anyway for symmetry with externals that might use raw resources (AbortControllers, etc.) the api doesn't know about.

---

## 5. Wire into the bundled index

Open `src/core/pluginHost/bundled.ts` and add your plugin to `BUNDLED_PLUGINS`:

```ts
import myThingPkg from '../../plugins/my-thing/package.json'
import * as myThing from '../../plugins/my-thing/src/index'

export const BUNDLED_PLUGINS: Record<string, BundledEntry> = {
  browser: { pkg: browserPkg, module: browser as Plugin },
  'nats-traffic': { pkg: natsTrafficPkg, module: natsTraffic as Plugin },
  'file-editor': { pkg: fileEditorPkg, module: fileEditor as Plugin },
  'image-viewer': { pkg: imageViewerPkg, module: imageViewer as Plugin },
  'my-thing': { pkg: myThingPkg, module: myThing as Plugin },   // ← new
}
```

The key (`'my-thing'`) is what shows up in the bundled-plugin index — conventionally matches the package `name`.

---

## 6. Verify

```bash
npx tsc --noEmit
npx vitest run src/core/pluginHost src/core/pluginApi
```

Both clean. Reload tinstar. Browser DevTools console shows `[my-thing] my-thing plugin activating`. The widget type appears in `Settings → Plugins`.

---

## Common patterns

### Subscribing to host events

```tsx
export function activate(api: TinstarPluginAPI) {
  return [
    api.widgets.register({ ... }),
    api.events.subscribe('nats_traffic', (msg) => {
      api.logger.info('nats message', msg)
    }),
    api.events.subscribe('telemetry:hud', (snap) => {
      // react to telemetry
    }),
  ]
}
```

Subscribe to **exact** SSE event names from the [known channels list](README.md#eventssubscribe). Wildcards not supported in V5.0.

### Hitting tinstar's REST API

```ts
const r = await api.http.fetch('/api/state')
const state = await r.json()
```

Relative paths. The host adds `X-Tinstar-Plugin: <pluginId>` so server logs identify the caller.

### Using `getFrameClass` for selection/drag styling

```tsx
api.widgets.register({
  type: 'my-widget',
  // ...
  getFrameClass: ({ isSelected, isDragging }) => {
    if (isDragging) return 'widget-run-dragging'
    if (isSelected) return 'widget-run-selected'
    return ''
  },
})
```

The frame state object also includes `isHovered` and `isDropTarget`. See [`WidgetFrameState`](../../packages/plugin-api/src/index.ts).

### Plugin-specific persistent state

V5.0 doesn't have a plugin-scoped `api.storage` (V5.1). Two interim options:
- `localStorage` — fast, browser-local, not server-backed
- Roll your own server endpoint and hit it via `api.http.fetch` — works fine; you own the schema

---

## Migration tips (moving an existing widget to a bundled plugin)

If you're converting an existing `src/widgets/<name>/` to a plugin:

1. `mkdir -p src/plugins/<name>/src`
2. `git mv src/widgets/<name>/<Component>.tsx src/plugins/<name>/src/<Component>.tsx` (preserves git history)
3. Fix relative imports in the moved file: every `../../X` becomes `../../../X`. Imports from sibling files (`./Helper`) stay.
4. Write the new `index.tsx` activate entry (Step 4 above).
5. Create `package.json` (Step 2).
6. Register in `bundled.ts` (Step 5).
7. Remove the static `import './<name>'` line from `src/widgets/index.ts`.
8. `git rm` the old `src/widgets/<name>/` directory.

The four V5 migrations (browser, nats-traffic, file-editor, image-viewer) followed this script exactly — the diffs are good reference: see commits `ae04bfe`, `d9332b7`, `0a40bfc`, `94c73c8` for the per-plugin migration shape.

---

## Troubleshooting

**`Module not found '@tinstar/plugin-api'`** — Run `npm install`. The workspace symlink at `node_modules/@tinstar/plugin-api` is what makes the alias resolve.

**`tsc` complains about an unrelated file under `src/`** — Run `npx tsc --build --force --noEmit`. The incremental cache hides many pre-existing project-wide errors; force mode reveals them. Most are not caused by your plugin.

**Widget doesn't render after dropping on canvas** — Open DevTools, look for `[<plugin>] <plugin> plugin activating`. Missing means manifest or activate threw — check Settings → Plugins for the failed-record error. Or look for `No widget registered for type: <type>` warning, which means activate ran but didn't register the type (typo in `type` field, or `widgets.register` rejected a duplicate).

**Tests in `src/core/pluginHost/` fail after adding the plugin** — The integration test in `__tests__/integration.test.ts` runs the full pipeline against your `BUNDLED_PLUGINS` entry. If it fails, your plugin's activate or manifest is throwing. Logs in the failure output usually point at the cause.
