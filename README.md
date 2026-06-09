<p align="center">
  <img src="logo.png" alt="Tinstar" width="400" />
</p>

<h3 align="center">The IDE for human/AI collaboration</h3>

<p align="center">
  You and your agents share one spatial workspace — an infinite canvas of live sessions, editors, browsers, and tools.
</p>

---

IDEs were built for one human typing into one file. But the work has changed: now it's you *plus* a fleet of agents, each on a different task, in a different codebase, at a different stage. The bottleneck is no longer compute — it's **you**. Your attention. The finite amount of state you can hold about what every agent is doing, what needs a nudge, what's done and waiting, what quietly died an hour ago.

Tinstar is an IDE built for that reality. Every session and artifact gets a place, a face, and a status on one canvas — a live memory palace where you can see what's running, what's idle, what needs your eyes. Arrangement is meaningful: cluster sessions by project, by urgency, by phase. The canvas remembers so you don't have to.

**Out of your brain and onto the pane (of glass).**

![Tinstar screenshot](screenshot.png)

The goal is **doneness at a glance** — look at the canvas and immediately know the shape of the work: what's burning, what's waiting, what's done. No context-switching tax. No mental inventory. Just the work, laid out in space.

## Quick Start

### Install with an agent

Paste this into Claude Code:

> Install and launch Tinstar for me. Run `npx tinstar` and fix any missing dependencies it reports until it starts successfully.

### Manual install

```bash
npx tinstar
```

The CLI checks for dependencies (Claude Code, tmux, ttyd), offers to register your current directory as a project, and starts the server. Open **http://localhost:5273** — that's the only port you need. See [Prerequisites](#prerequisites) if the dependency check flags anything.

## The Canvas

Everything in Tinstar lives in space. The canvas is an infinite, Figma-style surface — pan, zoom, and arrange freely; it fills the full height of your screen.

- **Spatial arrangement is meaningful.** Cluster sessions by project, by urgency, by phase. Where a thing sits *is* information.
- **Multi-selection** — marquee select, Ctrl+click, then grid-arrange or swim-lane layout in one shot. Arrange modes are one-shot rearranges; widgets stay free to drag afterward.
- **Spaces** — isolate work into separate canvases, each with its own terminology and layout.
- **It remembers.** Your arrangement persists, so the canvas is a stable map you build intuition around.

## Run Sessions

Sessions are real AI agents running as live, interactive widgets — not headless terminals hidden behind tabs.

- **Live embedded terminals** — every session is a real Claude Code (or Codex) terminal on the canvas, with real-time status and crisp sub-pixel rendering.
- **Multi-agent** — run Claude Code and Codex side-by-side. Define reusable launch configs for any agent CLI with **CLI Templates**, all surfaced through a unified agent dropdown.
- **Real-time state** — SSE-powered status (`running`, `idle`, `needs_attention`) tells you at a glance which agents need you.
- **Full lifecycle** — create, stop, resume, and delete tmux-backed sessions. Configurable per-agent icons in the sidebar. `tinstar doctor` validates dependencies and reports actionable errors.

Fire off a prompt, see the state change, move on. Switching between ten sessions costs you no context, because the context is on the screen.

## Organize Your Work

By default, work nests as **Initiative → Epic → Task → Session**. This is flexible — rename the three tiers per space (e.g. Project / Feature / Story) in the **Entity Labels** tab of Space Settings.

The hierarchy isn't bureaucracy — it's the backbone that keeps a growing fleet legible:

- **The canvas and sidebar stay navigable.** You move by structure instead of hunting through a flat list of twenty sessions.
- **Agents inherit context.** A session created under a task belongs to that task; multi-agent NATS channels are scoped along the same hierarchy (`tinstar.<space>.<init>.<epic>.<task>.<agent>`), so agents can talk to siblings and ancestors automatically.
- **"Doneness at a glance" scales.** Containers group related work, so you read progress at the level of an epic, not one session at a time.

Beyond the default tiers: nest sessions into recursive **group** containers, attach an **external URL** to any entity, and use **Quick Draw** hotgroups (assign with Ctrl+1–9, jump with 1–9) to bounce around the canvas at speed. Toggle empty containers off with `H` to cut clutter.

## Everything Is a Plugin

The widgets that make Tinstar an IDE — the browser, the editor, the image viewer, the file tree — are **plugins**. The same public API that ships the built-ins is the API third parties build against. You can disable any built-in from **Settings → Plugins**.

What the plugin system already gives you out of the box:

- **Browser widget** — embed live browser views on the canvas, with a header-injection proxy (inject auth headers, cookies, or custom headers — no extension needed) and a built-in dev console that captures logs without opening DevTools.
- **File editor widget** — drag files onto the canvas to view and edit; double-click to zoom full-screen; `E`/`W` hotkeys.
- **Image viewer widget** — live-updating image display that watches files via SSE and refreshes automatically.
- **File tree explorer** — track touched files with live git-diff; hide viewed-only files.

### Build your own

Plugins live in your own repo and build against [`@tinstar/plugin-api`](https://www.npmjs.com/package/@tinstar/plugin-api). The host externalizes React and the API at runtime via an importmap, so your bundle stays slim. Load external plugins by listing them in `~/.config/tinstar/plugins.json`.

- **External plugin** — step-by-step in [`docs/plugins/external-quickstart.md`](docs/plugins/external-quickstart.md).
- **Bundled plugin** (inside this repo) — [`docs/plugins/bundled-howto.md`](docs/plugins/bundled-howto.md).
- Full reference and author guides live in [`docs/plugins/`](docs/plugins/).

Any plugin that fails to load surfaces as a top-right banner with the error — so you always know what broke without digging through DevTools.

## Telemetry & Cost HUD

Tinstar ships with an embedded Prometheus + Alloy stack that's managed for you. On first launch the binaries are downloaded to `~/.config/tinstar/bin/` and run as supervised subprocesses. A live HUD in the upper-right of the canvas shows today's cost, tokens, cache hit rate, and agent-autonomy ratio — press `T` to toggle.

Disable with `TINSTAR_TELEMETRY=0`. For the full Grafana power-user experience: `npm run dev:observability`.

## Prerequisites

- **Node.js 20+** — runtime
- **Claude Code** — installed and authenticated (`claude auth login`)
- **tmux** — session multiplexing (`brew install tmux` / `apt install tmux`)
- **ttyd** — web terminal (`brew install ttyd` / [download binary](https://github.com/tsl0922/ttyd/releases))
- **expect** — auto-accept prompts for multi-agent NATS sessions (`brew install expect` / `apt install expect`)

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
| `TINSTAR_TELEMETRY` | unset | Set to `0` to disable the embedded Prometheus + Alloy stack |
