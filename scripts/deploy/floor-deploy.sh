#!/usr/bin/env bash
# A failed smoke must stop unattended deploys from repeatedly replacing a broken floor.
set -Eeuo pipefail
set +x # Credentials are read only inside the Node helper, never shell arguments.
umask 077

export TINSTAR_CONFIG_HOME="${TINSTAR_CONFIG_HOME:-/home/farm/srv/tinstar-config}"
source_dir="${TINSTAR_DEPLOY_SOURCE:-/home/farm/srv/tinstar-src}"
block="${TINSTAR_DEPLOY_BLOCK:-$TINSTAR_CONFIG_HOME/deploy.blocked}"
floor_unit="${TINSTAR_FLOOR_UNIT:-tinstar-floor}"
facade_unit="${TINSTAR_FACADE_UNIT:-tinstar-mcp-facade}"
shim_unit="${TINSTAR_SHIM_UNIT-tinstar-mcp-shim}"
tunnel_unit="${TINSTAR_TUNNEL_UNIT:-tinstar-mcp-tunnel}"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
phase=preflight

alert() { printf 'ALERT Tin Star deploy: %s (block: %s)\n' "$1" "$block" >&2; }
failed() {
  local code=$?
  if [[ "$code" == 0 ]]; then return; fi
  trap - EXIT INT TERM
  # Keep the marker even if later diagnostics fail. Only an operator removes it.
  if ! printf 'failed_at=%s\nphase=%s\n' "$(date -u +%FT%TZ)" "$phase" > "$block"; then
    alert "FAILED during $phase; could not persist deploy block"
  else
    alert "FAILED during $phase; further deploys blocked until operator recovery"
  fi
  exit "$code"
}

case "${1:-}" in
  '') ;;
  --check-only) ;;
  --help)
    printf 'Usage: floor-deploy.sh [--check-only]\nSee docs/features/floor-deploy.md for configuration and recovery.\n'
    exit 0 ;;
  *) printf 'Unknown option\n' >&2; exit 2 ;;
esac

mkdir -p -- "$TINSTAR_CONFIG_HOME" "$(dirname -- "$block")"
# Hold across marker check, checkout, restart and smoke. Two deploys must not race
# past a failure latch or inspect a half-built tree.
exec 9>"$TINSTAR_CONFIG_HOME/deploy.lock"
if ! flock -n 9; then alert 'another deploy is running'; exit 1; fi
if [[ -e "$block" ]]; then alert 'refusing deploy; operator must investigate and clear the block'; exit 1; fi
trap failed EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "${1:-}" != --check-only ]]; then
  cd -- "$source_dir"
  [[ -z "$(git status --porcelain)" ]]
  phase=fetch
  git fetch origin main
  git checkout --detach origin/main
  phase=install
  env -u NODE_ENV npm ci --include=dev
  phase=typecheck
  env -u NODE_ENV npm run typecheck
  phase=unit-tests
  env -u NODE_ENV npm run test:unit
  phase=build
  env -u NODE_ENV npm run build:all
  phase=restart
  # Refresh the startup catalog against the newly started facade. The optional
  # shim is today's tunnel target; set TINSTAR_SHIM_UNIT='' when it is removed.
  sudo -n systemctl restart "$floor_unit"
  sudo -n systemctl restart "$facade_unit"
  if [[ -n "$shim_unit" ]]; then sudo -n systemctl restart "$shim_unit"; fi
  sudo -n systemctl restart "$tunnel_unit"
fi
phase=post-deploy-smoke
node "$script_dir/post-deploy-smoke.mjs"
printf 'Tin Star deploy: Ask and MCP smoke passed\n'
