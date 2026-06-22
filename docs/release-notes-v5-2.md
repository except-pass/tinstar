# Tinstar v5.2 — feature reference

Single-source reference for every feature shipped in v5.2. Organized by subsystem. Points at the relevant code and existing timeless docs.

> **Why this doc exists:** v5.0 shipped the plugin *platform* and v5.1 turned it into an *ecosystem*. v5.2 turns the canvas itself into a richer workspace and gives you a handle on *which model* your fleet is running. Three throughlines: **(1) Notes are now first-class everywhere** — a unified, threaded pin/note system lives on every widget (runs, browser, shell, plugin primitives), replacing the browser-only NotesOverlay; you drop a note on a spot, the agent answers in a thread, you resolve it. **(2) The canvas gained a real geometry** — a pure 8-anchor model drives magnetic drag-snap, anchor-to-anchor placement, move-existing-widget, S/M/L size presets, and arrange-as-rigid-clusters. **(3) Switchboard** makes the model layer visible and controllable — a read-only model-attribution viewer plus an opt-in, fail-closed per-session model/token override. Underneath, Tinstar now runs on **Windows via WSL2**, plugin servers grew lifecycle + health UI, and the session-write path was hardened against hangs. The per-feature plans and audit punchlists that drove each of these have been retired; this file is the pointer map to the living code. Same pattern as `release-notes-v5-1.md`.
>
> No new ADRs this release — v5.2 builds on the two from v5.0 (`docs/adrs/0001-response-envelope.md`, `docs/adrs/0002-plugin-api-boundary.md`). Every API added below returns the ADR-0001 envelope and lives behind the ADR-0002 boundary.

---

## Pins — threaded notes on every widget

**The headline of v5.2.** v5.1's browser widget had a one-off "NotesOverlay" for annotating a page. v5.2 generalizes that into a first-class, canvas-wide **pin** system that any widget can host — a run workspace, a browser, a shell, or a plugin primitive.

