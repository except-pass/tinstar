---
title: "Adding a docstore entity + read-only plugin widget: the wiring map"
date: 2026-07-17
last_updated: 2026-07-17
category: conventions
module: document-store
problem_type: architecture
component: docstore_and_plugins
severity: medium
applies_when:
  - Adding a new server-side entity to DocumentStore that the UI must render live
  - Building a bundled plugin widget that reads a docstore collection
  - Deciding whether a new collection needs frontend useServerEvents edits
  - A new bundled plugin widget never appears in the widget palette (no error, count unchanged)
---

# Adding a docstore entity + read-only plugin widget

Landed while building the Roundup (`src/plugins/roundup/`, the `notice` entity). Captures the wiring so the next entity+widget doesn't rediscover it.

## The mutator contract is real and enforced by a test

Every `DocumentStore` mutator that emits `change` MUST equality-short-circuit on a no-op write — the status-watcher (3s), reconcile (30s), and git-diff (10s) loops re-assert state every tick, so a missing short-circuit produces a permanent SSE/persist storm. `Artifact`/`BrowserWidget`/`ImageWidget` predate the contract and must NOT be copied for the mutator; copy `upsertRun` / `upsertTombstone` instead. Write a dedicated `<entity>Equal(a, b)` field comparator (mirror `tombstoneEqual`), and write a contract test asserting an identical re-`upsert` emits **zero** change events — it fails the moment someone removes the guard.

## Two SSE halves: the broadcaster is generic, the frontend reducer is not

- **Server → wire:** `src/server/api/sse.ts` turns any mutator `change` into a `delta` generically. A new entity needs **no** `sse.ts` change — just emit `change` with `entity: '<name>'`.
- **Wire → host state:** `src/hooks/useServerEvents.ts` is NOT generic — an unhandled entity silently never updates. BUT you only pay this if a **host** component reads it.

## Plugins don't touch useServerEvents — they read over HTTP + a delta subscription

A bundled plugin widget (ADR-0002 boundary) cannot import host hooks. It reads state exactly like `graveyard`: `api.http.fetch('/api/<name>')` for the initial list, plus `api.events.subscribe('delta', msg => msg?.eventType === '<name>.updated' && reload())` for liveness. Consequence: **a plugin-rendered entity needs a `GET /api/<name>` list route and zero `useServerEvents.ts` edits.** Choosing a plugin over a host widget deletes six reducer edits and a whole class of "why isn't it updating" bugs.

## Registering a bundled plugin widget is a TWO-place change — and the second place fails silently

This one shipped a broken widget to `main` (Roundup PR #115) and took a live debugging session to find. Registering a new built-in plugin widget requires editing **two** lists, and missing the second produces **no error** — the widget's code loads, but the palette never lists it, so the tile is simply absent and the widget count doesn't move.

1. `src/core/pluginHost/bundled.ts` — `BUNDLED_PLUGINS`. Client-side. `bootAllPlugins` iterates this in the browser to **activate** the plugin and register its React **component** (so a spawned widget can render).
2. `src/server/api/builtinPluginManifests.ts` — `BUILTIN_PLUGIN_PKGS`. Server-side. The widget **palette** fetches `GET /api/plugin-widgets/registry` (`usePluginWidgetRegistry` → `apiFetch(...)`), which is built from **this** list. A plugin only in (1) has a working component nobody can spawn, because the palette never surfaces it.

The file header literally says *"Keep this list in sync with BUNDLED_PLUGINS"* — but nothing enforces it, and no test caught the drift until PR #116 added one (`src/server/api/__tests__/builtinPluginManifests.test.ts`).

**Diagnosis shortcut:** `curl -s localhost:5273/api/plugin-widgets/registry | jq -r '.data[].widgetType'`. If the new type isn't there, it's the server list — not a cache, not the client bundle. (This is worth reaching for early: a missing palette tile *looks* like a stale frontend bundle, and chasing browser cache instead of the server registry burns real time.)

**Caveat on "mirror graveyard":** `graveyard` is a good template for the *component-read* pattern above, but it is NOT in `BUILTIN_PLUGIN_PKGS`, so it is not a palette-listed widget. Do not use it as the template for palette registration — use `roborev` or `model-attribution`, which are in both lists.

## Lifecycle cascades belong in the docstore, not the route

To guarantee a child entity can't outlive its parent (e.g. a notice must die with its run), put the cascade inside the parent's delete mutator (`deleteRun`'s both branches), mirroring `deleteBrowserWidget → deleteArtifact` — plus `clearSpace` and `clear`. Route-level cleanup misses the other delete paths. Watch the keying: `deleteRun` is called with the session **name** (the run's `.id`), which is distinct from `.sessionId`.

## Validate agent-authored bodies defensively — a bad PATCH can crash the whole widget

Agent-facing write routes take arbitrary JSON. Two traps caught in review of the notice API:
- **Spreading the raw parsed body** (`{ ...existing, ...patch }`) lets stray keys clobber server-owned identity (`id`, `runId`, `createdAt`) — breaking the cascade key. Whitelist the mutable fields instead.
- **A non-string field that the renderer trusts** (e.g. `{ "background": 123 }`) persists and then throws in `.trim()` / `ReactMarkdown`, crashing **every** row on the board, not just the bad one. Validate the type before persisting. Also guard `JSON.parse('null')` → non-object body, which otherwise throws inside `readBody(...).then(...)` with no `.catch` and hangs the request.

## Related

- `@a2ui/react` (the A2UI React renderer) peers on React 19; this repo is React 18, and the peer was dropped in a *patch* release (0.10.0 → 0.10.1). Use the framework-agnostic `@a2ui/web_core` if adopting A2UI, and pin it.
