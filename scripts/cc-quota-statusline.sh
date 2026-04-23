#!/usr/bin/env bash
# Tinstar cc-quota statusline hook for Claude Code.
#
# Claude Code invokes this command on every statusline render and pipes its
# full session-state JSON on stdin. This script:
#
#   1. Fire-and-forget POSTs the JSON to Tinstar's ingest endpoint so the HUD
#      card can show live quota without ever hitting /api/oauth/usage.
#   2. Mirrors the raw JSON to a tap file for local debugging.
#   3. Emits a compact statusline (5h / 7d quota %) to stdout.
#
# Install
# -------
# Add this to ~/.claude/settings.json (preserving other keys):
#
#   "statusLine": {
#     "type": "command",
#     "command": "/absolute/path/to/tinstar/scripts/cc-quota-statusline.sh"
#   }
#
# Override the ingest URL with TINSTAR_INGEST_URL if Tinstar runs on a
# non-default host/port. Default targets the standalone server on :5273.
#
# Schema (from Claude Code 2.1.118 binary docs):
#   .rate_limits.five_hour.used_percentage : 0..100
#   .rate_limits.five_hour.resets_at       : unix epoch seconds
#   .rate_limits.seven_day.used_percentage : 0..100
#   .rate_limits.seven_day.resets_at       : unix epoch seconds
#
# The whole thing must finish fast — statusline runs on every render.

set -u

TAP=/tmp/tinstar-cc-quota-tap.json
INGEST_URL=${TINSTAR_INGEST_URL:-http://localhost:5273/api/cc-quota/ingest}

input=$(cat)

# 1. Mirror the payload for local debugging. Silenced so a full /tmp never
#    breaks the statusline.
printf '%s\n' "$input" > "$TAP" 2>/dev/null || true

# 2. Push to Tinstar. Non-blocking; never break the statusline on failure.
(curl -sS --max-time 1 -X POST "$INGEST_URL" \
  -H 'content-type: application/json' \
  --data-raw "$input" >/dev/null 2>&1 &) 2>/dev/null

# 3. Emit a compact statusline. Guard every jq extraction with // empty so
# sessions without rate_limits yet don't print garbage.
five=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)
week=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null)

out=""
if [ -n "$five" ]; then
  out="5h:$(printf '%.0f' "$five")%"
fi
if [ -n "$week" ]; then
  [ -n "$out" ] && out="$out  "
  out="${out}7d:$(printf '%.0f' "$week")%"
fi
[ -z "$out" ] && out="cc-quota: no data yet"

printf '%s\n' "$out"
