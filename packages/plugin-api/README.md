# @tinstar/plugin-api

Public API types for building Tinstar plugins.

## What is a Tinstar plugin?

A plugin is an npm package (or a local folder) that contributes widgets,
panes, commands, or other extension points to the Tinstar canvas. Plugins
run in-process with the host — they have full access to `@tinstar/plugin-api`
and React.

## Installation

```bash
npm install --save-dev @tinstar/plugin-api react
# Then in your package.json, add:
#   "peerDependencies": { "@tinstar/plugin-api": "^5.0.0", "react": "^18 || ^19" }
```

## Minimal plugin

```tsx
// src/tinstar-plugin.tsx
import { definePlugin, TINSTAR_API_VERSION } from '@tinstar/plugin-api'
import type { WidgetProps } from '@tinstar/plugin-api'

function HelloWidget({ data }: WidgetProps) {
  const name = (data as { name?: string }).name ?? 'world'
  return <div>hello {name}</div>
}

export default definePlugin({
  activate(api) {
    api.logger.info(`hello plugin activating against api v${TINSTAR_API_VERSION}`)
    return [
      api.widgets.register({
        type: 'hello-widget',
        component: HelloWidget,
        isContainer: false,
        defaultSize: { width: 320, height: 200 },
        minSize: { width: 200, height: 120 },
      }),
    ]
  },
})
```

Add a `tinstar` block to your `package.json`:

```json
{
  "name": "your-plugin",
  "version": "0.1.0",
  "main": "dist/tinstar-plugin.js",
  "tinstar": {
    "apiVersion": "5",
    "displayName": "Hello plugin",
    "contributes": {
      "widgets": [{ "type": "hello-widget", "label": "Hello", "defaultSize": { "width": 320, "height": 200 } }]
    }
  }
}
```

## Loading your plugin

Add to `~/.config/tinstar/plugins.json`:

```json
{
  "disabled": [],
  "external": [
    { "name": "your-plugin", "path": "/absolute/path/to/your-plugin" }
  ]
}
```

Then restart Tinstar. The Settings → Plugins tab will list your plugin.

## API surface (v5.0)

- `api.widgets.register(reg): Disposable` — register a canvas widget type.
- `api.http.fetch(path, init?): Promise<Response>` — wraps tinstar's auth-aware fetch; auto-adds `X-Tinstar-Plugin` header.
- `api.events.subscribe(channel, handler): Disposable` — subscribe to host SSE events.
- `api.logger.{debug,info,warn,error}` — plugin-id-prefixed logger.
- `api.pluginId`, `api.version` — identity fields.

### Known SSE event channels

The host emits these SSE event names (subscribe by exact name, no wildcards in v5.0):

- `snapshot`, `delta` — workspace state
- `nats_traffic` — NATS messages
- `file_watch` — file system changes
- `telemetry:hud`, `canvas:viewport` — UI telemetry
- `projects_changed`, `ready_queue_update`, `heartbeat`

## Versioning

`apiVersion: "5"` is a hard handshake. The host rejects plugins built against
a different major. Additive changes (new hooks, new event channels) do not
bump.

## Building your plugin

The host externalizes `@tinstar/plugin-api` and `react` at runtime via an
importmap. Your build must NOT bundle them. With esbuild:

```bash
esbuild src/tinstar-plugin.tsx --bundle --format=esm --platform=browser \
  --external:@tinstar/plugin-api --external:react --external:react-dom \
  --outfile=dist/tinstar-plugin.js
```

## License

MIT — see the tinstar repo.
