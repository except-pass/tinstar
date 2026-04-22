# Tinstar v3.7 — feature reference

Single-source reference for every feature shipped in v3.7. Organized by subsystem. Points to the relevant code and existing timeless docs.

> **Why this doc exists:** v3.7 landed ~230 commits. The fine-grained design specs that drove each feature (`docs/superpowers/plans/`, `docs/superpowers/specs/`) have been retired now that the code is the authoritative source of behavior. This file captures the design decisions worth keeping, as a pointer map to the living code.

---

## Multi-agent orchestration

### Patterns (`docs/multi-agent-patterns.md`, `docs/patterns-v2.md`)

Task creation accepts a pattern (Single / Sequential / Parallel / Coordinator / Review & Critique). On create, Tinstar spawns all sessions described by the pattern, auto-wires NATS subscriptions from the task's entity hierarchy, and injects pattern-specific prompts.

Pattern files live in `~/.config/tinstar/patterns/*.md` with YAML frontmatter. Template interpolation is Jinja-style (`{{task}}`, `{{orchestrator}}`, `{{worker}}`). Code: `src/server/patterns/`.

**Design note — no layout enforcement.** Pattern-specific canvas layouts arrange widgets on spawn but aren't re-applied after drag. Users own their canvas; the pattern is a seed, not a constraint.

**Design note — 2-agent cap for Review & Critique.** The orchestrator wears two hats (coordinator + reviewer). Single point of contact for the user, while still enabling a real critique loop.

### Hands (ad-hoc collaborators)

Hand definitions in `~/.config/tinstar/hands/*.md` describe reusable collaborator roles. `POST /api/sessions/:parent/spawn` creates a child session on the same task/worktree; `HandsPanel` drag-to-canvas does the same from the UI. Code: `src/server/hands/`, `src/components/HandsPanel.tsx`.

**Design note — first agent is the orchestrator by default.** Override via `{"orchestrator": true}` in the spawn body or explicit `orchestrator:` field in a pattern. `parentId` is tracked on the child's run for lineage in the service registry.

**Design note — discovery happens via NATS, not a registry.** Spawned agents announce themselves on the task broadcast subject; other agents respond. No central bookkeeping; orchestrators track who's online from message flow.

### NATS agent channels (`docs/nats-agent-channels.md`)

Subject scheme: `tinstar.<space>.<init>.<epic>.<task>.<agent>`. Each agent auto-subscribes to its direct subject, task broadcast (`*`), and ancestor wildcards (`>`). External dependency: `github:except-pass/nats-channel-mcp`, launched via `bun x` with `--subscribe` and `--control-socket` args from `generateNatsMcpConfig` (`src/server/sessions/backends/tmux.ts`).

**Breakout rooms.** At spawn time, the server generates `tinstar.room.<uuid8>`, adds it to the child's initial subscriptions, hot-subscribes the parent via its control socket, and injects it into the child's system prompt as the parent-child DM address. `breakoutRooms: string[]` on the run tracks active rooms. Code: `POST /api/sessions/:parent/spawn` in `src/server/api/routes.ts`.

**Orphan recovery** (late-v3.7). The external package's startup sequence is `unlinkSync(path); listen(path)` — any collision orphans the live listener (kernel's unix socket table still shows LISTEN on an inode the file no longer points to). Spawn now pre-flight-tests the parent's control socket. On `NATS_SOCKET_ORPHANED` (ECONNREFUSED + file present) or `NATS_SOCKET_UNREACHABLE` (ENOENT), the child's breakout room falls back to the parent's persistent direct subject (subscribed at startup, unaffected). Response returns `breakoutFallback`, `fallbackReason`, `restartRecommended`. Session record persists `natsControlOrphanedAt` and emits `managed_session.nats_orphaned` SSE for dashboard surfacing; cleared on session restart.

### NATS server lifecycle (NatsManager)

`nats-server` is now an embedded binary supervised by Tinstar the same way ttyd is. Installs on first launch (`~/.config/tinstar/bin/`), probes via `nats connect/close`, SIGTERM→SIGKILL graceful shutdown cascade, state recorded under `~/.config/tinstar/nats/`. `TINSTAR_FAST_SIM=1` bypasses the real server for tests. Code: `src/server/nats/`. Shared infra (Supervisor, binary installer, lock, `ServiceState`) lives in `src/server/infra/` so both the NATS manager and the observability stack reuse it.

**Default port 4222**, configurable via `NATS_PORT`. Bound to loopback only.

---

## Telemetry & observability

### Embedded Prometheus + Alloy stack

Same subprocess model as NATS. Binaries pinned in `src/server/observability/manifest.ts`, downloaded with SHA256 verification, supervised with readiness probe + crash restart (capped backoff) + PID adoption. `docker-compose` path remains as `npm run dev:observability` for power users; default Tinstar startup uses the embedded stack.

