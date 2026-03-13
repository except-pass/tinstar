<p align="center">
  <img src="logo.png" alt="Tinstar" width="400" />
</p>

<h3 align="center">Canvas workspace for managing Claude Code sessions</h3>

<p align="center">
  Sessions appear as interactive widgets on an infinite canvas with live embedded terminals.
</p>

---

## Quick Start

```
npm install
npm run dev
```

Open `http://localhost:5273` — that's it. One port, everything included:

- **Vite dev server** on `:5273` (UI + API + SSE)
- **Caddy reverse proxy** on `:8088` (auto-started in Docker, proxies ttyd terminals)
- **Session reconciliation** loop (every 30s)

## Features

- **Infinite canvas** — Figma-style pan, zoom, and spatial arrangement
- **Live terminals** — Embedded ttyd sessions with real-time status updates
- **Multi-selection** — Marquee select, Ctrl+click, grid arrange
- **Spaces** — Organize sessions into isolated workspaces
- **File tree explorer** — Track touched files with live git-diff
- **Drag-and-drop** — Reorder in sidebar, move on canvas, multi-drag
- **Session lifecycle** — Create, stop, resume, delete sessions with Docker or tmux backends
- **Real-time state** — SSE-powered status updates (running, idle, needs attention)
- **Grouping** — Nest sessions into recursive group containers

## Ports

| Port | Service | Forward? |
|------|---------|----------|
| 5273 | Vite (UI + API + terminal proxy) | **Yes** — the only port you need |
| 8088 | Caddy (ttyd reverse proxy) | No — Vite proxies `/s/*` to it |
| 8681+ | ttyd instances (dynamic) | No — Caddy proxies them |

Only **port 5273** needs to be forwarded for remote access.

## Prerequisites

- Node 20+
- Docker (for Caddy container and optional Docker-backend sessions)
- tmux + ttyd (for tmux-backend sessions)

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TINSTAR_FAST_SIM` | unset | Set to `1` to auto-start mock data simulator |
| `TINSTAR_NO_SESSIONS` | unset | Set to `1` to skip session management (CI) |
| `TINSTAR_DASHBOARD_PORT` | `5273` | Port hooks POST to (must match Vite port) |

## Architecture

```
Browser ─── Vite (:5273) ─── API routes (/api/*)
                          ├── SSE stream (/api/events)
                          └── Proxy (/s/*) ──► Caddy (:8088) ──► ttyd (:8681+)
```

Sessions are the core unit. Creating a session (tmux or Docker backend) spawns a Claude Code instance with a ttyd terminal. The session widget appears on the canvas. Hooks inside Claude Code POST state changes back to the server for real-time status updates via SSE.

## Session Status

| Status | Meaning |
|--------|---------|
| `creating` | Session being initialized |
| `running` | Claude actively executing |
| `idle` | Waiting for user input |
| `needs_attention` | No activity for 2+ minutes |
| `stopped` | User stopped the session |
| `terminated` | Process crashed or disappeared |

## Development

```bash
# Dev server (clean UI, no mock data)
npm run dev

# Dev server with mock data
TINSTAR_FAST_SIM=1 npm run dev

# Type check
npx tsc --noEmit

# E2E tests
TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test
```

## License

MIT
