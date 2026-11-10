#!/usr/bin/env bash
# A failed smoke must stop unattended deploys from repeatedly replacing a broken floor.
set -Eeuo pipefail
set +x # Credentials are read only inside the Node helper, never shell arguments.
umask 077

export TINSTAR_CONFIG_HOME="${TINSTAR_CONFIG_HOME:-/home/farm/srv/tinstar-config}"
export TINSTAR_DEPLOY_SOURCE="${TINSTAR_DEPLOY_SOURCE:-/home/farm/srv/tinstar-src}"
export TINSTAR_DEPLOY_BLOCK="${TINSTAR_DEPLOY_BLOCK:-$TINSTAR_CONFIG_HOME/deploy.blocked}"
source_dir=$TINSTAR_DEPLOY_SOURCE
block=$TINSTAR_DEPLOY_BLOCK
floor_unit="${TINSTAR_FLOOR_UNIT:-tinstar-floor}"
facade_unit="${TINSTAR_FACADE_UNIT:-tinstar-mcp-facade}"
shim_unit="${TINSTAR_SHIM_UNIT:-}"
tunnel_unit="${TINSTAR_TUNNEL_UNIT:-tinstar-mcp-tunnel}"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
support="$script_dir/deploy-support.mjs"
phase=preflight
check_only=false
clear=false
reason=''
overridden=false
block_overridden=false

alert() { printf 'ALERT Tin Star deploy: %s (block: %s)\n' "$1" "$block" >&2; }
audit() { node "$support" audit "$1" "$2" "$3"; }
allow_failure() {
  if [[ -z "$reason" ]]; then return 1; fi
  audit override "$1" "$reason" || exit 1 # Never proceed with an unlogged exception.
  overridden=true
  printf 'WARNING Tin Star deploy: overriding %s for this invocation\n' "$1" >&2
}
gate() {
  local code=0
  phase=$1; shift
  "$@" || code=$?
  if [[ "$code" != 0 ]]; then
    if ! allow_failure "$phase"; then return "$code"; fi
  fi
}
unit_exists() { [[ "$(systemctl show "$1" --property=LoadState --value)" == loaded ]]; }
source_clean() {
  local status
  status=$(git -C "$source_dir" status --porcelain) && [[ -z "$status" ]]
}
failed() {
  local code=$?
  if [[ "$code" == 0 ]]; then return; fi
  trap - EXIT INT TERM
  if ! printf 'failed_at=%s\nphase=%s\n' "$(date -u +%FT%TZ)" "$phase" > "$block"; then
    alert "FAILED during $phase; could not persist deploy block"
  else
    alert "FAILED during $phase; use --clear-block or --override with a reason to recover"
  fi
  exit "$code"
}

while (($#)); do
  case "$1" in
    --check-only) check_only=true; shift ;;
    --override|--clear-block)
      option=$1
      if [[ $# -lt 2 || ! "$2" =~ [^[:space:]] || "$2" == --* || -n "$reason" ]]; then
        printf '%s requires one nonempty reason; choose override or clear-block\n' "$option" >&2; exit 2
      fi
      reason=$2
      if [[ "$option" == --clear-block ]]; then clear=true; fi
      shift 2 ;;
    --help)
      printf 'Usage: floor-deploy.sh [--check-only] [--override "reason"]\n       floor-deploy.sh --clear-block "reason"\nSee docs/features/floor-deploy.md for configuration and recovery.\n'; exit 0 ;;
    *) printf 'Unknown option\n' >&2; exit 2 ;;
  esac
done
if $clear && $check_only; then printf 'clear-block is a separate recovery command\n' >&2; exit 2; fi
mkdir -p -- "$TINSTAR_CONFIG_HOME" "$(dirname -- "$block")"