**Config rendering.** Prometheus + Alloy templates live inline in `src/server/observability/config-render.ts` (inline because esbuild was dropping external templates on bundle). Substitutions are asserted — if a placeholder survives rendering, startup fails loudly.

### Telemetry HUD + per-session bars

`T` hotkey toggles the CanvasHud in the upper-right (mirror of the minimap in the lower-right). Bars: cost (byModel), tokens, rate/min, cache-hit %. Autonomy is a **ratio dial** (no natural ceiling — `cli_time / user_time`) displayed as `"4.52×"` on a 1:1–10:1 scale. Same component library renders a "Session" section at the top of each RunWorkspace's TelemetryPanel sidebar, scoped by `tinstar_session` label.

**Typed API, no PromQL passthrough.** `GET /api/telemetry/hud` and `GET /api/telemetry/session/:name` return structured shapes. SSE channels `telemetry:hud` and `telemetry:session:<name>` push updates; server polls Prometheus ~1.5s and diffs.

**HUD scope:** all Tinstar activity today (since local midnight), filtered by `user_email`. **Session scope:** single `tinstar_session`, session lifetime.

### Context treemap

Below Procedures in the RunWorkspace right panel. Uses `squarify` (~2KB) for layout math only; rendering is absolute-positioned divs colored by the run's accent at per-rank opacity. `GET /api/sessions/:name/context` spawns a sidecar Claude Code process that forks the running conversation and queries `get_context_usage` — returns messages / tools / skills / memory / free-space breakdown. 30s result cache; concurrency-guarded (only one sidecar per session).

**Claude-only.** Codex sessions return 400. Sessions without a `conversation.id` return 404.

---

## Run Workspace widget

### Prompt composer

Collapsible composer below the terminal. `P` toggles (widget-scoped), `Ctrl+Enter` sends, `Escape` forwards to the terminal, `Ctrl+[ / Ctrl+Shift+[` cycle sessions while focused. Default-open is configurable per-user under Settings → Widgets.

**Per-session history recall.** `↑` in an empty textarea (or the history icon button) opens `PromptHistoryPopover` showing the last 20 sends, newest first. In-memory only, session-scoped. Selection replaces textarea content and refocuses with caret at end. Duplicates kept. Hook: `src/hooks/usePromptHistory.ts`. Voice-to-text input is available in the same composer.

### Header redesign

Right-zone action buttons are now full-height stacked-label buttons (icon on top, 8px uppercase label below) — Color / Browser / Refresh / Stop (or Resume) / Delete. Stop+Delete form a visual danger group (no separator). Tooltip on Refresh explains it re-registers the proxy route for the browser widget.

---

## File editor widget

### Markdown renderer + Mermaid

For `.md` files, a **Rendered** toggle button (defaults ON) switches from Monaco to `MarkdownRenderer` — `react-markdown` + `remark-gfm` with Tinstar dark-palette styling. `wrap` and `diff` buttons hide in rendered mode.

**Mermaid is lazy-loaded.** `MermaidBlock` imports the `mermaid` package only when a diagram block is present; SVG injected via `dangerouslySetInnerHTML`, dark theme with Tinstar palette.

**Local markdown links open as nearby widgets.** Relative paths dispatch `tinstar:open-linked-file` CustomEvent on the source widget; `InfiniteCanvas` spawns a new editor widget 680px to the right (width 640 + 40px gap). `.md` links inherit rendered mode. External URLs `window.open` in a new tab.

### Diff view

Header toggle shows diff against HEAD for files in git-tracked worktrees.

---

## Canvas & UX

### Minimap

StarCraft-style overlay in the bottom-right (200×140, semi-transparent dark panel). Renders every work widget (not containers) as an accent-colored rectangle, plus a viewport indicator (hollow 1.5px white rect). Click-to-pan, drag-to-pan (pan only — no zoom from the minimap). `M` toggles visibility (persisted via `tinstar-minimap-visible` localStorage). Pure `<canvas>` with imperative 2D drawing — no React nodes per widget. Redraws on camera/layouts change; no rAF loop.

### Fit-to-viewport (`Z`)

On any content widget: `Z` sets zoom to 100%, resizes the widget so height equals the viewport height, and centers it horizontally. Width untouched. Single `setCamera` call — commits in one frame. Idempotent.

Plumbed via `src/hotkeys/canvasActionsRegistry.ts` — a module-level registry matching the existing `actionHandlerRegistry` / `bindingFiredBus` pattern. `InfiniteCanvas` registers the impl; each content widget's action handler adds one case: `if (action === 'fit-viewport') fitWidgetToViewport(id)`.

`Alt+Z` resets zoom to 100% while preserving the viewport center — now listed in the hotkeys sidebar.

### Misc

- Subpixel rounding on widget positions + camera translate — fixes fuzzy text at non-integer offsets.
- `+` hotkey creates a child entity with auto-open settings.
- `H` toggles the "show empty entity containers" filter across sidebar and canvas.
- `E` opens entity settings for the selected initiative / epic / task.
- Per-run visibility toggle (eyeball icon) in the hierarchy sidebar.
- Random color button on ColorPalette; new runs get a randomized accent by default.

