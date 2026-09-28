# Tinstar Architecture

Tinstar is a real-time dashboard for orchestrating and monitoring Claude Code sessions. It provides a visual workspace where users manage hierarchical entities (initiatives, epics, tasks), launch tmux-isolated coding sessions, and observe progress through live-streamed state updates.

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 18, TypeScript 5.7 | Hooks + context, no class components |
| Styling | Tailwind CSS 3.4 | Dark-mode-only, custom cyberpunk theme |
| Fonts | Chakra Petch (display), JetBrains Mono (mono) | Loaded from Google Fonts |
| Build | Vite 6 | Dev server + production bundler |
| Backend | Vite plugin (Node.js) | Runs inside the Vite dev server process |
| Terminal emulator | ttyd + xterm.js | Web-based terminal inside iframes |
| Session isolation | tmux sessions | Local tmux sessions managed by the backend |
| Browser regression | Playwright 1.58 | Cockpit spec with a private tmux socket and test home |

No external state management library (Redux, Zustand, etc.). The cockpit reads `GET /api/fleet` with `fetch` and holds the result in React state.

---

## High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser                                 │
│                                                                 │
│  ┌──────────────┐   fetch()       ┌──────────────────────────┐  │
│  │ REST calls   │────────────────►│  Cockpit (App.tsx)       │  │
│  │ /api/fleet   │                 │  rail, Overview,         │  │
│  │              │                 │  worker view             │  │
│  └──────────────┘                 └──────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ ttyd iframes (one per session, proxied through Caddy)    │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         │ fetch
         ▼
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
│  │  ├─ Tmux backend (local tmux sessions + ttyd processes)  │   │
│  │  └─ Reconciler (30s poll, corrects stale states)         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         │                    ▲
         │ tmux send-keys     │ HTTP hooks /api/hooks/*
         ▼                    │
┌─────────────────────────────────────────────────────────────────┐
│  Session (tmux session)                                         │
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
| SSE Broadcaster | `src/server/api/sse.ts` | Pushes document store changes to all connected SSE clients. Sends full snapshot on connect, then incremental deltas. 15s heartbeat. |
| API Routes | `src/server/api/routes.ts` | REST endpoints for CRUD, session management, hooks, and simulator control. |
| Session Manager | `src/server/sessions/` | Tmux backend, reconciliation, workspace/worktree management. |
| Simulator | `src/server/simulator/` | Mock event generator for development and testing. |
| Observability | `src/server/observability/` | Supervises embedded Prometheus + Alloy subprocesses. Downloads platform-matched binaries to `~/.config/tinstar/bin/` on first launch, enforces a pidfile-based singleton lock, and exposes a typed PromQL query layer. Snapshots are served via `/api/telemetry/hud` and pushed over SSE to connected clients. Disabled with `TINSTAR_TELEMETRY=0`; under `TINSTAR_FAST_SIM=1` the supervisor short-circuits to a synthetic fixture. |
| Logger | `src/server/logger.ts` | Structured logging to console + `~/.config/tinstar/server.log`. Format: `[ISO] [LEVEL] [TAG] message {json}`. |

### Startup sequence

1. Instantiate event bus, stores, processors, SSE broadcaster
2. Load config from `~/.config/tinstar/config.json` (merge with defaults)
3. Enable document store file persistence; load existing `docstore.json`
4. Rehydrate sessions from `~/.config/tinstar/sessions/` into document store
5. Reconcile session states against actual tmux state
6. Start 30-second periodic reconciliation loop
7. Attach HTTP middleware to Vite server
8. If `TINSTAR_FAST_SIM=1`: clear persisted data, start simulator

### REST API

Full endpoint reference with schemas and examples: **[`/api/docs`](http://localhost:5273/api/docs)** (OpenAPI 3.0 / Scalar UI). Raw spec at `/api/docs/openapi.json`.

Key endpoint groups: Entity CRUD, Sessions, Hooks, Settings, Spaces, OTel, Simulator.

**Response envelope:** `{ ok: true, data, warnings? }` on success, `{ ok: false, error: { code, message, details? } }` on failure. Use the `ok()` and `fail()` helpers in `src/server/api/envelope.ts`. Wire-protocol endpoints (`openapi.json`, OTLP/Prom exports, `/api/state` SSE snapshot) are documented exceptions and return raw JSON. See [ADR 0001](./adrs/0001-response-envelope.md).

---

## Session Backend

Sessions are isolated environments where Claude Code runs. Tmux is the only supported backend.

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

The backend installs hooks into `.claude/settings.json` in the workspace:

| Hook event | Calls | Purpose |
|------------|-------|---------|
| `Stop` | `/api/hooks/idle` | Claude finished and went idle |
| `PreToolUse` | `/api/hooks/active` | Claude is about to use a tool |
| `UserPromptSubmit` | `/api/hooks/active` | User sent a prompt |
| `PostToolUse` (Write/Edit) | `/api/hooks/file-touched` | Claude edited a file |

Hooks filter on `$TINSTAR_SESSION_NAME` so they only fire for managed sessions.

### State reconciliation (`src/server/sessions/reconcile.ts`)

Runs on startup and every 30 seconds:

1. `tmux has-session` checks each session's existence. Missing → `stopped`.
2. Stale detection: if a session is `running` but hasn't been active for >2 minutes → `needs_attention`.

---

## Frontend Architecture

### Entry points

`index.html` → `main.tsx` → `App.tsx`

`App.tsx` renders the V6 worker cockpit (rail with the Needs You queue, Overview, worker view) from `GET /api/fleet`. Needs You cards (decision, blocked, failure, review ready) are built server-side by `src/server/fleet/attention.ts` and arrive as the response's `attention` array; opening a card only shows its detail and never answers or resolves anything. Each worker's terminal is a `public/terminal-wrapper.html` iframe opened through `GET /api/fleet/<key>/terminal`. The V5 canvas, widgets, frontend plugin host, Slate and Roundup surfaces, Focus mode and mobile mode have been removed.

### Domain layer (`src/domain/`)

| File | Purpose |
|------|---------|
| `mock-data.ts` | Sample entities and runs for development. |

---

## Plugin System

The V5 frontend plugin host (widget registry, bundled and external plugin loading, the importmap and `window.__tinstar_react`) was removed with the canvas. What remains is server-side: `src/server/api/builtinPluginManifests.ts` reads the `src/plugins/<name>/package.json` manifests, `src/server/api/pluginsConfigRoute.ts` serves `GET/PUT /api/plugins-config` using `src/core/pluginHost/{pluginsConfig,writePluginsConfig,manifest}.ts`, and `src/server/api/pluginRuntime.ts` still serves `/api/plugin-runtime/*`, which no client loads any more. The public types stay in `packages/plugin-api/src/index.ts`. See [ADR 0002](./adrs/0002-plugin-api-boundary.md) for the V5 design.

### Where plugin state lives

- `~/.config/tinstar/plugins.json` — single file. `disabled: string[]` and `external: Array<{ name, path?, npm? }>`.
- Plugin-scoped persistent state (the eventual `api.storage` surface) is deferred to V5.1.

### Reference

Full design + author guides under [`docs/plugins/`](plugins/):
- [`docs/plugins/README.md`](plugins/README.md) — canonical reference, design decisions
- [`docs/plugins/bundled-howto.md`](plugins/bundled-howto.md) — author guide for in-repo plugins
- [`docs/plugins/external-quickstart.md`](plugins/external-quickstart.md) — author guide for plugins in their own repo
- [`packages/plugin-api/README.md`](../packages/plugin-api/README.md) — npm-consumer-facing reference

---

## What's Stored Where

### Backend (server-side, `~/.config/tinstar/`)

```
~/.config/tinstar/
├── config.json              # User config overrides (optional)
├── projects.json            # Registered project directories
├── docstore.json            # Persisted document store (entities + runs)
├── plugins.json             # Plugin enable/disable + external entries (V5+)
├── caddy.json               # Caddy reverse proxy config
├── server.log               # Structured log output
├── .secrets/                # Environment secrets (injected into sessions)
│   └── {KEY}                # One file per secret, filename = env var name
└── sessions/
    └── {session-name}/
        ├── session.json     # Session metadata (state, backend, port, workspace, etc.)
        └── claude-state/    # Persisted Claude internal state (mounted into containers)
```

**`docstore.json`** contains the full document store snapshot: all initiatives, epics, tasks, worktrees, and runs with their touched files and recap entries. Debounce-saved every 500ms on change. Loaded on startup.

**`session.json`** per session:
```json
{
  "name": "my-session",
  "backend": "tmux",
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

### Frontend

The cockpit persists nothing in the browser. It reads the fleet from `GET /api/fleet`; a page refresh fetches a fresh copy.

---

## Environment Variables

| Variable | Default | Effect |
|----------|---------|--------|
| `TINSTAR_FAST_SIM` | unset | When `1`: auto-start simulator with instant event emission, skip delays. Used for development. |
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

The cockpit regression lives in `e2e/cockpit-regression.spec.ts` and runs with `npx playwright test`. It starts an isolated server, a private tmux socket and a private First Mate test home.

Type checking and unit-test invocation: see [docs/testing.md](./testing.md#type-checking).
