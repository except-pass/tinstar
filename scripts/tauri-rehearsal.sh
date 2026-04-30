#!/usr/bin/env bash
# Phase 1 cross-origin rehearsal: pretend we're Tauri without writing any Tauri code.
#
# Starts the Tinstar backend on :5299 with a CORS allowlist, copies dist/client to a temp
# dir with __TINSTAR_API_BASE__ patched in, serves that copy on :4173, and leaves both
# running until you hit Ctrl-C (or pass --stop).
#
# Usage:
#   scripts/tauri-rehearsal.sh           # build + start; Ctrl-C tears down
#   scripts/tauri-rehearsal.sh --no-build # skip the build step (faster re-runs)
#   scripts/tauri-rehearsal.sh --stop    # tear down without starting
set -euo pipefail

BACKEND_PORT=5299
FRONTEND_PORT=4173
REHEARSAL_DIR=/tmp/tauri-rehearsal
REHEARSAL_CONFIG_HOME=/tmp/tauri-rehearsal-config
ALLOWED_ORIGIN="http://localhost:${FRONTEND_PORT}"
BACKEND_PATTERN="bin/tinstar.js --port ${BACKEND_PORT}"
FRONTEND_PATTERN="serve -l ${FRONTEND_PORT}"

teardown() {
  echo
  echo "tearing down..."
  pkill -f "${BACKEND_PATTERN}" 2>/dev/null || true
  pkill -f "${FRONTEND_PATTERN}" 2>/dev/null || true
  rm -rf "${REHEARSAL_DIR}" "${REHEARSAL_CONFIG_HOME}"
  echo "done."
}

if [[ "${1:-}" == "--stop" ]]; then
  teardown
  exit 0
fi

cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--no-build" ]]; then
  echo "==> building..."
  npx vite build
  npm run build:server
fi

if [[ ! -d dist/client ]]; then
  echo "no dist/client — run without --no-build first" >&2
  exit 1
fi

# Pre-clean: if a stale rehearsal is already running, kill it before starting fresh.
pkill -f "${BACKEND_PATTERN}" 2>/dev/null || true
pkill -f "${FRONTEND_PATTERN}" 2>/dev/null || true
rm -rf "${REHEARSAL_DIR}" "${REHEARSAL_CONFIG_HOME}"
mkdir -p "${REHEARSAL_CONFIG_HOME}"

trap teardown INT TERM EXIT

echo "==> starting backend on :${BACKEND_PORT}"
echo "    allowlist=${ALLOWED_ORIGIN}"
echo "    config=${REHEARSAL_CONFIG_HOME} (isolated from the user's ~/.config/tinstar)"
TINSTAR_CONFIG_HOME="${REHEARSAL_CONFIG_HOME}" \
TINSTAR_CORS_ORIGINS="${ALLOWED_ORIGIN}" \
  node bin/tinstar.js --port "${BACKEND_PORT}" --no-open --no-setup &

# Wait for backend to answer before serving the frontend.
for _ in {1..20}; do
  if curl -sf "http://localhost:${BACKEND_PORT}/api/state" >/dev/null; then break; fi
  sleep 0.5
done
if ! curl -sf "http://localhost:${BACKEND_PORT}/api/state" >/dev/null; then
  echo "backend did not come up on :${BACKEND_PORT}" >&2
  exit 1
fi

echo "==> staging frontend with __TINSTAR_API_BASE__=http://localhost:${BACKEND_PORT}"
cp -r dist/client "${REHEARSAL_DIR}"
sed -i "s|window.__TINSTAR_API_BASE__ = ''|window.__TINSTAR_API_BASE__ = 'http://localhost:${BACKEND_PORT}'|" \
  "${REHEARSAL_DIR}/index.html"

if ! grep -q "http://localhost:${BACKEND_PORT}" "${REHEARSAL_DIR}/index.html"; then
  echo "sed did not patch index.html — check the runtime-injection placeholder" >&2
  exit 1
fi

echo "==> serving frontend on :${FRONTEND_PORT}"
npx -y serve -l "${FRONTEND_PORT}" "${REHEARSAL_DIR}" &

cat <<EOF

================================================================
  Rehearsal up. Open in your browser:

      http://localhost:${FRONTEND_PORT}

  Pass criteria:
    1. Canvas loads.
    2. Task Activity / sessions panel shows real data (SSE + REST cross-origin).
    3. Creating a space or opening a widget works (POST + CORS preflight).
    4. DevTools Network: every /api/* goes to :${BACKEND_PORT}, all 200, no CORS errors.

  Ctrl-C here to tear down. Your :5273 instance is untouched.
================================================================

EOF

wait
