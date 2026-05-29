# Tinstar v5.0 — feature reference

Single-source reference for every feature shipped in v5.0. Organized by subsystem. Points at the relevant code and existing timeless docs.

> **Why this doc exists:** v5.0 turned Tinstar's built-in widgets into a real plugin platform — a closed, versioned API contract that sibling projects (papershore, stretchplan) can build against without the host source tree — and landed the canvas, sidebar, and config work that platform needs to be usable. The fine-grained specs and audit punchlists that drove each feature have been retired now that the code (and the two ADRs below) are the authoritative source of behavior. This file captures the design decisions worth keeping, as a pointer map to the living code. Same pattern as `release-notes-v4-0.md`.

The two load-bearing decisions have their own ADRs and are not re-litigated here:
- **ADR 0001 — Response envelope** (`docs/adrs/0001-response-envelope.md`): every application API returns `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
- **ADR 0002 — Plugin API boundary** (`docs/adrs/0002-plugin-api-boundary.md`): the `@tinstar/plugin-api` contract, enforced with ESLint.

---

## Plugin platform — `@tinstar/plugin-api`

See **`docs/plugins/README.md`** for the full surface and **`docs/plugins/external-quickstart.md`** to author one; what follows is the *why*.

**A closed contract, not host imports.** Before v5.0 the built-in widgets (`browser`, `file-editor`, `image-viewer`, `nats-traffic`) reached directly into host modules — 11 distinct imports across the four. ADR 0002 expanded the published API to cover everything they actually used (`http.fetch`, `events.subscribe`, `canvas.fitWidget`, `hotkeys.onAction`, `hotgroups.useContext`/`Badge`, `watch.file`/`watch.image`, `theme.accent`, `WidgetProps<T>`), migrated all four built-ins to consume `api.*`, and **enforced the boundary with an ESLint rule** plus a vitest contract test asserting no host-runtime imports survive under `src/plugins/*`. The boundary is load-bearing precisely because the sibling-project integrations won't have the host source tree.

**Same lifecycle for built-in and external.** `bootAllPlugins` runs bundled and external plugins through one pipeline. A `PluginRegistry` owns lifecycle and `Disposable` teardown; per-plugin `try/catch` around `activate(api)` means one plugin's failure doesn't abort the boot loop, and failures surface in a `PluginFailedBanner` above the canvas rather than crashing the app. `createPluginApi` binds `widgets`+`logger` to a specific plugin record so log lines and registrations are attributable.

**Manifest + apiVersion handshake.** Each plugin ships a manifest; `TINSTAR_API_VERSION` is the host's contract version and the loader rejects mismatches rather than running against an API it can't satisfy. `definePlugin` is the typed authoring helper.

**External plugins load over HTTP, sandboxed by path.** `GET /api/plugin-runtime/*` serves `api`+`react` passthroughs (so a plugin shares the host's React, via importmap) and the plugin's own local files. `pluginRuntime` guards against symlink escape with `realpathSync`. The external loader applies a 10s timeout on the `package.json` fetch so a hung host doesn't wedge boot.

**`plugins.json` is the install registry.** `GET/PUT /api/plugins-config` read/write it; `writePluginsConfig` does an atomic write; `readPluginsConfig` is tolerant — a malformed entry is dropped with a logged reason rather than failing the whole file. The `PluginsTab` in settings toggles installed plugins on/off, and refuses to save before a successful initial fetch (so a transient read failure can't blank the config).

Code: `packages/plugin-api/`, `src/core/pluginApi/`, `src/core/pluginHost/`, `src/plugins/`, `src/server/api/pluginRuntime.ts`, `docs/plugins/`.

---

## Plugin widgets — first-class canvas citizens

See **`docs/plugins/README.md`** § WIDGETS palette and `api.widget.*`; what follows is the *why*.

**Plugins contribute widgets, the host owns placement.** `contributes.widgets[]` in the manifest declares spawnable widget types; the host renders them on the infinite canvas like any native widget. A **WIDGETS palette** in the left sidebar lists them (with plugin-resolved icons that also appear in the hierarchy tree); dragging one to the canvas shows a ghost outline and drops through a handler that wires it into the widget tree.

**Instance state lives in the docstore, rides the existing SSE channel.** A `pluginWidgets` collection in `document-store` holds per-instance data. `POST /api/plugin-widgets` validates against the widget registry; `PATCH /:id` does whole-`data` replacement; `DELETE`/`GET` round it out. Deltas propagate on the **existing** SSE delta channel — no new push path. Plugin code reads/writes its instance via `widget.useData<T>()`, with `widget.useDelete`, `widget.useInitialContext`, and `widget.useAttention` rounding out the hook surface.

**Attention is a host concept plugins can raise.** `widget.useAttention` lets a plugin flag itself as needing the operator's eyes; the host maps run-status transitions to the same `AttentionState`, so plugin and run attention are unified (see Inbox below).

Code: `src/server/stores/document-store.ts` (`pluginWidgets`), `src/server/api/routes.ts` (`/api/plugin-widgets`), `src/components/` (WIDGETS palette, drag/drop), `src/core/pluginApi/`.

---

## Constellations — grouping widgets on the canvas

**Renamed from "hotgroups."** The host-and-plugin-API rename to *constellations* went across the board (the keyboard-slot concept kept the `api.hotgroups` name where it was already published, to avoid breaking the contract mid-stream). A constellation is a derived grouping: centroid/bbox computed from live member layouts, with selection chrome drawn around the set.

**Move-as-one, with escape hatches.** Dragging any member moves the whole constellation; `alt`-drag pops a single member out. A digit hotkey is two-mode — first press selects+fits the slot, repeat presses cycle through its members. `Z` fits, `Shift+Z` tidies, `Backspace`/dissolve breaks it up and leaves clean paths.

**Magnetic snap + join.** Dragging a widget flush against a neighbor shows a snap-zone halo and joins them; snapping is gated to work-widget targets only, with break-link and outline-on-select for direct manipulation. Stale snap previews roll back on a failed drop rather than lingering. `SNAP_DISTANCE` is hoisted and `rectDistance`/`SnapWidget` de-duped so the math has one home.

**Capability registry.** Constellation behaviors are registered through `src/core/constellationCapabilities.ts` so the set is extensible rather than a switch statement.

Code: `src/core/constellationCapabilities.ts`, `src/components/ConstellationBadge.tsx`, `src/components/InfiniteCanvas.tsx`, `src/hooks/useCanvasHotkeys.ts`.

---

## Inbox — the second sidebar view

**A sidebar toggle, not a new panel.** The left sidebar now switches between **hierarchy** and **inbox** views (`sidebarView` in `UiPrefs`). The inbox shows *all* sessions, redesigned around an avatar/status row, and merges two attention sources via `useInbox`: run attention (mapped from status transitions server-side) and plugin attention (`widget.useAttention`). An idle→inbox signal surfaces sessions that have gone quiet.

**Read state is client-local.** `inboxReadKeys` in `UiPrefs` tracks what's been seen. Clicking a row uses a `flashAndFocus` helper to fly the canvas to the target and flash it — the inbox is a router into the canvas, not a separate workspace.

Code: `src/components/InboxList.tsx`, `src/components/InboxRow.tsx`, `src/hooks/useInbox.ts`, `src/server/stores/document-store.ts` (attention mutators), `src/lib/uiPrefs.ts`.

---

## Unified config — TinstarConfig replaces the scattered prefs

**One server-owned config, one client provider.** v5.0 finished the consolidation flagged across prior versions: `serverPrefs.ts` and `/api/server-prefs` are gone; everything lives in `TinstarConfig` behind `GET/PATCH /api/config`. The GET applies defaults; the PATCH deep-merges and validates (e.g. `uploadMaxBytes`). On the client, a `ConfigProvider` + `useConfig`/`useConfigPatch` wrap the React tree with a **debounced** patch so rapid UI changes coalesce into one write.

**Migrated consumers.** Widget layouts (`config.ui.layouts`, debounced-patch-backed), composer default, `showEmptyEntities`, telemetry-panel toggles, and upload size cap all read/write through config now. `tinstar-layouts-v3` remains the one documented localStorage exception (a cache, not the SSOT); other localStorage prefs were folded into the `uiPrefs` module. (See `feedback_single_config` memory.)

Code: `src/context/ConfigContext.tsx`, `src/server/sessions/config.ts`, `src/lib/uiPrefs.ts`.

---

## File upload — drag-drop onto the file tree

**Streaming multipart, optimistic rows.** `POST /api/sessions/:name/files/upload` streams through `busboy` (no full-file buffering); the destination resolves through the canonical `getSession()` so per-session dirs and worktree paths are honored. The UI is drag-drop onto the file tree with optimistic rows, a `FileUploadConfirmModal` doing per-row validation (portaled to `document.body` to escape the canvas transform), and a `useFileUpload` XHR hook with progress and abort. The size cap is configurable in File Explorer settings (`uploadMaxBytes`, read from `TinstarConfig`).

Code: `src/server/api/fileUploadRoute.ts`, `src/components/RunWorkspaceWidget/FileUploadConfirmModal.tsx`, `src/hooks/useFileUpload.ts`.

---

## Image paste + OCR in the prompt composer

**`RecapSessionPanel` is now `PromptComposer`.** The prompt-input component was renamed to its actual job and made the single source of truth for prompt input. Pasting a clipboard image uploads it to a **global** `POST /api/screenshots` endpoint, inserts an `@path` token, and shows a thumbnail in a `ThumbnailStrip` (cleared after a successful submit; blob URLs revoked on unmount). The endpoint destroys its write stream on size-limit overrun and handles client abort.

**OCR pre-pass so transcripts ride along.** `/api/screenshots` runs an OCR pre-pass, so the text content of a pasted image travels with the image into the transcript rather than being lost to a binary blob.

Code: `src/components/PromptComposer/`, `src/hooks/useScreenshotUpload.ts`, `src/server/api/` (`/api/screenshots`, `screenshotOcr`).

---

## Turn-length telemetry

**A new honest signal: how long agent turns take.** A `prom-client` histogram tracks turn length, fed by observers wired into `StatusWatcher` — a turn is observed on the next user line, and pending turns are flushed on session stop and on reconcile for sessions that disappeared (so a killed session doesn't strand a half-open turn). A ring buffer keeps recent observations for the live panels.

**Endpoints and panels.** `GET /api/metrics` returns the histogram; `GET /api/telemetry/turn-length` serves the per-session view. The UI is a responsive `TurnLengthHistogram` (it replaced an earlier heatmap that overflowed the sidebar), a per-session `TurnLengthPanel`, and a fleet-level `TurnLengthFleet` stat beside the duty-cycle stat in the HUD. Telemetry panels are individually toggleable in settings, and the fleet StatSparks honor those toggles.

Code: `src/server/observability/turn-length.ts`, `src/server/api/telemetry.ts`, `src/components/Telemetry/TurnLengthHistogram.tsx`, `src/components/RunWorkspaceWidget/TelemetryPanel.tsx`.

---

## Performance — short-circuit the hot paths

The docstore now skips work when nothing changed: `upsertRun` short-circuits on shallow-equal runs, `reconcileFiles` on identical file lists, `updateRunStatus` when the status is unchanged. `detectBranch` is cached by `.git/HEAD` mtime instead of shelling out every poll. And the redundant `broadcastSnapshot` after a NATS-driven widget upsert was dropped (the upsert already emits its own delta). These are invisible when they work — the point is fewer SSE frames and less CPU at idle, in service of the "feels like a video game" bar.

Code: `src/server/stores/document-store.ts`, `src/server/sessions/` (branch cache).

---

## Smaller things worth knowing

- **CLI typo guard.** Unknown `tinstar <command>` now rejects with a did-you-mean suggestion instead of silently starting the server (`bin/tinstar.js`).
- **NATS subject helpers.** Central `buildAgentSubject`/`parseSubject` replace ad-hoc string assembly; `sanitizeSubjectToken` broadened to strip non-ASCII. (See `docs/nats-agent-channels.md`.)
- **Typed window events.** The `tinstar:*` window-event registry is now a typed `EV` map rather than stringly-typed `dispatchEvent` calls.
- **Searchable worktree picker** in the create-session dialog.
- **`src/types.ts` consolidated into `src/domain/`** — domain types have one home; `src/domain/api.ts` owns the `ErrorCode` union from ADR 0001.
- **Config paths through `getConfigRoot()`** — `slash-usage.json` was the last straggler still using `homedir()` directly.

---

## Retired with this release

The V5.0 audit punchlist, the per-feature plans, and `docs/v4.1-punchlist.md` were retired with the v5.0 merge — same pattern v4.0 used. The rationale above plus the two ADRs cover the load-bearing decisions; individual specs live on in git history. The undocumented patterns the audit surfaced were folded into `docs/conventions.md` (new in this release) rather than left scattered.

The **canned-prompts sample plugin** that briefly shipped to exercise the capability registry was reverted before release — it was a demo, not a feature. If you want a worked example of an external plugin, follow `docs/plugins/external-quickstart.md` instead.
