#!/usr/bin/env bash
# Kill stray dev servers and all Tinstar servers (dev, prod, CLI).
#
# - Still cleans up Vite/node dev servers whose working directories no longer
#   exist (e.g. deleted worktrees, interrupted Playwright runs), but now only
#   for known Tinstar-related repos/worktrees to avoid false positives.
# - Additionally kills any Tinstar servers regardless of cwd, including:
#   - frontend dev (`vite` in the tinstar repo or worktrees)
#   - backend dev (`tsx ... standalone.ts`)
#   - prod/standalone servers (`standalone.js`)
#   - CLI (`node .../bin/tinstar.js` — what `npx tinstar` actually runs; not matched by standalone.js)
#   - `npx tinstar` invocations (parent shell only; child is bin/tinstar.js above)
#
# Usage: ./scripts/kill-stale-servers.sh [--dry-run]

DRY_RUN=false
[[ "$1" == "--dry-run" ]] && DRY_RUN=true

killed=0
seen_pids=""

is_seen() {
  [[ " $seen_pids " == *" $1 "* ]]
}

mark_seen() {
  seen_pids+=" $1"
}

kill_pid() {
  local pid="$1"

  is_seen "$pid" && return
  mark_seen "$pid"

  local cwd port
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || cwd="(unknown)"
  port=$(ss -tlnp 2>/dev/null | grep "pid=$pid" | awk '{print $4}' | head -1)

  if $DRY_RUN; then
    echo "[dry-run] Would kill PID $pid | Port: ${port:-unknown} | Dir: $cwd"
  else
    echo "Killing PID $pid | Port: ${port:-unknown} | Dir: $cwd"
    kill "$pid" || true
  fi
  ((killed++))
}

# 1) Legacy behavior: kill Vite dev servers whose working directories no longer exist,
#    but only if they belong to known Tinstar-related trees (to avoid killing
#    arbitrary apps on port 3000, etc.).
for pid in $(pgrep -f "node.*vite" 2>/dev/null); do
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue

  # Skip if the directory still exists and isn't marked deleted
  [[ "$cwd" != *"(deleted)"* && -d "$cwd" ]] && continue

  # Extra safety: only touch deleted dirs that look like Tinstar or its worktrees.
  if [[ "$cwd" != *"/tinstar"*(deleted)* && "$cwd" != *"/tinstar-worktrees/"*"(deleted)"* && "$cwd" != *"/tinstar-worktrees/"* && "$cwd" != *"/cmsandbox-worktrees/"*"(deleted)"* && "$cwd" != *"/cmsandbox-worktrees/"* ]]; then
    continue
  fi

  kill_pid "$pid"
done

# 2) Kill ALL Tinstar servers (dev, prod, CLI), regardless of cwd existing
#
# We key off either the command line or the cwd pointing at a tinstar repo/worktree.

TINSTAR_ROOT="/home/ubuntu/repo/tinstar"

maybe_kill_tinstar_pid() {
  local pid="$1"
  is_seen "$pid" && return

  local cwd cmd
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || echo "")
  cmd=$(tr -d '\0' <"/proc/$pid/cmdline" 2>/dev/null || echo "")

  # Heuristics: either the cwd lives under tinstar repos/worktrees,
  # or the command line clearly references tinstar.
  if [[ "$cwd" == "$TINSTAR_ROOT"* ]] || [[ "$cwd" == *"/tinstar-worktrees/"* ]] || [[ "$cmd" == *"tinstar"* ]]; then
    kill_pid "$pid"
  fi
}

# Backend dev: tsx ... standalone.ts
for pid in $(pgrep -f "tsx .*standalone.ts" 2>/dev/null); do
  maybe_kill_tinstar_pid "$pid"
done

# Prod/standalone: node ... standalone.js
for pid in $(pgrep -f "node .*standalone.js" 2>/dev/null); do
  maybe_kill_tinstar_pid "$pid"
done

# npx tinstar (parent; often exits before we scan)
for pid in $(pgrep -f "npx tinstar" 2>/dev/null); do
  maybe_kill_tinstar_pid "$pid"
done

# CLI server: node .../bin/tinstar.js (long-lived process holding the HTTP port)
for pid in $(pgrep -f "node.*bin/tinstar\\.js" 2>/dev/null); do
  maybe_kill_tinstar_pid "$pid"
done

# Frontend dev: vite in tinstar repos/worktrees
for pid in $(pgrep -f "node.*vite" 2>/dev/null); do
  maybe_kill_tinstar_pid "$pid"
done

if (( killed == 0 )); then
  echo "No stale servers found."
else
  $DRY_RUN && echo "$killed stale server(s) found." || echo "Killed $killed stale server(s)."
fi