# Recovery needs neither working services nor credentials. Serialize it with deploys.
if $clear; then
  exec 9>"$TINSTAR_CONFIG_HOME/deploy.lock"
  if ! flock -n 9; then alert 'another deploy is running; retry clear-block after it finishes'; exit 1; fi
  audit clear-block block "$reason"
  rm -f -- "$block"
  printf 'Tin Star deploy: block cleared\n'
  exit 0
fi

if [[ -n "$reason" ]]; then audit override-request invocation "$reason"; fi

# All cheap checks run before the lock, dependency install or full suite. Collect
# failures so the operator sees every prerequisite in one attempt.
preflight_failed=false
if [[ -e "$block" ]]; then
  if allow_failure block; then block_overridden=true; else alert 'existing block; use --clear-block or --override with a reason'; preflight_failed=true; fi
fi
if ! gate preflight node "$support" preflight "$($check_only && printf '%s' --check-only || true)"; then preflight_failed=true; fi
if ! $check_only; then
  for command in git npm flock systemctl sudo; do
    if ! gate "required-command:$command" command -v "$command" >/dev/null; then preflight_failed=true; fi
  done
  for unit in "$floor_unit" "$facade_unit" "$tunnel_unit" ${shim_unit:+"$shim_unit"}; do
    if ! gate "unit:$unit" unit_exists "$unit"; then preflight_failed=true; fi
    if ! gate "restart-permission:$unit" sudo -n -l systemctl restart "$unit" >/dev/null; then preflight_failed=true; fi
  done
  if ! gate source-clean source_clean; then preflight_failed=true; fi
fi
if $preflight_failed; then alert 'preflight failed; no deploy started'; exit 1; fi

exec 9>"$TINSTAR_CONFIG_HOME/deploy.lock"
if ! flock -n 9; then
  if ! allow_failure lock; then alert 'another deploy is running; retry after it finishes'; exit 1; fi
  printf 'Tin Star deploy: waiting for the active deploy lock\n' >&2
  flock 9 # An override permits waiting, never concurrent mutation of the checkout.
fi
# Recheck under the lock in case an earlier deploy failed during preflight.
if [[ -e "$block" && "$block_overridden" == false ]]; then
  if ! allow_failure block; then alert 'existing block; use --clear-block or --override with a reason'; exit 1; fi
fi
trap failed EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! $check_only; then
  cd -- "$source_dir"
  gate source-clean source_clean # A deploy we waited for may have changed the checkout.
  gate fetch git fetch origin main
  gate checkout git checkout --detach origin/main
  gate install env -u NODE_ENV npm ci --include=dev
  gate typecheck env -u NODE_ENV npm run typecheck
  gate unit-tests node "$support" unit-tests
  gate build env -u NODE_ENV npm run build:all
  # Voice is provisioned on every normal deploy, including first installations.
  # A download outage must not block shipping unrelated fixes or restart recovery.
  if ! node bin/tinstar.js voice install; then
    printf 'WARNING Tin Star deploy: voice model install failed; continuing deploy with text input available\n' >&2
  fi
  if ! node bin/tinstar.js voice status; then
    printf 'WARNING Tin Star deploy: voice model status failed; continuing deploy\n' >&2
  fi
  gate "restart:$floor_unit" sudo -n systemctl restart "$floor_unit"
  gate "restart:$facade_unit" sudo -n systemctl restart "$facade_unit"
  if [[ -n "$shim_unit" ]]; then gate "restart:$shim_unit" sudo -n systemctl restart "$shim_unit"; fi
  gate "restart:$tunnel_unit" sudo -n systemctl restart "$tunnel_unit"
fi
gate post-deploy-smoke node "$script_dir/post-deploy-smoke.mjs"
# Clear an old latch only after this invocation completed; failures reinstate it.
if [[ -e "$block" ]]; then rm -- "$block"; fi
if $overridden; then
  printf 'WARNING Tin Star deploy completed with audited overrides; inspect the audit log\n' >&2
else
  printf 'Tin Star deploy: Ask and MCP smoke passed\n'
fi
