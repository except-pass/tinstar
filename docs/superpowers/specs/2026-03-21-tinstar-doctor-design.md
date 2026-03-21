# `tinstar doctor` — Design Spec

## Overview

A CLI diagnostic command that checks every layer of a Tinstar installation: system dependencies, config, persistence, live sessions, the terminal proxy chain, and the skill system. Auto-detects whether the server is running and probes live endpoints when available.

Primary motivation: diagnosing black ttyd terminals requires walking the full proxy chain (ttyd process → HTTP → WebSocket → server proxy). No single existing check covers this.

## Invocation

```
npx tinstar doctor
```

Added as a subcommand to `bin/tinstar.js`. If `process.argv[2] === 'doctor'`, run the doctor instead of normal startup. Exit code 0 if all checks pass, 1 if any failures.

## Architecture

**File:** `bin/doctor.js`

Called from `bin/tinstar.js` when the `doctor` subcommand is detected. Pure Node.js — spawns child processes, reads files, makes HTTP/WS requests. No server dependency.

Each check is an async function returning:

```js
{ status: 'pass' | 'fail' | 'warn' | 'skip', label: string, detail?: string }
```

- `pass` — check succeeded
- `fail` — something is broken
- `warn` — degraded but not fatal (e.g., docker not installed)
- `skip` — check doesn't apply (e.g., live checks when server is down)

Checks are grouped into sections. Sections run sequentially (System → Config → Server → Persistence → Sessions → Skills) because later sections depend on earlier ones. Checks within a section run in parallel where independent.

## Output Format

Grouped pass/fail with a summary of problems at the end:

```
System
  ✓ tmux 3.4
  ✓ ttyd 1.7.7
  ⊘ docker — not installed (docker sessions won't work)
  ✓ git 2.43.0
  ✓ claude cli authenticated

Config
  ✓ ~/.config/tinstar/ exists
  ✓ config.json valid
  ✓ port range 8681–8780 (100 slots)
  ✓ sessions dir: 4 sessions

Server (http://localhost:5273)
  ✓ API responds — 5 runs, 1 initiative, 4 epics, 6 tasks
  ✓ SSE connects
  ✓ active space: "Work Space" (spc-a7a0a882)

Persistence
  ✓ docstore.json — 85KB, parseable
  ✗ orphan run "foreman" — session dir missing
  ✓ no stuck .deleting markers

Sessions
  ✓ CMT684 — running, tmux alive, ttyd :8696 ✓http ✓ws ✓proxy
  ✗ dashboardgraphic — idle, tmux alive, ttyd :8693 ✓http ✗ws
  ✓ keen-bear-q1i6 — running, tmux alive, ttyd :8692 ✓http ✓ws ✓proxy
  ✓ sitehistory — idle, tmux alive, ttyd :8694 ✓http ✓ws ✓proxy

Skills
  ✓ tinstar-commit installed
  ✓ 12 skills discovered (8 system, 3 repo, 1 plugin)

Summary: 2 issues found
  ✗ orphan run "foreman" — session dir missing (delete via API or restart server)
  ✗ dashboardgraphic — WebSocket upgrade failed on :8693 (ttyd may need restart)
```

Symbols: `✓` pass, `✗` fail, `⊘` skip, `⚠` warn

## Check Specifications

### System (always runs)

| Check | Method | Pass | Fail/Warn |
|-------|--------|------|-----------|
| tmux | `tmux -V` | Shows version | fail: can't create tmux sessions |
| ttyd | `ttyd --version` | Shows version | fail: terminals won't render |
| docker | `docker --version` | Shows version | warn: docker sessions unavailable |
| git | `git --version` | Shows version | fail: commit tracking broken |
| claude | `claude --version` then `claude auth status` | Version + authenticated | fail: agent sessions won't start |

### Config (reads filesystem)

