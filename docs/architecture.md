# Tinstar Architecture

Tinstar is the visual cockpit for a [First Mate](https://github.com/kunchenguid/firstmate) fleet. First Mate owns worker creation, dispatch, supervision, lifecycle and durable user intent; Tinstar reads First Mate's fleet snapshot, shows each worker and what needs the operator, relays the operator's answers and messages to First Mate's inbox, and opens live terminal views on the workers' tmux windows. Tinstar never launches, stops or steers a worker itself.

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 18, TypeScript 5.7 | Hooks + context, no class components |
| Styling | Tailwind CSS 3.4 | Dark-mode-only, custom cyberpunk theme |
| Fonts | Chakra Petch (display), JetBrains Mono (mono) | Loaded from Google Fonts |
| Build | Vite 6 | Dev server + production bundler |
| Backend | Node.js HTTP server | `src/server/standalone.ts`, a separate process from the Vite dev server |
| Terminal emulator | ttyd + xterm.js | Web-based terminal inside iframes |
| Worker terminals | tmux view sessions | Private `tsview-*` sessions that link First Mate's worker windows |
| Browser regression | Playwright 1.58 | Cockpit spec with a private tmux socket and test home |

No external state management library (Redux, Zustand, etc.). The cockpit reads `GET /api/fleet` through `apiFetch` and holds the result in React state.

---

## High-Level Data Flow

```
Browser (cockpit, App.tsx)
  │ GET /api/fleet, GET/POST /api/fleet/messages, POST /api/fleet/dismiss, GET /api/events (SSE)
  │ worker terminal iframes at /s/<key>/ (HTTP + WebSocket)
  ▼
Standalone backend (src/server/standalone.ts, default :5273)
  ├─ Cockpit fleet (src/server/fleet/) ──► <home>/bin/fm-fleet-snapshot.sh --json
  │                                    ──► <home>/bin/fm-inbox.sh (messages)
  │                                    ──► <home>/bin/fm-captain-hold.sh, fm-send.sh (dismiss)
  ├─ Terminal views (src/server/firstmate/views.ts) ──► ttyd ──► tmux tsview-* session
  │                                                              (links the worker window)
  ├─ Quota and provider observations, telemetry, reach
  └─ Static client (dist/client) with SPA fallback
```

---

## Backend Architecture

The backend is the standalone HTTP server in `src/server/standalone.ts`, started by `tinstar` (`bin/tinstar.js`) or `npm run dev:backend`. It does not run inside Vite. In development Vite serves the frontend separately and proxies `/api` to the standalone server.

### Core modules

| Module | File(s) | Purpose |
|--------|---------|---------|
| Cockpit fleet | `src/server/fleet/cockpit.ts` | Reads each configured First Mate home's fleet snapshot and serves `GET /api/fleet`, `GET/POST /api/fleet/messages`, `POST /api/fleet/dismiss`, `POST /api/fleet/:key/direct`, `GET /api/fleet/:key/terminal` and `POST /api/fleet/:key/terminal/leave` ([details](./features/firstmate-observer.md)). |
| Decision dismiss | `src/server/fleet/dismiss.ts` | Closes a classified decision by running that home's `fm-captain-hold.sh` or `fm-send.sh`. An unclassified decision still uses the inbox note. |
| Needs You cards | `src/server/fleet/attention.ts` | Derives decision, blocked, failure and review-ready cards from each snapshot. |
| First Mate inbox | `src/server/fleet/inbox.ts` | Sends answers and messages through `fm-inbox.sh`; keeps unfinished ones in `fleet-outbox.json`. |
| Fleet config and ports | `src/server/fleet/config.ts`, `src/server/fleet/ports.ts` | Reads `firstmate.homes` and `firstmate.ports` from `config.json`; allocates loopback ttyd ports in that window. |
| Terminal views | `src/server/firstmate/views.ts`, `src/server/firstmate/ledger-watcher.ts` | One ttyd per viewed worker, running `bin/tinstar-fm-view`; ledger changes trigger a snapshot re-read. |
| Terminal proxy | `src/server/sessionProxy.ts` | Proxies `/s/<key>/` HTTP and WebSocket traffic to the worker's view ttyd, with an origin check on upgrades. |
| Core API | `src/server/api/coreRoutes.ts` | `/api/quota`, `/api/provider-observations`, `/api/provider-observation-view`, `/api/reach`, `/api/events` and the telemetry routes. |
| SSE Broadcaster | `src/server/api/sse.ts` | Named server-sent events to connected clients, with a 15 s heartbeat. |
| Quota and observations | `src/server/quota/`, `src/server/providers/`, `src/server/observability/codex-otel.ts` | `quota-axi` poll for the side-panel quota meters, plus provider observation stores. |
| Observability | `src/server/observability/` | Supervises embedded Prometheus + Alloy subprocesses. Downloads platform-matched binaries to `~/.config/tinstar/bin/` on first launch, enforces a pidfile-based singleton lock, and exposes a typed PromQL query layer. Snapshots are served via `/api/telemetry/hud` and pushed over SSE to connected clients. Disabled with `TINSTAR_TELEMETRY=0`. |
| Bind and reach | `src/server/bind.ts`, `src/server/reach/` | Loopback-only bind plus any `--host` addresses; opt-in tailnet reach. |
| Logger | `src/server/logger.ts` | Structured logging to console + `~/.config/tinstar/server.log`. Format: `[ISO] [LEVEL] [TAG] message {json}`. |

### Startup sequence

1. Install process-level keep-alive handlers and take the `server.lock` singleton under the config root.
2. Start the cockpit fleet (snapshot reads, ledger watchers, terminal-view boot sweep).
3. Start the quota, provider observation and observability services.
4. Listen on loopback plus any `--host` addresses, write `server.port`, `server.host` and `server.pid`, and reconcile reach.

### HTTP API

**Response envelope:** `{ ok: true, data, warnings? }` on success, `{ ok: false, error: { code, message, details? } }` on failure. Use the `ok()` and `fail()` helpers in `src/server/api/envelope.ts`. Wire-protocol endpoints (`/api/quota`, provider observations, the `/api/events` SSE stream) are documented exceptions and return raw JSON. See [ADR 0001](./adrs/0001-response-envelope.md). Any other `/api/*` path returns 404.

---

## Frontend Architecture

### Entry points

`index.html` → `main.tsx` → `App.tsx`

`App.tsx` renders the V6 worker cockpit (an activity strip and one side panel for Needs You, messages and the worker switcher, in `src/cockpit/shell/`, beside the Overview or worker view) from `GET /api/fleet`. Needs You cards (decision, blocked, failure, review ready) are built server-side by `src/server/fleet/attention.ts` and arrive as the response's `attention` array. A Decision card has an answer box, and cards and worker views have "Tell First Mate about this"; both post to `/api/fleet/messages`, and the Messages panel polls it for First Mate's receipts and replies ([details](./features/firstmate-observer.md)). Each worker's terminal is a `public/terminal-wrapper.html` iframe opened through `GET /api/fleet/<key>/terminal`. The V5 canvas, widgets, frontend plugin host, Slate and Roundup surfaces, Focus mode and mobile mode have been removed.

### Shared data

The cockpit's fleet response is defined at the server boundary in `src/server/fleet/cockpit.ts`. Provider observation wire types live in `src/domain/provider-observation-wire.ts`. The remaining V5 domain helpers are not part of the cockpit runtime.

---

## Plugin System

The V5 plugin host has been removed. The separately published `@tinstar/plugin-api` package has no runtime host in 6.0.0. [ADR 0002](./adrs/0002-plugin-api-boundary.md) describes the historical design; it is not an instruction for extending this cockpit.

---

## What's Stored Where

### Backend (server-side, `~/.config/tinstar/`)

The directory comes from `getConfigRoot()` (override: `TINSTAR_CONFIG_HOME`).

```
~/.config/tinstar/
├── config.json              # firstmate.homes and firstmate.ports
├── fleet-outbox.json        # Cockpit messages to First Mate not yet finished
├── worker-marks.json        # Direct workers, keyed by home and worker id
├── server.log               # Structured log output
├── server.lock              # Backend singleton lock
├── server.port / .host / .pid  # Written while the server is listening
├── bin/                     # Downloaded Prometheus + Alloy binaries
└── observability/           # Observability stack and Codex OTel receiver state
```

### Frontend

The browser remembers the overview grouping choice. Direct and managed marks live in `worker-marks.json` and come back with `GET /api/fleet`, so a refresh shows the same mark to every viewer.

---

## Environment Variables

| Variable | Default | Effect |
|----------|---------|--------|
| `TINSTAR_CONFIG_HOME` | `~/.config/tinstar` | Config root for this backend; a second backend needs its own. |
| `TINSTAR_HOST` | unset | Comma-separated extra bind addresses, as `--host`. |
| `TINSTAR_TELEMETRY` | unset | Set to `0` to disable the embedded Prometheus + Alloy stack. |

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

Browser regression: see [docs/testing.md](./testing.md#browser-regression-playwright).

Type checking and unit-test invocation: see [docs/testing.md](./testing.md#type-checking).
