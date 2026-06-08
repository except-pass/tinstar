# Tinstar v5.1 — feature reference

Single-source reference for every feature shipped in v5.1. Organized by subsystem. Points at the relevant code and existing timeless docs.

> **Why this doc exists:** v5.0 shipped the plugin *platform* — a closed, versioned `@tinstar/plugin-api` contract with its own lifecycle, widget registry, and canvas citizenship. v5.1 turns that platform into an *ecosystem*: plugins can now wrap a real terminal or browser session (**primitives**), a plugin can *be* the face of a session (**session-views**), and the first two non-trivial plugins built on those capabilities ship in-tree (the **Roborev cockpit** and **Saloon**). Underneath, the canvas grew a real add-widget flow, constellations moved off `localStorage` onto a **server-backed per-space graph**, agents got an **artifacts** API to push rendered HTML onto the canvas, and the TypeScript baseline reached **zero, locked by CI**. The per-feature plans and audit punchlists that drove each of these have been retired; this file is the pointer map to the living code. Same pattern as `release-notes-v5-0.md`.
>
> No new ADRs this release — v5.1 builds on the two from v5.0 (`docs/adrs/0001-response-envelope.md`, `docs/adrs/0002-plugin-api-boundary.md`) without re-litigating them. Every API added below returns the ADR-0001 envelope and lives behind the ADR-0002 boundary.

---

## Plugin primitives — terminal & browser

See **`docs/plugins/README.md`** § *Primitives* and § *Session-view widgets*; what follows is the *why*.

**The keystone of v5.1.** v5.0 let a plugin render arbitrary React on the canvas and read/write its own docstore state. It could not own a *session* — a live tmux/ttyd terminal or an embedded browser. v5.1 adds `api.primitives`:

- `registerTerminalWidget(opts)` / `registerBrowserWidget(opts)` register a widget whose main content is a host-owned terminal or browser, with an optional edge-pinned `accessory` React pane the plugin controls.
- `useTerminal()` (called inside a terminal-primitive accessory) resolves the live `TerminalHandle` — imperative, event-handler-safe methods: `sendText`, `sendKeys`, `readScreen`, and `exec` (run an argv in the session cwd and get a structured result back). `useBrowser()` is the browser analogue.

The host, not the plugin, owns the heavy machinery (the iframe covers the body, so the primitive ships a drag-handle header; `_browser` data resolves by node id through the proxy). The plugin only writes the thin pane beside it. This is what makes a plugin like the Roborev cockpit possible at all.

**Generic server primitives back the handle.** The terminal handle is thin glue over new generic session endpoints — these are *not* roborev-specific (an earlier roborev-specific core was reverted in favor of them): `POST /api/sessions/:name/exec` runs an argv in the session's cwd and returns a structured result; `GET /api/sessions/:name/screen` captures the pane. A generic `shell` CLI template launches a plain shell session, and `execCommand`/`captureScreen` helpers give the server one home for "run argv, get structured result" and "snapshot a pane" (de-duping the prior ad-hoc capture-pane callers).

Code: `packages/plugin-api/src/index.ts` (`primitives` surface, `TerminalHandle`), `src/server/api/routes.ts` (`/exec`, `/screen`), `src/server/infra/execCommand.ts`, `src/server/sessions/` (`captureScreen`, `shell` template).

---

## Session-view plugins — a plugin can *be* the session

See **`docs/plugins/README.md`** § *Session-view widgets*; what follows is the *why*.

**One node per session, pluggable face.** A terminal widget registered with `creator: 'session-backed'` is a *session-view*: its canvas node **is** the session's run node — there is exactly one node per session, not a plugin widget floating alongside a duplicate run-workspace. The run's `view`/`viewData` fields (now persisted on create and via `PATCH /api/runs/:id`) store which plugin type renders the run; `renderNode` selects the component from `run.view`.

**Safe fallback.** `resolveRunViewType` falls back to the default `run-workspace` view when `run.view` names a plugin type that isn't registered (e.g. the plugin is disabled), so a session is *always* reachable on the canvas — a disabled plugin can never strand a session. Spawning a session-view from the palette opens the normal session-create flow; the created run just gets `view = <widget type>`.

Code: `src/domain/runView.ts` (`resolveRunViewType`), `src/server/api/routes.ts` (`PATCH /api/runs/:id`, view/viewData on create), `src/canvas/` (`renderNode`), `packages/plugin-api/src/index.ts`.

---

## Roborev cockpit — the first session-view plugin

**Proof the primitives compose.** The Roborev cockpit is a bundled plugin that wraps the `roborev` TUI as a terminal session-view, with a native review pane as its accessory. It registers as `creator: 'session-backed'`, launches the TUI by `sendText` into the session it gets from `useTerminal()`, reads its `launched` flag from `run.viewData`, and drives the live review list / actions through `exec` — built entirely on the generic primitives above, with no roborev-specific server core. A `roborev_stream` SSE channel surfaces live daemon events to the pane; bootstrap/launch are StrictMode-safe (module-keyed by node id). The view-model (sort/resolve/optimistic) is pure and unit-tested independent of the host.