---

## Browser widget

- Dev console panel captures `console.log` via a same-origin proxy.
- Reverse-proxy responses rewrite absolute paths so the embedded browser resolves them against its base.
- Drag to spawn, drag to move. `Z` fits to viewport like other widgets.

---

## Session model & entity settings

### CLI templates

Replaces the old `skipPermissions` toggle + backend chooser. Every CLI template declares `startCmd` / `resumeCmd` with `{sessionId}` and `{prompt}` placeholders, plus an `adapter` field that picks the transcript parser. Built-in defaults: Claude (auto), Claude (interactive), Claude (multi-agent), Codex (full auto). User-defined templates in `~/.config/tinstar/config.json`. Exposed via `GET/POST/DELETE /api/cli-templates` and Settings → Agents.

**Entity-settings inheritance.** `cliTemplate` is now a field on Initiative/Epic/Task. Sessions spawned under an entity resolve the template via hierarchy (task > epic > initiative > space default). Legacy sessions without `cliTemplate` fall back to the old `skipPermissions`-based command builder.

### Codex transcript adapter

Discovery works after-the-fact (Codex picks its own session id). Algorithm: list `~/.codex/sessions/YYYY/MM/DD/*.jsonl` since the session's creation date, filter by `payload.cwd == session.workspace.path` on the `session_meta` first line, then text-match agent-message text against the tmux pane capture. Result cached per session; self-heals if the cached file stops being written. Status derived from explicit `event_msg.payload.type` (`task_started` → running, `task_complete` → idle) — no process-tree heuristic needed. Recap entries extracted from `user_message` + `task_complete.last_agent_message`. Code: `src/server/sessions/codex-transcript.ts`.

### Process-tree status detection

For any tmux session with a pending tool_use in JSONL, check the agent's child processes. No children = blocked on permission/input → flip to idle. Debounced two polls in each direction to prevent flapping. Universal fallback when no adapter is configured. Replaces all hooks (`file-touched`, `file-read` endpoints removed — file tracking covered by the 5s git diff poll). Poll interval: 2s.

### Permission-blocked detection

Session status watcher distinguishes "Claude is thinking" (trust JSONL) from "Claude is waiting on a tool_use permission prompt" (process tree says no children). Flipped to idle so the Ready queue picks it up.

---

## Entity labels

Per-space rename of hierarchy levels (Initiative → Epic → Task is the default; teams can rename to Client → Project → Ticket, or compress to 1–2 levels). Stored on `Space.labelConfig.levels[]`. Leaf level always maps to internal type `task` and cannot be removed. Auto-pluralized client-side unless `plural` is provided. New Settings tab + live preview. `GroupingControls` removed — level order is fixed top-to-bottom by the internal mapping.

**One-time localStorage migration** on first load: if the active space has no `labelConfig`, derive it from `tinstar-dimensions` and `PATCH /api/spaces/:id`. Only deletes the localStorage key on successful PATCH; retries on next load otherwise.

---

## Image viewer widget

Drop any image file from the Changed Files / Explorer panel onto the canvas. Reuses the existing `application/tinstar-editor` drag MIME; the drop handler branches on file extension. Natural size read at creation via `image-size`; spawn dims capped at 1200×900.

**Live updates are version timestamps, not bytes.** `GET /api/image-watch` SSE sends `{type:'updated', timestamp}` on file change; the `<img>` cache-busts via `?t=<timestamp>` on `/api/image-file`. Binary bytes never flow over SSE. Supported: `.png`, `.jpg/.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`.

---

## `tinstar doctor`

`npx tinstar doctor` walks the full stack: system deps (tmux, ttyd, docker, git, claude auth), config, server (auto-detected via `~/.config/tinstar/server.port` written on startup), persistence (orphan runs, stuck `.deleting` markers), per-session health (tmux alive / ttyd HTTP / ttyd WebSocket / proxy chain), skills. Grouped pass/fail output with a summary; exits 1 on any failure. The WebSocket probe is the one that catches the "black ttyd" class of bugs — ttyd responds to HTTP but fails the WS upgrade.

---

## What got removed

- `GroupingControls` chip bar (level reorder/add) — replaced by Settings → Entity Labels.
- `file-touched` / `file-read` hook endpoints.
- `installHooks` / `removeHooks` machinery — file tracking is now the git diff poll + process-tree status watcher.
- Old hardcoded `patterns.ts` — replaced by file-based pattern discovery under `~/.config/tinstar/patterns/`.

---

## Retired design docs

Plans under `docs/superpowers/plans/` and specs under `docs/superpowers/specs/` were retired with the v3.7 merge. The rationale captured above covers the load-bearing design decisions; individual specs live on in git history (`git log --all --oneline -- docs/superpowers/specs/<file>`).
