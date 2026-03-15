<p align="center">
  <img src="logo.png" alt="Tinstar" width="400" />
</p>

<h3 align="center">Canvas workspace for managing Claude Code sessions</h3>

<p align="center">
  Sessions appear as interactive widgets on an infinite canvas with live embedded terminals.
</p>

---

## Why

Working with a single AI agent is easy. Working with ten is a different problem entirely.

When you're running multiple Claude Code sessions at once — each on a different task, in a different codebase, at a different stage of completion — the bottleneck isn't compute. It's **you**. Specifically, your attention. Your mental energy. The finite amount of state you can hold in your head about what every agent is doing, what needs a nudge, what's done and waiting for review, what quietly died an hour ago.

The usual tools make this worse. Terminals are headless. Tabs blur together. You find yourself tabbing through sessions, mentally reconstructing context you've already lost.

**Out of the brain. On to the pane of glass.**

Tinstar puts every session on a spatial canvas — a live memory palace where each agent has a place, a face, and a status. You can see what's running, what's idle, what needs your eyes. Arrangement is meaningful: you can cluster sessions by project, by urgency, by phase. The canvas remembers so you don't have to.

The goal is **doneness at a glance** — you should be able to look at the canvas and immediately know the shape of the work: what's burning, what's waiting, what's done. No context-switching tax. No mental inventory. Just the work, laid out in space.

Attention is the limiting resource. Tinstar is built around that fact.

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
