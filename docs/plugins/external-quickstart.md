# Building an external Tinstar plugin

Step-by-step guide for creating a plugin that lives in its own repository and integrates with Tinstar at runtime.

## Prerequisites

- Tinstar V5+ running locally
- Node 20+
- A separate folder for your plugin (sibling of tinstar works fine)

## 1. Scaffold the package

```bash
mkdir my-plugin && cd my-plugin
npm init -y
npm install --save-dev @tinstar/plugin-api react esbuild typescript @types/react
# Then in your package.json, add:
#   "peerDependencies": { "@tinstar/plugin-api": "^5.0.0", "react": "^18 || ^19" }
```

## 2. Add a `tinstar` block to `package.json`

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "main": "dist/tinstar-plugin.js",
  "tinstar": {
    "apiVersion": "5",
    "displayName": "My plugin",
    "contributes": {
      "widgets": [
        { "type": "my-widget", "label": "My widget", "defaultSize": { "width": 400, "height": 300 } }
      ]
    }
  },
  "scripts": {
    "build": "esbuild src/tinstar-plugin.tsx --bundle --format=esm --platform=browser --external:@tinstar/plugin-api --external:react --external:react-dom --outfile=dist/tinstar-plugin.js"
  }
}
```

## 3. Write the plugin entry

```tsx
// src/tinstar-plugin.tsx
import { definePlugin } from '@tinstar/plugin-api'
import type { WidgetProps } from '@tinstar/plugin-api'

function MyWidget({ data, zoom }: WidgetProps) {
  return (
    <div style={{ padding: 8, fontSize: 12 / zoom }}>
      Hello from my-plugin
    </div>
  )
}

export default definePlugin({
  activate(api) {
    api.logger.info('my-plugin activating')
    return [
      api.widgets.register({
        type: 'my-widget',
        component: MyWidget,
        isContainer: false,
        defaultSize: { width: 400, height: 300 },
        minSize: { width: 200, height: 100 },
      }),
    ]
  },
})
```

## 4. Build

```bash
npm run build
```

Produces `dist/tinstar-plugin.js`. The `--external` flags ensure your bundle does NOT include `@tinstar/plugin-api`, `react`, or `react-dom` — the host provides those at runtime via an importmap.

## 5. Register with Tinstar

Edit `~/.config/tinstar/plugins.json` (create it if missing):

```json
{
  "disabled": [],
  "external": [
    { "name": "my-plugin", "path": "/absolute/path/to/my-plugin" }
  ]
}
```

Or use the Settings → Plugins UI to toggle, then drop the entry by hand. (V5.0 does not have an add-external-plugin dialog; that's V5.1.)

## 6. Reload Tinstar

Restart the Tinstar app. You should see `[my-plugin] my-plugin activating` in the browser console. Drop a `my-widget` on the canvas — the type appears in `Settings → Plugins`.

## Reading data flowing through Tinstar

Subscribe to host events:

```ts
activate(api) {
  return [
    api.events.subscribe('nats_traffic', (msg) => {
      api.logger.info('NATS message:', msg)
    }),
    api.events.subscribe('telemetry:hud', (snap) => {
      // react to telemetry updates
    }),
  ]
}
```

Known SSE event channels (V5.0): `snapshot`, `delta`, `nats_traffic`, `file_watch`, `telemetry:hud`, `canvas:viewport`, `projects_changed`, `ready_queue_update`, `heartbeat`. Wildcards are not supported; subscribe by exact name.

Hit Tinstar's REST API:

```ts
const sessions = await api.http.fetch('/api/state').then(r => r.json())
```

`api.http.fetch` automatically adds `X-Tinstar-Plugin: <pluginId>` so traffic from your plugin is identifiable in server logs.

## Common issues

**Plugin doesn't load.**
- Check the browser console for `[plugin-host] external import failed for "my-plugin"` — the message points at the culprit.
- Confirm `dist/tinstar-plugin.js` exists at the configured path.
- Check Settings → Plugins: a failed plugin shows the error inline, and a banner appears at the top-right of the canvas.

**`apiVersion` mismatch.**
- Your `package.json` `tinstar.apiVersion` must match the host's. V5 hosts accept `"5"` only. Bump your manifest, rebuild, reload.

**"Invalid hook call" in the browser console.**
- React isn't externalized. Re-check `--external:react --external:react-dom` in your build script. Your bundle must NOT include React.

**Plugin loads but events never arrive.**
- Confirm the channel name is one of the known SSE event names listed above.
- Check Network → EventStream — the host stream should be active on `/api/events`.

## Updating your plugin

After making changes:

```bash
npm run build
```

Reload Tinstar (V5.0 doesn't hot-reload external plugins — restart the app).

## Using constellations

Constellations let your widget discover and RPC-call other widgets it's been dropped near on the canvas. The quick version:

```tsx
function MyWidget() {
  const peers  = api.constellations.usePeers()
  const invoke = api.constellations.useInvokePeerCapability()

  const sessionPeer = peers.find(p => p.capabilities.includes('session.prompt'))

  if (!sessionPeer) return <div>Drop me next to a session to wire up.</div>

  return (
    <button onClick={() => invoke(sessionPeer.id, 'session.prompt', { text: 'hello' })}>
      Send to session
    </button>
  )
}
```

And to publish a capability from your own widget:

```tsx
const publish = api.constellations.usePublishCapability()
useEffect(() => publish('my.capability', async (args) => 'result').dispose, [publish])
```

Full reference: [`docs/plugins/constellations-and-capabilities.md`](constellations-and-capabilities.md).

## What's next (V5.1)

**Shipped in V5.0** (beyond `widgets`, `http`, `events`, `logger`): `api.canvas`, `api.hotkeys`, `api.theme`, `api.watch`, `api.constellations` — all available now.

**Still future:**

- `api.commands.register` — register commands + hotkeys
- `api.storage.{get,set}` — plugin-scoped server-backed storage
- `api.panes.register` — contribute pane-shaped chrome
- React hooks layer (`useSessions`, `useTelemetrySeries`, `useViewport`, …)
- Add-external-plugin dialog in Settings
- Hot enable/disable without app reload
