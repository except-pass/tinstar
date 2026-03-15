# Tinstar Onboarding & Packaging Design

**Date:** 2026-03-15
**Status:** Draft
**Goal:** Make Tinstar a joy to onboard — push-button easy for Claude Code power users graduating from 1-2 agents to orchestrating many.

## Target User

Developers who already use Claude Code daily. They have auth working, they know the CLI, they're comfortable with terminals. Their first experience of Claude Code was *not* Tinstar — Tinstar is what they graduate to.

## Design Principles

- **No wizards, no overlays, no tutorials.** Contextual nudges at the moment they matter.
- **The app teaches itself.** Empty states and gentle hints replace documentation.
- **tmux-first.** Lower barrier — the user's local environment already works for Claude Code. Docker is an advanced path for later.
- **The CLI has your back.** Pre-flight checks catch problems before the browser opens. Green checkmarks build confidence.

---

## 1. npm Package (`npx tinstar`)

### Entry Point

Tinstar ships as an npm package with a `bin` field. Users launch it with:

```bash
npx tinstar
```

Or install globally:

```bash
npm install -g tinstar
tinstar
```

No `git clone`, no `npm install`, no `npm run dev`. Users use Tinstar — they don't develop it.

### CLI Behavior

The CLI runs sequentially on every launch:

**Step 1 — Pre-flight checks:**

| Check | Method | Pass | Fail |
|-------|--------|------|------|
| Claude Code installed | `which claude` | `✓ Claude Code found (v1.0.32)` | `✗ Claude Code not found` → link to install docs |
| Claude authenticated | `claude auth status` (parse JSON) | `✓ Authenticated as user@email.com` | `✗ Not authenticated` → `Run: claude auth login` |
| tmux installed | `which tmux` | `✓ tmux found` | `✗ tmux not found` → OS-specific install command |
| ttyd installed | `which ttyd` | `✓ ttyd found` | `✗ ttyd not found` → OS-specific install command |

All checks run (doesn't stop at first failure). On any failure, prints all results and exits. User fixes issues and re-runs.

**Step 2 — Project detection:**

- Check if cwd is a git repo (`git rev-parse --show-toplevel`)
- If yes and not already registered as a Tinstar project:
  ```
  📁 Detected project: my-app (/home/you/my-app)
     Add as a Tinstar project? [Y/n]
  ```
- Registers via config file before server starts
- If not a git repo or already registered, skips silently

**Step 3 — Start server:**

```
→ Tinstar running at http://localhost:5273
→ Press S in the app to launch your first agent session
```

Auto-opens the browser. `--no-open` flag to suppress.

### Package Structure

```
tinstar/
├── bin/tinstar.js        # CLI: pre-flight → project detection → server launch
├── server/               # Bundled standalone backend
├── client/               # Built frontend assets (Vite output)
└── package.json          # bin field, minimal dependencies
```

---

## 2. Server Architecture

### Problem

The backend currently lives inside a Vite plugin (`src/server/index.ts` → `tinstarBackend(): Plugin`). This couples the runtime to Vite's dev server, which users don't need.

### Solution

Extract the backend into a standalone Node HTTP server. Keep Vite as the frontend build tool only.

### Standalone Server (`src/server/standalone.ts`)

A plain Node HTTP server that:

- Serves static files from `dist/client/` (built frontend assets)
- Runs the same middleware chain: `handleRequest()` for API routes, SSE broadcaster
- Performs the same initialization: EventBus, DocumentStore, session rehydration, Caddy startup, reconciliation loops
- Adds a websocket proxy for `/s/` → Caddy (replaces Vite's proxy config, using `http-proxy` or similar)

### What Changes

| Component | Before | After |
|-----------|--------|-------|
| Backend entry | Vite plugin `configureServer()` | Standalone `createServer()` |
| Static file serving | Vite dev server | `serve-static` or equivalent |
| `/s/` websocket proxy | Vite proxy config | `http-proxy` |
| API routes, EventBus, SSE, sessions | Unchanged | Unchanged |
| DocumentStore, processors | Unchanged | Unchanged |

### Dev Workflow (Contributors)

Contributors still get hot-reload:

- Vite runs on :5273 for frontend HMR
- Backend runs separately (on :5274 or similar)
- Vite proxies `/api/`, `/s/` to backend

Or alternatively, a single `npm run dev` script starts both processes via `concurrently` or similar.

### Production (`npx tinstar`)

The standalone server runs on :5273, serving the built frontend assets directly. No Vite involved at runtime.

---

## 3. Default Grouping

### Change

The grouping pills (Initiative, Epic, Task, Worktree) default to **only Task selected** on first load.

### Details

- Initiative, Epic, and Worktree pills remain visible and clickable — just unselected by default
- Sidebar and canvas organize by task out of the box
- Stored in localStorage like existing layout preferences
- Only applies when no saved preference exists — existing users keep their selections

### Rationale

New users don't need to understand the full initiative/epic hierarchy to get value from Tinstar. Tasks and runs are the core concepts. Advanced grouping is discoverable when they're ready.

---

## 4. In-App Contextual Nudges

### Empty Canvas Hint

When there are zero runs on the canvas, show a centered, subtle hint:

```
Press S to launch your first session
```

Styled like a keyboard shortcut badge — similar to how games show control hints on first encounter. Disappears the moment the first run appears. Never comes back.

### Session Modal — Inline Project Creation

The project dropdown in `CreateSessionDialog` always includes an **"+Add project"** option at the bottom. Selecting it:

1. Expands an inline field to paste/browse a path
2. Registers the project
3. Selects it in the dropdown

No leaving the modal. The cascade is: blank canvas → Press S → session modal → +Add project.

### Project Dropdown Empty State

If zero projects are registered, the project dropdown shows:

```
No projects yet — add one to get started
+ Add project
```

### No-Tasks Nudge

When a user launches a session and has zero tasks defined in their space, show a one-time dismissible toast:

```
Tip: Tinstar works best with tasks. They help organize your agents' work.
→ Learn how tasks work
```

Links to documentation. Shows once per space, never nags.

---

## 5. README

### "Install with an Agent" Section

The README includes a copy-pastable prompt for bootstrapping Tinstar via an existing Claude Code session:

```markdown
## Quick Start

### Install with an agent

Paste this into Claude Code:

> Install and launch Tinstar for me. Run `npx tinstar` and fix any
> missing dependencies it reports until it starts successfully.

### Manual install

\`\`\`bash
npx tinstar
\`\`\`
```

**Why this works:** The pre-flight checks output clear, actionable error messages. An agent can read those errors, run the suggested install commands, and retry `npx tinstar` until it passes. The user watches their agent set up its own orchestrator.

---

## Explicitly Out of Scope

- **No data model changes** — initiative/epic/task hierarchy stays the same
- **No secrets UI** — tmux sessions inherit local auth; the `.secrets/` file system is for Docker users later
- **No Docker onboarding** — Docker is an advanced path, not the golden path
- **No tutorials, wizards, or blocking overlays**
- **No changes to session management internals** — same backends, same reconciliation
