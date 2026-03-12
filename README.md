# Tinstar

Canvas workspace for managing Claude Code sessions. Sessions appear as interactive widgets on an infinite canvas with live embedded terminals.

## Quick Start

```
npm install
npm run dev
```

This single command starts everything:
- Vite dev server on **:5273** (UI + API + SSE)
- Caddy reverse proxy on **:8088** (auto-started in Docker, proxies ttyd terminals)
- Session reconciliation loop (every 30s)

Open `http://localhost:5273` in your browser.

## Ports

| Port | Service | Forward? |
|------|---------|----------|
| 5273 | Vite (UI + API + terminal proxy) | **Yes** — the only port you need |
| 8088 | Caddy (ttyd reverse proxy) | No — Vite proxies `/s/*` to it |
| 8681+ | ttyd instances (dynamic) | No — Caddy proxies them |

Vite proxies `/s/*` to Caddy, so only **port 5273** needs to be forwarded for remote access (e.g. Cursor on EC2).

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

Sessions are the core unit. Creating a session (tmux or Docker backend) spawns a Claude Code instance with a ttyd terminal. The session appears on the canvas as a widget. Hooks inside Claude Code POST state changes (running/idle) back to the server for real-time status updates.

## Session Status

| Status | Meaning |
|--------|---------|
| `creating` | Session being initialized |
| `running` | Claude actively executing |
| `idle` | Waiting for user input |
| `needs_attention` | No activity for 2+ minutes |
| `stopped` | User stopped the session |
| `terminated` | Process crashed or disappeared |
