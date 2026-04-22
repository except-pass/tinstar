# Tinstar Architecture

Tinstar is a real-time dashboard for orchestrating and monitoring Claude Code sessions. It provides a visual workspace where users manage hierarchical entities (initiatives, epics, tasks), launch isolated coding sessions (via Docker or tmux), and observe progress through live-streamed state updates.

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 18, TypeScript 5.7 | Hooks + context, no class components |
| Styling | Tailwind CSS 3.4 | Dark-mode-only, custom cyberpunk theme |
| Fonts | Chakra Petch (display), JetBrains Mono (mono) | Loaded from Google Fonts |
| Build | Vite 6 | Dev server + production bundler |
| Backend | Vite plugin (Node.js) | Runs inside the Vite dev server process |
| Terminal proxy | Caddy 2 (Docker container) | Reverse-proxies ttyd terminals |
| Terminal emulator | ttyd + xterm.js | Web-based terminal inside iframes |
| Session isolation | Docker containers or tmux sessions | Two interchangeable backends |
| E2E tests | Playwright 1.58 | Runs against `TINSTAR_FAST_SIM=1` dev server |

No external state management library (Redux, Zustand, etc.). State flows from the server via SSE and is held in React state + in-memory repositories.

---

## High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser                                 │
│                                                                 │
│  ┌──────────────┐   SSE stream    ┌──────────────────────────┐  │
│  │ EventSource  │◄────────────────│  React state + repos     │  │
│  │ /api/events  │   (snapshot +   │  (RunRepo, TaxonomyRepo) │  │
│  └──────────────┘    deltas)      └──────────┬───────────────┘  │
│                                              │                  │
│  ┌──────────────┐   fetch()       ┌──────────▼───────────────┐  │
│  │ REST calls   │────────────────►│  Components + Canvas     │  │
│  │ POST/PATCH/  │                 │  (GroupingControls,       │  │
│  │ DELETE       │                 │   HierarchySidebar,       │  │
│  └──────────────┘                 │   InfiniteCanvas, etc.)   │  │
│                                   └──────────────────────────┘  │
│  ┌──────────────┐                                               │
│  │ localStorage │  tinstar-dimensions, tinstar-layouts-v3       │
│  └──────────────┘                                               │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ ttyd iframes (one per session, proxied through Caddy)    │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         │ fetch              ▲ SSE
         ▼                    │
