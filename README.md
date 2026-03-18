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

### Install with an agent

Paste this into Claude Code:

> Install and launch Tinstar for me. Run `npx tinstar` and fix any missing dependencies it reports until it starts successfully.

### Manual install

```bash
npx tinstar
```

The CLI checks for dependencies (Claude Code, tmux, ttyd), offers to register your current directory as a project, and starts the server.

## Features

- **Infinite canvas** — Figma-style pan, zoom, and spatial arrangement
- **Live terminals** — Embedded ttyd sessions with real-time status updates
- **Multi-selection** — Marquee select, Ctrl+click, grid arrange
- **Spaces** — Organize sessions into isolated workspaces
- **File tree explorer** — Track touched files with live git-diff
- **Drag-and-drop** — Reorder in sidebar, move on canvas, multi-drag
- **Session lifecycle** — Create, stop, resume, delete sessions with tmux or Docker backends
- **Real-time state** — SSE-powered status updates (running, idle, needs attention)
- **Grouping** — Nest sessions into recursive group containers

## Prerequisites

- **Node.js 20+** — runtime
- **Claude Code** — installed and authenticated (`claude auth login`)
- **tmux** — session multiplexing (`brew install tmux` / `apt install tmux`)
- **ttyd** — web terminal (`brew install ttyd` / [download binary](https://github.com/tsl0922/ttyd/releases))
- **Docker** (optional) — for isolated container sessions

## Ports

| Port | Service |
|------|---------|
| 5273 | Tinstar (UI + API + session proxy) — **the only port you need** |
| 8681+ | ttyd instances (dynamic, proxied through 5273) |

## Session Status

| Status | Meaning |
|--------|---------|
| `creating` | Session being initialized |
| `running` | Claude actively executing |
| `idle` | Waiting for user input |
| `needs_attention` | No activity for 2+ minutes |
| `stopped` | User stopped the session |
| `terminated` | Process crashed or disappeared |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TINSTAR_FAST_SIM` | unset | Set to `1` to auto-start mock data simulator |
| `TINSTAR_NO_SESSIONS` | unset | Set to `1` to skip session management (CI) |

## Development

For contributors working on Tinstar itself:

```bash
git clone <repo> && cd tinstar
npm install
npm run dev          # Vite HMR + backend (hot-reload)
npx tsc --noEmit     # Type check
TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test  # E2E tests
```

## License

MIT
