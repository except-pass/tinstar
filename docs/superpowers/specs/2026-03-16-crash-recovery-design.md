# Crash Recovery: Reattach Orphaned Sessions on Startup

**Date:** 2026-03-16

## Problem

When Tinstar crashes, tmux sessions (with Claude still running) survive, but ttyd processes die because they were children of the server process. On restart, the server rehydrates runs and reconciles states correctly, but never restarts ttyd. Sessions appear in the UI but terminal iframes can't connect.

## Design

Add a reattach step to server startup that runs after reconciliation identifies live sessions. For each session whose tmux is still alive (state is not `stopped`), restart ttyd on the saved port.

### Changes

**`src/server/sessions/backends/tmux.ts`** — Add `reattachTmuxSession()`:
- Takes config, session, and port
- Calls `startTtyd()` with the session's saved port and tmux name
- Does NOT send any keys to tmux (Claude is still running)
- Reclaims the port in `claimedPorts`
- Returns `{ port, ttydPid }`

**`src/server/index.ts`** — After startup reconciliation resolves:
- Iterate all sessions returned by `reconcileSessionStates`
- Skip sessions that are `stopped` or `creating`
- For tmux sessions with a saved port, call `reattachTmuxSession`
- Update `session.json` with the new ttydPid
- Update the run's port in the docstore (in case it changed)
- Log each reattachment

### Edge Cases

- **Port already in use:** `startTtyd` already handles this — it runs `lsof` to kill orphaned processes on the port before binding.
- **ttyd dies mid-run:** Already handled by the auto-restart logic in `startTtyd`.
- **No saved port:** Allocate a new one via `findPort()`.
- **Docker sessions:** Same pattern — but docker containers manage their own ttyd, so only tmux sessions need reattachment.

### What This Does NOT Do

- Does not re-send the Claude command (Claude is still running in tmux)
- Does not run on browser refresh (server startup only)
- Does not touch docker backend (containers manage their own terminal proxy)