┌─────────────────────────────────────────────────────────────────┐
│                    Vite Dev Server (:5273)                       │
│                                                                 │
│  ┌────────────┐    ┌────────────┐    ┌───────────────────────┐  │
│  │ API Routes │───►│ Event Bus  │───►│ SSE Broadcaster       │  │
│  │ /api/*     │    │ (pub/sub)  │    │ (snapshot + deltas)   │  │
│  └────────────┘    └─────┬──────┘    └───────────────────────┘  │
│                          │                                      │
│               ┌──────────▼──────────┐                           │
│               │    Processors       │                           │
│               │  (Document, OTel)   │                           │
│               └──────────┬──────────┘                           │
│                          │                                      │
│               ┌──────────▼──────────┐                           │
│               │   Document Store    │──► ~/.config/tinstar/     │
│               │   (in-memory +      │     docstore.json         │
│               │    file-backed)     │                           │
│               └─────────────────────┘                           │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Session Manager                                          │   │
│  │  ├─ Docker backend (containers + volume mounts)          │   │
│  │  ├─ Tmux backend (local tmux sessions + ttyd processes)  │   │
│  │  ├─ Caddy proxy (dynamic route registration)             │   │
│  │  └─ Reconciler (30s poll, corrects stale states)         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         │                    ▲
         │ docker exec /      │ HTTP hooks
         │ tmux send-keys     │ /api/hooks/*
         ▼                    │
┌─────────────────────────────────────────────────────────────────┐
│  Session (Docker container or tmux session)                     │
│                                                                 │
│  tmux "main" ──► Claude Code ──► hooks fire on activity         │
│       ▲                                                         │
│       │                                                         │
│  ttyd (:7681) ──► xterm.js ──► tmux attach                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Backend Architecture

The backend is a **Vite plugin** (`tinstarBackend()` in `src/server/index.ts`) that hooks into Vite's `configureServer()`. It runs in the same Node process as the dev server — no separate backend process.

### Core modules

| Module | File(s) | Purpose |
|--------|---------|---------|
| Event Bus | `src/server/event-bus.ts` | Typed pub/sub. All state mutations flow through here as discriminated-union events (`session.*`, `run.*`, `taxonomy.*`, `otel.*`, `managed_session.*`). |
| Document Store | `src/server/stores/document-store.ts` | In-memory maps for initiatives, epics, tasks, worktrees, and runs. Emits `change` events on every mutation. Debounced file persistence (500ms) to `docstore.json`. |
| OTel Store | `src/server/stores/otel-store.ts` | In-memory span and metric storage indexed by trace ID. |
| Document Processor | `src/server/processors/document-processor.ts` | Subscribes to bus events, writes into document store. |
| OTel Processor | `src/server/processors/otel-processor.ts` | Subscribes to bus events, records spans/metrics. |
| SSE Broadcaster | `src/server/api/sse.ts` | Pushes document store changes to all connected browsers. Sends full snapshot on connect, then incremental deltas. 15s heartbeat. |
| API Routes | `src/server/api/routes.ts` | REST endpoints for CRUD, session management, hooks, and simulator control. |
| Session Manager | `src/server/sessions/` | Docker + tmux backends, Caddy proxy, reconciliation, workspace/worktree management. |
| Simulator | `src/server/simulator/` | Mock event generator for development and testing. |
| Observability | `src/server/observability/` | Supervises embedded Prometheus + Alloy subprocesses. Downloads platform-matched binaries to `~/.config/tinstar/bin/` on first launch, enforces a pidfile-based singleton lock, and exposes a typed PromQL query layer. Snapshots are served via `/api/telemetry/hud` and pushed over SSE to the canvas HUD. Disabled with `TINSTAR_TELEMETRY=0`; under `TINSTAR_FAST_SIM=1` the supervisor short-circuits to a synthetic fixture. |
| Logger | `src/server/logger.ts` | Structured logging to console + `~/.config/tinstar/server.log`. Format: `[ISO] [LEVEL] [TAG] message {json}`. |

### Startup sequence

1. Instantiate event bus, stores, processors, SSE broadcaster
2. Load config from `~/.config/tinstar/config.json` (merge with defaults)
3. Enable document store file persistence; load existing `docstore.json`
4. Rehydrate sessions from `~/.config/tinstar/sessions/` into document store
5. Reconcile session states against actual Docker/tmux state
6. Start Caddy reverse proxy; sync routes from active sessions
7. Start 30-second periodic reconciliation loop
8. Attach HTTP middleware to Vite server
9. If `TINSTAR_FAST_SIM=1`: clear persisted data, start simulator

### REST API

Full endpoint reference with schemas and examples: **[`/api/docs`](http://localhost:5273/api/docs)** (OpenAPI 3.0 / Scalar UI). Raw spec at `/api/docs/openapi.json`.

Key endpoint groups: Entity CRUD, Sessions, Hooks, Settings, Spaces, OTel, Simulator.

---

## Session Backends

Sessions are isolated environments where Claude Code runs. Two interchangeable backends:

### Docker backend (`src/server/sessions/backends/docker.ts`)

| Step | What happens |
|------|-------------|
| Create | `docker run -d` with workspace volumes, env vars, port mapping. Container name: `tinstar-{sessionName}`. |
| Start Claude | `docker exec` runs `start-ttyd.sh` which creates a tmux session inside the container, then starts ttyd on port 7681. |
| Stop | `docker stop -t 5` (graceful 5s shutdown). |
| Delete | `docker rm -f`. |

**Volume mounts:**
- `{sessionStateDir}` → `/home/tinstar/.claude/projects` (Claude state persistence)
- `{workspacePath}` → same absolute path (workspace files)
- `{basePath}/.git` → same path (for git worktree support)

**Environment injected into container:**
- `TINSTAR_SESSION_NAME`, `TINSTAR_DASHBOARD_URL`
- `SESSION_ID` / `RESUME_SESSION_ID` (Claude session identity)
- `WORKSPACE_DIR`, `SKIP_PERMISSIONS`
- Secrets from `~/.config/tinstar/.secrets/`

### Tmux backend (`src/server/sessions/backends/tmux.ts`)

| Step | What happens |
|------|-------------|
| Create | `tmux new -d -s tinstar-{name}` in workspace directory. |
| Configure | Mouse on, status bar off, inject secrets + session vars into tmux env. |
| Run Claude | `tmux send-keys` with `claude --session-id {id}` command. |
| Start ttyd | Spawn `ttyd` process; auto-restart on crash (2s backoff). |
| Stop | Kill tmux session + ttyd process. |

**Port allocation:** Finds available port in range 8681-8780 (100 ports max).

### Claude Code hooks

Both backends install hooks into `.claude/settings.json` in the workspace:

| Hook event | Calls | Purpose |
|------------|-------|---------|
| `Stop` | `/api/hooks/idle` | Claude finished and went idle |
| `PreToolUse` | `/api/hooks/active` | Claude is about to use a tool |
| `UserPromptSubmit` | `/api/hooks/active` | User sent a prompt |
| `PostToolUse` (Write/Edit) | `/api/hooks/file-touched` | Claude edited a file |

Hooks filter on `$TINSTAR_SESSION_NAME` so they only fire for managed sessions.

### Caddy reverse proxy (`src/server/sessions/caddy.ts`)

Provides unified terminal access at `http://localhost:8088/s/{sessionName}/`. Runs as a Docker container with an admin API on port 2019. Routes are added/removed dynamically via REST calls to the admin API as sessions are created/destroyed.

The Vite dev server proxies `/s/` → `localhost:8088` so the frontend accesses terminals through the same origin.

### State reconciliation (`src/server/sessions/reconcile.ts`)

Runs on startup and every 30 seconds:

1. For Docker sessions: `docker inspect` to check container state. Missing/exited → `stopped`.
2. For tmux sessions: `tmux has-session` to check existence. Missing → `stopped`.
3. Stale detection: if a session is `running` but hasn't been active for >2 minutes → `needs_attention`.

---

## Frontend Architecture

### Entry points

`index.html` → `main.tsx` → `App.tsx` → `WorkspaceShell.tsx`

`WorkspaceShell` is the root component. It wraps everything in a `SelectionProvider` and renders the top bar, sidebar, canvas, and dialogs.

### State management

**No external state library.** Three state tiers:

| Tier | What | Mechanism | Persistence |
|------|------|-----------|-------------|
| Server data | Entities, runs, sessions | SSE stream → React state → in-memory repos (`RunRepository`, `TaxonomyRepository`) | Server owns it; frontend is a cache |
| UI selection | Selected node, expanded nodes, hover | React context + `useReducer` (`SelectionProvider`) | None (ephemeral) |
| Layout config | Grouping dimensions, widget positions/sizes | React state | `localStorage` |

### localStorage keys

| Key | Value | Purpose |
|-----|-------|---------|
| `tinstar-dimensions` | `["initiative", "epic", "task"]` | Active grouping hierarchy order |
| `tinstar-layouts-v3-{spaceId}` | `{ [nodeId]: { x, y, width, height } }` | Widget positions and sizes on the infinite canvas (per space) |

Dimensions are read on mount (default: `['initiative', 'epic', 'task']`). Layouts are namespaced by active space — switching spaces restores that space's widget positions. Layouts are validated on load — if >20% of nodes are missing layout data, a fresh layout is generated.

### SSE connection (`useServerEvents` hook)

1. Opens `EventSource` to `/api/events`
2. Receives `snapshot` event with full state (activeSpaceId, spaces, initiatives, epics, tasks, worktrees, runs — entities filtered to active space, spaces unfiltered)
3. Receives `delta` events with incremental updates (upsert or delete by entity type + ID; non-active-space entity deltas suppressed, space deltas always sent)
4. Maintains `ServerState` in React state; immutable update pattern

The `useBackendState` hook wraps `useServerEvents` and memoizes `RunRepository` + `TaxonomyRepository` instances for stable object identity.

### Component tree

```
WorkspaceShell
├── SelectionProvider (context)
├── GroupingControls (top bar — drag-to-reorder dimension pills)
├── HierarchySidebar (tree view — drag-to-reparent entities)
├── InfiniteCanvas
│   ├── GroupContainer (initiative/epic/task containers — depth-based styling)
│   └── CanvasWidget
│       └── RunWorkspaceWidget
│           ├── RunWorkspaceHeader (status badge, breadcrumb)
│           ├── ProceduresPanel (running commands)
│           ├── TouchedFilesPanel (file diffs)
│           └── RunSessionPanel (recap entries, ttyd iframe)
├── CreateEntityDialog
├── CreateSessionDialog
├── EntityMenu (right-click context menu)
├── EntitySettingsDialog (inheritance-based settings)
├── ReassignDialog (drag-to-reassign run to different task)
└── SessionsList
```

### Layout engine (`useWidgetLayouts` hook)

Custom implementation (no external grid library). Three-phase algorithm:

1. **Bottom-up sizing:** Runs get default size (900x400). Containers wrap children with padding.
2. **Root grid packing:** `ceil(sqrt(n))` columns, left-to-right placement with 40px gaps.
3. **Top-down absolutization:** Convert parent-relative positions to absolute canvas coordinates.

Supports move, resize, shrink-to-fit, and auto-expansion (parents grow when children outgrow bounds). All layout changes persist to localStorage immediately.

### Infinite canvas (`useCanvasCamera` hook)

- **Zoom:** Ctrl+scroll or trackpad pinch (zoom-to-cursor)
- **Pan:** Space+drag or middle-mouse drag
- **Reset:** Alt+Z resets zoom to 1x

### Custom hooks

| Hook | Purpose |
|------|---------|
| `useServerEvents()` | SSE connection, snapshot/delta processing |
| `useBackendState()` | Wraps SSE state in memoized repositories |
| `useWidgetLayouts(tree)` | Canvas layout generation, mutation, persistence |
| `useCanvasCamera()` | Zoom, pan, cursor management |
| `useSelection()` | Selected/expanded/hovered node state from context |
| `useSidebarDrag(...)` | Hierarchical drag-to-reparent with drop indicators, auto-expand, edge scrolling |

### Domain layer (`src/domain/`)

| File | Purpose |
|------|---------|
| `grouping.ts` | `buildGroupTree()` — recursive hierarchical grouping of runs by dimensions. Handles orphans and empty entities. |
| `repositories.ts` | `RunRepository`, `TaxonomyRepository` — read-only in-memory access with query methods. |
| `view-models.ts` | `buildWorkspaceView()` — builds sidebar tree + run summary view models from repos + dimensions. |
| `dimension-meta.ts` | Static metadata registry for dimensions (labels, icons). |
| `status-colors.ts` | Tailwind classes and hex colors for session/procedure status indicators. |
| `mock-data.ts` | Sample entities and runs for development. |

---

## What's Stored Where

### Backend (server-side, `~/.config/tinstar/`)

```
~/.config/tinstar/
├── config.json              # User config overrides (optional)
├── projects.json            # Registered project directories
├── docstore.json            # Persisted document store (entities + runs)
├── caddy.json               # Caddy reverse proxy config
├── server.log               # Structured log output
├── .secrets/                # Environment secrets (injected into sessions)
│   └── {KEY}                # One file per secret, filename = env var name
└── sessions/
    └── {session-name}/
        ├── session.json     # Session metadata (state, backend, port, workspace, etc.)
        └── claude-state/    # Persisted Claude internal state (mounted into containers)
```

**`docstore.json`** contains the full document store snapshot: all initiatives, epics, tasks, worktrees, and runs with their touched files, recap entries, and procedures. Debounce-saved every 500ms on change. Loaded on startup.

**`session.json`** per session:
```json
{
  "name": "my-session",
  "backend": "docker" | "tmux",
  "state": "creating" | "running" | "idle" | "needs_attention" | "stopped",
  "project": "acme/repo",
  "workspace": {
    "path": "/home/user/projects/repo",
    "worktree": false,
    "branch": "feat/my-feature",
    "basePath": null
  },
  "conversation": { "id": "session-uuid" },
  "port": 8681,
  "created": "2026-03-12T10:00:00Z",
  "lastActive": "2026-03-12T10:05:00Z"
}
```

### Frontend (browser-side, localStorage)

| Key | Content | Updated |
|-----|---------|---------|
| `tinstar-dimensions` | JSON array of active grouping dimensions | On dimension reorder/toggle |
| `tinstar-layouts-v3` | JSON object mapping node IDs to `{x, y, width, height}` | On every widget move/resize |

All entity and run data lives on the server. The frontend holds it in memory (via SSE) but does not persist it — a page refresh fetches a fresh snapshot.

---

## Environment Variables

| Variable | Default | Effect |
|----------|---------|--------|
| `TINSTAR_FAST_SIM` | unset | When `1`: auto-start simulator with instant event emission, skip delays. Used for development and E2E tests. |
| `TINSTAR_NO_SESSIONS` | unset | When `1`: disable session management entirely. Useful for CI or frontend-only development. |
| `TINSTAR_DASHBOARD_PORT` | `5273` | Port the Vite dev server listens on. Used in hook callback URLs. |

---

## Design System

Dark-mode only. Class-based (`darkMode: 'class'`, hardcoded on `<html>`).

**Colors:**
- Primary: `#00f0ff` (cyan neon) with dim and glow variants
- Surface: base `#06080a` → panel `#0a0e12` → raised `#0f1419` → hover `#141c24`
- Accents: red `#ff3366`, green `#00ff88`, amber `#ffaa00`

**Animations:** `pulse-glow` (status dots), `scan` (decorative scan line), `shimmer` (loading).

**Shadows:** `neon` / `neon-strong` / `neon-inner` for glow effects.

Custom CSS includes thin cyan scrollbars, neon text/border utilities, and panel styling classes.

---

## Testing

E2E tests live in `e2e/` and run with Playwright against the simulator:

```bash
TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test
```

Playwright config auto-starts the dev server with `TINSTAR_FAST_SIM=1`. Tests cover:
- Entity CRUD (create, rename, delete)
- Run interactions (selection, status display)
- Canvas interactions (pan, zoom, drag)
- Sidebar drag-to-reparent
- Data persistence across restarts

Type checking: `npx tsc --noEmit`