Code: `src/plugins/roborev/` (`src/index.tsx` is the session-view entry), `docs/plugins/README.md` § *Session-view widgets* (reference implementation), `docs/plugins/` (`roborev_stream` channel).

---

## Saloon — NATS traffic, now a plugin

**The last native widget became a plugin.** v5.0's built-in `nats-traffic` widget — the NATS firehose monitor — was rebuilt as **Saloon**, a bundled plugin, and the native `NatsTrafficWidget` system was removed (the underlying NATS *bridge* stays; only the widget moved). Saloon is session-bound: snap it to a session and it monitors that session's subjects (publishing a `session.nats` capability so the constellation can wire it); unbound, it shows the real `tinstar.>` firehose. The header shows session name, live broker status, and subscribed subjects, with a reconnect affordance on broker-health loss. Accumulated rows clear on rebind so you never see stale cross-session traffic. A `nats-traffic` compat alias keeps older references working.

This is the migration v5.0 set up but didn't finish — proof that a first-class native widget can be expressed entirely through the public plugin API, which is the whole point of the boundary.

Code: `src/plugins/nats-traffic/` (package `saloon`: `Saloon.tsx`, `StreamView.tsx`, `resolveBinding.ts`, `subjectMatches.ts`, `reconnectIntent.ts`).

---

## Artifacts — agents push rendered HTML onto the canvas

**A capability for agents and sibling projects.** `POST /api/artifacts` stores an HTML document and opens a browser widget showing it; `GET /:id` serves the stored HTML; `PUT /:id` updates it in place and reloads the widget; `DELETE /:id` and a clear-all route remove them, **cascading the owning widget** (deleting an artifact removes the browser widget that displayed it, and clearing a space deletes widget-owned artifacts). The Artifact entity persists in the docstore. CORS is threaded request-scoped through the read path for consistency with the rest of the application API. Documented in OpenAPI and taught to agents in the `tinstar` skill.

This is the surface stretchplan/papershore-style integrations use to render a roadmap or report straight onto the operator's canvas instead of shipping a bespoke widget.

Code: `src/server/stores/document-store.ts` (Artifact entity + CRUD, widget cascade), `src/server/api/routes.ts` (`/api/artifacts`), `src/server/api/openapi.ts`.

---

## Server-backed constellations

**Off `localStorage`, onto the document store.** v5.0's constellations kept their grouping in a client `localStorage` store. v5.1 moves the per-space constellation graph server-side: it persists in the document store, is mirrored to every client via SSE snapshot+delta (same channel as everything else), and is read/written behind the existing context surface so callers didn't change. The `localStorage` store is retired — closing the last documented prefs-in-localStorage gap from the `single config` line (`tinstar-layouts-v3` remains the one sanctioned cache).

**A pure graph model underneath.** Membership is now a real graph of `snapped`/`member` edges (`src/domain/constellationGraph.ts`): snapping a widget records a snapped edge, break-link re-derives membership from the surviving snap edges, and plugin widgets are included in `allNodeIds` so they aren't pruned out of slots. The write path is hardened — no-op PUTs short-circuit (no stuck optimistic overlay), malformed PUTs reject with `400` instead of hanging, persist failures are logged, and the graph is pruned when a widget or run is deleted. An optimistic ref-based overlay keeps the canvas responsive while a PUT is in flight, and the SSE path is jsdom-safe for tests.

Code: `src/domain/constellationGraph.ts` (pure model), `src/hooks/useConstellationGraph.ts`, `src/server/stores/document-store.ts` (per-space graph), `src/canvas/`.

---

## Add-widget — a real canvas spawn flow

**Grow a constellation in place.** Widget shells now show ghost `[+]` edge buttons on their *exposed* edges only (not on snapped seams). Clicking one opens an `AddWidgetPicker` popover of spawnable widgets; choosing one runs the `useAddWidget` orchestrator, which creates the widget, places it at that edge, and snaps it into the constellation in one atomic graph write. The join/form membership decision is a pure function, and `flushPosition` is shared between snap and add-widget so placement math has one home. Palette-installable plugins are `[+]`-spawnable by default; context-spawned widgets (file-editor, image-viewer) are not.

**Snappable, declared once.** A single `snappable` predicate gates both drag-to-snap and the `[+]` affordance. Non-container leaf widgets snap by default; containers never do; a widget opts out by declaring `snappable: false` in its manifest (now documented as a manifest field). Spawned widgets snap-on-create to their session's constellation (a shared `maybeSnapOnCreate`), so a file-editor opened from a session lands tiled next to it with full browser-widget parity — while an explicit canvas drop opts out of session-snap. A right-click on empty canvas offers **Move widget here**, relocating a widget out of its constellation to the clicked point (`CanvasContextMenu`, `buildMoveTargets`).