- **Pure domain model.** A `PinSet` is a per-space, revision-gated docstore store: each pin carries normalized `nx/ny` coordinates (relative to its widget's content box, so it survives resize/zoom), a comment, optional `replies`, and a `resolvedAt`. Node GC drops pins whose widget is gone.
- **Threaded conversation.** A pin isn't a sticky — it's a thread. You drop a note, it sends to the agent backing the widget, and the agent's answer lands as a reply in the bubble; you can follow up or **resolve**. Unread/resolved marker states and per-viewer read tracking are local (never synced).
- **Drag-to-place, type-immediately.** Hovering a pinnable widget shows the affordance; you drag to place a ghost preview, drop, and the new note opens focused so you can type without a second click. `Ctrl/Cmd+Enter` sends (matching the prompt composer); plain Enter is free for multi-line.
- **Native + browser + shell.** Native widgets capture *semantic* context at the drop point (`elementFromPoint`) to enrich the message; the browser widget self-renders shared pins with scroll-glue + DOM enrichment (dropping the old NotesOverlay); the shell widget gets a default `PinLayer`. A plugin provides capture through the **`api.pins.useProvideCapture`** front door.
- **Migration is automatic.** A one-time, idempotent, per-space migration lifts old browser notes into the unified pinSet.

Code: `src/domain/pinSet.ts` (pure model), `src/pins/` (`PinMarker`/`PinBubble`/`PinLayer`, gesture engine, reply-prompt builder), `src/hooks/usePinSet.ts`, `src/server/api/routes.ts` (`PUT /api/pins/:spaceId`, `POST /api/notes/:id/replies`), `packages/plugin-api/src/index.ts` (`api.pins`, `Pin.replies`/`resolvedAt`, `Reply`).

---

## Canvas geometry — anchors & magnetic snapping

The canvas grew a real placement model instead of ad-hoc x/y math.

- **Pure 8-anchor model.** Every widget exposes a validated set of default anchors (edges + corners); plugins can declare per-widget anchors in their manifest. Placement is expressed as *anchor-to-anchor*: "this widget's left-center flush against that widget's right-center."
- **Magnetic drag-snap.** Dragging a snap-eligible widget resolves the nearest anchor pair and snaps flush; an in-drag reminder shows that **Alt bypasses** the magnet. Snap edges are structured and carry the chosen anchor pair, which is persisted (manual snaps and `[+]` add-widget both record it).
- **Move-existing-widget.** The edge-`[+]` picker can relocate an already-open widget to an anchor slot (`moveSnapWidgetTo` orchestrator + shared `EDGE_ANCHORS`), with agent icons shown in the "Move widget here" menus.
- **Arrange as clusters; preserve size.** Arrange now treats snap-attached widgets as rigid clusters (they move together) and preserves each widget's size rather than normalizing it. **S/M/L presets** give viewport-relative resize, configurable via `ui.widgetSizePresets` (per-type aspect).

Code: `src/canvas/` (anchor geometry, snap resolver, `EDGE_ANCHORS`), `src/components/InfiniteCanvas.tsx`, `src/hooks/useWidgetLayouts.ts`, `src/widgets/widgetSizePresets.ts`, `src/server/sessions/config.ts` (`ui.widgetSizePresets`).

---

## Switchboard — model visibility & control

A two-part effort to surface and steer which model each session runs. Both halves are independent and safe to take on their own.

### Model-attribution viewer (read-only)

`readLatestModel()` reads the latest `assistant` record's `message.model` from a session's transcript — a cheap tail read, no extra process, derived (never persisted). Exposed as a `model` field on each session in `GET /api/state` and a dedicated `GET /api/sessions/:name/model`. A bundled **`model-attribution`** plugin renders a "Models" widget: per-session model, cc-quota 5h/7d headroom, and fleet `byModel` cost chips. The read is cached per transcript (keyed by mtime+size) so a polled fleet doesn't re-read disk, and a busy session's model stays sticky rather than flickering to "—".

Code: `src/server/sessions/transcript-parser.ts` (`readLatestModelAt`, cache), `src/server/api/routes.ts` (`/model`, `/api/state` enrichment), `src/plugins/model-attribution/`.

### Per-session model/token override (opt-in, fail-closed)

A session can be created or spawned with an optional `model` and/or `token` so it launches with a specific model and/or a distinct `CLAUDE_CODE_OAUTH_TOKEN` (quota isolation). **Completely inert unless used**: with no override the launched env is byte-identical to before. A **fail-closed startup guard** (`validateSessionOverride`) rejects a disallowed model or a disabled/malformed token *before* any side effect, gated by config (`switchboard.allowedModels` + `allowTokenOverride`, both default-closed). The model is persisted (`modelOverride`, re-applied on `/start`); the token is **spawn-time-only** — never persisted, returned, or logged, and re-suppliable on `/start` so a restart keeps quota isolation.

Code: `src/server/sessions/config.ts` (`validateSessionOverride`, `applyTokenOverride`), `src/server/api/routes.ts` (create/spawn/start wiring), `src/server/sessions/backends/tmux.ts` (`--model` insertion).

---

## Windows / WSL2

Tinstar now runs on Windows via **WSL2**, where the session backend (tmux + ttyd + NATS) actually works (native Windows disables all three). `docs/running-on-windows-wsl.md` is the step-by-step. Separately, tmux copy-mode selections now reach the **host OS clipboard** (OSC-52 + a resolved clipboard tool — `clip.exe`/`pbcopy`/`wl-copy`/`xclip`/`xsel`, first available wins), which helps Mac/Linux too.

Code: `docs/running-on-windows-wsl.md`, `src/server/sessions/backends/tmux.ts` (`resolveClipboardCommand`, copy-mode binds).

---

## Plugins — server lifecycle & health

Plugins that ship a backing server (`PluginServerSpec` in the manifest) now have a lifecycle UI: `/api/plugin-servers` status/start/log routes, a **ServerStatusDot** on each WIDGETS palette tile with a start popover, cached + deduped backend health checks, and per-plugin log files. The WIDGETS palette itself was redesigned to an **icon-tile grid** with per-widget icons. (Path-traversal guard: plugin-server log reads are scoped to known plugins.)

Code: `src/server/api/routes.ts` (`/api/plugin-servers/*`), `src/components/` (palette, `ServerStatusDot`), `packages/plugin-api/src/index.ts` (`PluginServerSpec`).

---

## Reliability & polish

- **Session-write hangs eliminated.** Every tmux command runs with a 10s timeout, so a wedged tmux server rejects fast (clean 5xx) instead of hanging `POST /api/sessions` / `/prompt` forever; session-write endpoints go through a shared `withBody` guard so a throw before the handler's `try` can't strand the socket either.
- **New sessions reliably hit the canvas.** New-run layouts are merged into state functionally so a freshly created run can't end up in the hierarchy-but-not-canvas limbo until you press Arrange.
- **Pin notes stay on the canvas.** The portaled note bubble clips to the canvas viewport, so panning (e.g. clicking inbox sessions) no longer spills a note onto the sidebar.
- **ttyd / NATS / editor.** Stale cross-port ttyds are reaped on restart; the advertised NATS DM subject is derived from the computed subscriptions (not the space-blind builder); "Open in Editor" probes for a *live* VS Code/Cursor IPC socket before opening.
- **Settings.** Epic-seated tasks without a direct `initiativeId` inherit the initiative tier through their epic.
- **Smaller wins.** Recap pane renders markdown; context-meter capacity warning colors; searchable/filterable create-session task picker; `npm run lint` catches phantom Tailwind classes against the custom palette.

Code: `src/server/sessions/backends/tmux.ts`, `src/server/api/routes.ts` (`withBody`), `src/hooks/useWidgetLayouts.ts`, `src/pins/PinBubble.tsx`, `src/server/sessions/entity-settings.ts`.
