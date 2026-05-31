# Browser-widget placement API (host support for plugin-driven placement)

Lets a caller — e.g. the stretchplan **bridge** plugin — open a Tinstar browser
widget at a chosen canvas spot and/or in a specific constellation slot, instead
of accepting the host's default placement.

## The placement / slot model (what was found)

There are **two separate stores**, and they are not the same channel:

### 1. Canvas position — `config.ui.layouts`
- Widget positions live **client-side** in `TinstarConfig.ui.layouts['tinstar-layouts-v3-<spaceId>'][nodeId] = { x, y, width, height }`, persisted in the config file on disk.
- For a browser widget, the **layout node id is the widget id** (`browser-XXXX`) — see `src/components/WorkspaceShell.tsx:171` (`syntheticBrowserNodes`, `id: w.id`).
- On mount/space-switch the frontend hydrates this map from config (`src/hooks/useWidgetLayouts.ts:255` `hydrateLayouts`). New nodes that appear live (via SSE) and have no layout get placed by `placeNewRuns` (near siblings) / `generateDefaultLayouts` (grid) — `src/hooks/useWidgetLayouts.ts:179, 76`.
- **Key constraint:** config is loaded **once** on the client and only re-read on its own PATCH (`src/context/ConfigContext.tsx:34`). There is **no live config push**. So writing a position into `config.ui.layouts` server-side does **not** reach a running session until reload. The only thing a live session honors for a brand-new widget is data that rides the **SSE entity update**.

### 2. Constellation slot — server-side graph docstore
- Slot membership is a per-space graph: `members: [{ widget: nodeId, slot: '1'..'9' }]` — `src/domain/constellationGraph.ts:12`.
- Stored in the docstore (`src/server/stores/document-store.ts:521` `upsertConstellationGraph`), broadcast over SSE, mutated by the client via `PUT /api/constellation-graph/:spaceId` (`src/server/api/routes.ts`) and read by `useConstellationGraph` (`src/hooks/useConstellationGraph.ts:29`).
- This **is** live-reactive (docstore → SSE → client), unlike `config.ui.layouts`.
- Convention: constellations want **≥2 members** (1-member slots get pruned on widget delete — `document-store.ts:507`). `slot` here means *join this slot* — the real use case is the browser widget joining the bridge's existing constellation.

## What was added

Because position is not a live-reactive channel, the placement seed is stored on
the **`BrowserWidget` entity** (`position`/`size`, `src/domain/types.ts:200`) so it
rides the SSE update, and the layout hook seeds from it on the widget's first
appearance. Slot assignment goes straight through the existing graph docstore.

### `POST /api/browser-widgets` (extended — `src/server/api/routes.ts`)

Existing body `{ sessionId, url?, headers? }` plus **optional**:

| field        | type                      | meaning |
|--------------|---------------------------|---------|
| `spaceId`    | string                    | target space (defaults to active space) — scopes placement + slot |
| `position`   | `{ x, y }`                | explicit canvas position seed (wins over `nearNodeId`) |
| `size`       | `{ width, height }`       | size paired with the position; defaults to **800×600** |
| `nearNodeId` | string                    | place just to the **right** of this node id (`x + width + 20`, same `y`), resolved from persisted `config.ui.layouts` |
| `slot`       | integer 1–9               | constellation slot to join (out-of-range ignored) |

Resolution order: `position` → else `nearNodeId` (if it has a saved layout) → else no position (host falls back to default placement). The resolved `{position,size}` is written onto the returned widget entity. `slot` mutates the space's constellation graph.

### `PATCH /api/browser-widgets/:id` (extended)

Existing `{ url?, title?, headers? }` plus the same optional `position` / `size` /
`nearNodeId` / `slot`. (Caveat: re-positioning an *already-placed* widget only
takes effect for live sessions after a reload — the seed is consulted only when a
node has no layout yet. Slot changes are live.)

### Example — plugin opens a browser widget next to itself, in its slot

A plugin runs inside an iframe and talks to the host via `api.http`. The bridge
knows its own widget node id (`pw-...`) and its slot:

```js
// inside the bridge plugin
const res = await api.http('POST', '/api/browser-widgets', {
  sessionId: mySessionId,        // a session with a running run
  url: 'http://localhost:5188/?plan=foo',
  nearNodeId: myWidgetNodeId,    // land just to the right of the bridge
  slot: 4,                        // join the bridge's constellation slot
})
const widget = res.data          // { id, position: {x,y}, size: {w,h}, ... }
```

Or with an explicit point (e.g. computed from the plugin's own rect):

```js
await api.http('POST', '/api/browser-widgets', {
  sessionId, url,
  position: { x: 1200, y: 300 },
  size: { width: 900, height: 700 },
})
```

## Client wiring

- `BrowserWidget.position`/`size` added — `src/domain/types.ts:200`.
- `useWidgetLayouts(tree, spaceId, seedLayouts?)` — new optional seed map consulted in the hydrate + tree-change fill paths *before* `placeNewRuns`/defaults — `src/hooks/useWidgetLayouts.ts`.
- `InfiniteCanvas` builds the seed from `browserWidgetMap` (widgets carrying `.position`) and passes it in — `src/components/InfiniteCanvas.tsx`.

So: create → SSE delivers the widget (with `position`) → the layout hook seeds it at that spot → the position then flows into `config.ui.layouts` like any other widget, and user drags take over from there.

## Is a Tinstar restart needed?

- **Server (the API itself):** yes — `routes.ts` is backend code, so the new
  request fields are only live after the backend restarts. **This was NOT done**
  (other sessions are running, per instructions). The owner should restart the
  backend when convenient to activate the endpoint changes.
- **Frontend (the seeding behavior):** needs a `vite build` + hard reload on the
  running instance to pick up the new bundle. Not done here.
- Until both are deployed, the server still accepts the old body shape and the
  feature is inert (no behavior change, no regression).

## Verification

- Typecheck: `npx tsc --noEmit -p tsconfig.app.json` — error count unchanged at the known **140-error baseline** (zero new errors introduced).
- Tests: `src/server/api/__tests__/browser-widgets-placement-route.test.ts` — 9 new tests covering explicit position, explicit size, `nearNodeId` resolution (and miss), slot assign (and out-of-range), plain create, and PATCH placement/slot. All pass. Full `src/server/api/__tests__` suite (117 tests) green.

## Files touched

- `src/domain/types.ts` — `BrowserWidget.position`/`size`
- `src/server/api/routes.ts` — placement helpers + POST/PATCH extension
- `src/hooks/useWidgetLayouts.ts` — `seedLayouts` param
- `src/components/InfiniteCanvas.tsx` — build + pass the seed
- `src/server/api/openapi.ts` — documented the new fields
- `src/server/api/__tests__/browser-widgets-placement-route.test.ts` — new tests