| Check | Method | Pass | Fail |
|-------|--------|------|------|
| root dir | `existsSync(~/.config/tinstar/)` | Exists | fail: nothing will work |
| config.json | `JSON.parse(readFileSync(...))` | Parses OK (or file absent = defaults) | fail: bad config overrides |
| port range | Read `ports.hostStart`, compute range size | Range >= 10 | warn: small port range, collisions likely |
| sessions dir | `readdirSync(sessions/)`, count dirs | Reports count | fail: dir missing |

### Server (auto-detected)

Server port discovery (in order):
1. Read `~/.config/tinstar/server.port` if it exists (we write this on startup)
2. Scan process list for `tinstar` process, extract `--port` arg
3. Try default port 5273

If server is unreachable, skip this section with message: `⊘ Server not running — skipping live checks`

| Check | Method | Pass | Fail |
|-------|--------|------|------|
| API responds | `GET /api/state`, parse JSON | Reports entity counts | fail: server broken |
| SSE connects | `EventSource(/api/events)`, wait for `snapshot` event, 3s timeout | Receives snapshot | fail: UI won't get live updates |
| active space | `state.activeSpaceId` references a space in `state.spaces` | Shows space name | fail: UI shows "No space selected" |

### Persistence (reads docstore.json)

| Check | Method | Pass | Fail |
|-------|--------|------|------|
| parseable | `JSON.parse(readFileSync(docstore.json))` | Reports file size | fail: server loses all state on restart |
| orphan runs | For each run, check session dir exists in `sessions/` | No orphans | fail per orphan: phantom widgets in UI |
| stuck .deleting | Scan session dirs for `.deleting` marker files | None found | warn: session stuck mid-delete |

### Sessions (per session directory on disk)

For each session dir in `~/.config/tinstar/sessions/`:

| Check | Method | Pass | Fail |
|-------|--------|------|------|
| backend alive | tmux: `tmux has-session -t tinstar-{name}` / docker: `docker inspect tinstar-{name}` | Process exists | fail: session is dead |
| ttyd port | Look up port from docstore run data, check if port has a listener (`curl` or `net` module) | Port open | fail: no terminal server |
| ttyd HTTP | `GET http://localhost:{port}/` with 3s timeout | 200 response | fail: terminal page won't load |
| ttyd WebSocket | Attempt WS handshake to `ws://localhost:{port}/ws` with 3s timeout | Upgrade succeeds, receives data frame | fail: **black screen** — xterm gets no data |
| proxy (if server up) | `GET http://localhost:{serverPort}/s/{name}/` with 3s timeout | 200 response | fail: terminal unreachable through UI |

The WebSocket check is the most important — it directly diagnoses the black terminal issue. A ttyd that responds to HTTP but fails WebSocket upgrade will show a loaded-but-blank terminal.

### Skills (reads filesystem)

| Check | Method | Pass | Fail |
|-------|--------|------|------|
| tinstar-commit | `existsSync(~/.claude/commands/tinstar-commit.md)` | File exists | warn: commits won't auto-tag tasks |
| skill discovery | Scan same paths as `skill-discovery.ts`, count by source | Reports counts | warn if zero skills found |

## Server Port File

On startup, the server writes its port to `~/.config/tinstar/server.port` (plain text, just the number). On shutdown, this file is removed. The doctor reads this to find the running server without process-list hacking.

This requires a small addition to `bin/tinstar.js` (write port after server starts) and `src/server/standalone.ts` (clean up on SIGINT/SIGTERM).

## Implementation Notes

- Use the existing `check()` pattern from `bin/tinstar.js` for output formatting (ANSI colors, pass/fail symbols)
- All network checks use 3-second timeouts — doctor should complete in under 10 seconds total
- WebSocket check uses Node.js built-in `http` module for the upgrade request (no dependency on `ws` package) — just verify the 101 status code and that at least one data frame arrives
- Session checks read port info from docstore.json directly (no server dependency)
- If docstore.json is unparseable, session checks fall back to scanning process list for ttyd processes