Code: `src/canvas/` (`AddWidgetPicker`, `useAddWidget`, `CanvasContextMenu`, `[+]` shell), `src/domain/` (`isSnappable`, join/form decision), `docs/plugins/README.md` (`snappable` manifest field).

---

## Widget catalog & capabilities

**Declarative, not a hardcoded list.** Built-in widgets declare their spawnable capabilities, `creator`, and `tags` on the registry; `useWidgetCatalog` derives the unified spawnable list (with `listWidgetRegistrations` as the host-only accessor) instead of a hand-maintained table. The manifest validator now checks a plugin's declared `creator`/`capabilities`/`tags`, and `listWidgetRegistrations` is kept host-only so external plugins can't double-count the catalog. **Browser widgets can now be standalone** — no session required — and are palette-listed and `[+]`-spawnable like any other widget, with a host placement API (`position`/`nearNodeId`/`slot`) for where they land.

Code: `src/plugins/` and `src/domain/` (widget registry, capabilities/creator/tags), `packages/plugin-api/src/index.ts` (declarative widget capabilities), `src/plugins/browser/` (standalone browser).

---

## Zero type baseline, locked by CI

**The ratchet closed.** v5.0 shipped with ~119 `tsc` errors against `tsconfig.app.json` (it was never the release gate then). v5.1 cleared the strict-null errors across product source *and* tests, bumped the app tsconfig to ES2022, and added a **typecheck ratchet to CI**: `.github/workflows/ci.yml` runs `npm run typecheck` (app + e2e + test projects) on every push/PR and fails on *any* type error, so the zero baseline can't regrow. A new `tsconfig.test.json` brings the root `tests/` Vitest suite under the gate, which previously had no `tsc` coverage. `npm run typecheck` is now a real release pre-flight, not a known-red check.

See **`docs/testing.md`** § *Type checking* for the exact commands and the one documented `node`-project wart (the dual-vite TS2769 in `vite.config.ts`).

Code: `.github/workflows/ci.yml`, `tsconfig.app.json`, `tsconfig.test.json`, `docs/testing.md`.

---

## Infrastructure hardening

The backend got more robust to the messy realities of running long-lived on one machine:

- **Single-instance lock.** A backend acquires a single-instance lock so a second copy can't silently fight the first over tmux/ttyd; `tinstar --force` bypasses the lock when you really mean to (`#singleton-lock`).
- **NATS health + reclaim.** Sessions monitor their NATS connection and reconnect on drop; ttyd processes are reclaimed/restarted rather than orphaned (`#nats-health`).
- **Service restart keeps its children.** The systemd unit uses `KillMode=process` so a restart preserves the tmux/ttyd/nats child processes instead of reaping the whole tree; a stray backtick in the unit template that broke parsing was fixed (`#service-restart`).
- **Survive `fs.watch ENOSPC`.** Exhausting inotify watches no longer crashes the server — it degrades instead.
- **Fail fast on a fatal bind error.** A startup port-bind failure exits clearly instead of limping along half-bound.
- **Static per-machine `.mcp.json`.** The NATS dev-channels `.mcp.json` is now static (env-token based) so it stops churning git on every session (see the `cc-channels-resolver-scope` memory).
- **Session-create consolidation.** `POST /api/sessions` now routes through one `createSessionInternal` path.

Code: `src/server/` (lock, NATS health, `execCommand`), `bin/tinstar.js` (`--force`, service unit), `src/server/api/routes.ts` (session-create consolidation).

---

## Smaller things worth knowing

- **Mermaid stability.** The file-editor's Mermaid blocks stopped flickering back to "loading"/"Rendering diagram…" and the SVG now actually renders (a ref/state catch-22 fix), with tests pinning the loading→SVG and loading→error transitions.
- **Mousewheel inside widgets.** Scrolling now targets the inner element under the pointer in Monaco (file) and iframe (browser) widgets, panning the canvas only when there's nothing to scroll.
- **Iframe-select.** Clicking an iframe widget body selects it (guarded against OS-level window blur so a background-window click doesn't mis-select).
- **Bracket-cycle follows the eye.** The ready-queue bracket-cycle now follows the *visible sidebar order* instead of an internal order.
- **Boundary-safe static serving.** The static file server rejects sibling-prefix path escapes (`/foo-evil` can't escape `/foo`).
- **Adjacency-aware resize.** Resizing a constellation member reflows neighbors using the final dragged size and re-snaps the group.

---

## Retired with this release

The V5.1 per-feature plans, the roborev-cockpit spec, and the constellation-graph / add-widget design notes were retired with the v5.1 merge — same pattern v5.0 used. The rationale above plus the two v5.0 ADRs cover the load-bearing decisions; individual specs live on in git history. The reverted roborev-specific server core (cli/stream/routes/template) is gone in favor of the generic primitives — if you want a worked example of a session-view plugin, read `src/plugins/roborev/` and `docs/plugins/README.md` § *Session-view widgets* rather than the old spec.
