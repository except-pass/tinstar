#!/usr/bin/env bash
# Kill Vite/node dev servers whose working directories no longer exist
# (e.g. deleted worktrees, interrupted Playwright runs)
#
# Usage: ./scripts/kill-stale-servers.sh [--dry-run]

DRY_RUN=false
[[ "$1" == "--dry-run" ]] && DRY_RUN=true

killed=0

for pid in $(pgrep -f "node.*vite" 2>/dev/null); do
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue

  # Skip if the directory still exists and isn't marked deleted
  [[ "$cwd" != *"(deleted)"* && -d "$cwd" ]] && continue

  # Skip the main tinstar repo server
  [[ "$cwd" == "/home/ubuntu/repo/tinstar" ]] && continue

  port=$(ss -tlnp 2>/dev/null | grep "pid=$pid" | awk '{print $4}' | head -1)

  if $DRY_RUN; then
    echo "[dry-run] Would kill PID $pid | Port: ${port:-unknown} | Dir: $cwd"
  else
    echo "Killing PID $pid | Port: ${port:-unknown} | Dir: $cwd"
    kill "$pid"
  fi
  ((killed++))
done

if (( killed == 0 )); then
  echo "No stale servers found."
else
  $DRY_RUN && echo "$killed stale server(s) found." || echo "Killed $killed stale server(s)."
fi
