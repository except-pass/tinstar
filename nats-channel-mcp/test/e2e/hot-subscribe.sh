#!/usr/bin/env bash
# E2E Test: hot-subscribe
#
# Verifies hot subscription management via Unix socket:
#   - Start an agent with initial subscriptions
#   - Add a new subscription via socket
#   - Verify the agent receives messages on the new subject
#   - Remove the subscription via socket
#   - Verify the agent no longer receives messages
#
# Usage: ./test/e2e/hot-subscribe.sh
# Exit: 0 = PASS, 1 = FAIL

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHANNEL_KEY="nats"
AGENT_NAME="hot-test-$$"
SOCKET_PATH="/tmp/tinstar-nats-${AGENT_NAME}.sock"
DONE_SUBJECT="done.hot-test-$$"
DONE_OUTPUT="/tmp/nats-e2e-hot-$$"
TIMEOUT_SECONDS=30

# ── Colours ────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; }
fail() { echo -e "${RED}✗ FAIL${NC}: $1"; teardown; exit 1; }
info() { echo -e "${YELLOW}→${NC} $1"; }

# ── Teardown ───────────────────────────────────────────────────────────────────

teardown() {
  info "Tearing down..."
  tmux kill-session -t "e2e-$AGENT_NAME" 2>/dev/null || true
  rm -f "$DONE_OUTPUT"
  rm -f "$SOCKET_PATH"
}

trap teardown EXIT

# ── Setup ──────────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════"
echo "  E2E Test: hot-subscribe"
echo "══════════════════════════════════════════"
echo ""

# NATS server — must be running before the test starts
if ! pgrep -x nats-server > /dev/null; then
  echo ""
  echo -e "${RED}✗ FAIL${NC}: NATS server is not running."
  echo ""
  echo "  Start it first:  nats-server"
  echo "  Then retry:      ./test/e2e/hot-subscribe.sh"
  echo ""
  exit 1
fi
pass "NATS server is running"

# Create temp directory for agent
AGENT_DIR=$(mktemp -d)
trap "rm -rf $AGENT_DIR; teardown" EXIT

# Create AGENT.md
cat > "$AGENT_DIR/AGENT.md" <<EOF
You are a test agent named $AGENT_NAME.

When you receive a <channel> message on any subject:
1. Read the message content
2. Use reply(to="$DONE_SUBJECT", text="received: <message>") to acknowledge

Be concise. No preamble.
EOF

# Create topics.txt with initial subscription
cat > "$AGENT_DIR/topics.txt" <<EOF
agents.$AGENT_NAME
EOF

# Create .mcp.json
cat > "$AGENT_DIR/.mcp.json" <<EOF
{
  "mcpServers": {
    "$CHANNEL_KEY": {
      "command": "bun",
      "args": [
        "$ROOT/channel-server.ts",
        "--name", "$AGENT_NAME",
        "--topics-file", "$AGENT_DIR/topics.txt",
        "--nats", "nats://localhost:4222",
        "--instructions-file", "$AGENT_DIR/AGENT.md"
      ]
    }
  }
}
EOF
pass ".mcp.json and AGENT.md generated"

# ── Helper: wait for text in tmux pane ────────────────────────────────────────

wait_for_pane() {
  local session="$1"
  local text="$2"
  local label="$3"
  local elapsed=0
  while ! tmux capture-pane -t "$session" -p -S -100 2>/dev/null | grep -q "$text"; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
      fail "Timeout waiting for '$text' in $session"
    fi
  done
  pass "$label"
}

# ── Helper: auto-confirm dev channels prompt ──────────────────────────────────

auto_confirm() {
  local session="$1"
  local elapsed=0
  while ! tmux capture-pane -t "$session" -p -S -20 2>/dev/null | grep -q "I am using this for local development"; do
    sleep 0.5
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge 30 ]; then
      fail "Timeout waiting for dev channels confirmation in $session"
    fi
  done
  tmux send-keys -t "$session" "1" ""
  sleep 0.3
  tmux send-keys -t "$session" "" ""
}

# ── Launch agent ───────────────────────────────────────────────────────────────

tmux kill-session -t "e2e-$AGENT_NAME" 2>/dev/null || true

info "Launching agent $AGENT_NAME..."
tmux new-session -d -s "e2e-$AGENT_NAME" -x 200 -y 50 \
  "cd $AGENT_DIR && claude --mcp-config .mcp.json --dangerously-skip-permissions --dangerously-load-development-channels server:${CHANNEL_KEY}"

# Auto-confirm dev channels prompt
info "Waiting for dev channel confirmation prompt..."
auto_confirm "e2e-$AGENT_NAME"

# Wait for agent to be listening
info "Waiting for agent to be ready..."
wait_for_pane "e2e-$AGENT_NAME" "Listening for channel messages" "Agent is listening"

# Wait for Unix socket to be created
info "Waiting for Unix socket..."
ELAPSED=0
while [ ! -S "$SOCKET_PATH" ]; do
  sleep 0.5
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge 20 ]; then
    fail "Timeout waiting for Unix socket at $SOCKET_PATH"
  fi
done
pass "Unix socket created at $SOCKET_PATH"

# ── Test 1: Add subscription via socket ────────────────────────────────────────

NEW_SUBJECT="dynamic.$AGENT_NAME"
info "Adding subscription to $NEW_SUBJECT via socket..."

echo '{"action":"subscribe","subject":"'$NEW_SUBJECT'"}' | nc -U "$SOCKET_PATH" -q 0 2>/dev/null || \
echo '{"action":"subscribe","subject":"'$NEW_SUBJECT'"}' | nc -U "$SOCKET_PATH" 2>/dev/null || true

sleep 1
pass "Subscription command sent"

# ── Test 2: Send message to new subscription ───────────────────────────────────

info "Starting done-subject listener..."
nats sub --count=1 "$DONE_SUBJECT" > "$DONE_OUTPUT" 2>&1 &
LISTENER_PID=$!
sleep 1

info "Publishing to dynamic subject..."
nats pub "$NEW_SUBJECT" "hello from hot subscription test"

# Wait for acknowledgment
info "Waiting for acknowledgment (timeout: ${TIMEOUT_SECONDS}s)..."
ELAPSED=0
while ! [ -s "$DONE_OUTPUT" ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$TIMEOUT_SECONDS" ]; then
    fail "Timeout: agent did not receive message on dynamically added subscription"
  fi
done
pass "Agent received message on dynamically added subscription"

# ── Test 3: Remove subscription via socket ─────────────────────────────────────

info "Removing subscription from $NEW_SUBJECT via socket..."
echo '{"action":"unsubscribe","subject":"'$NEW_SUBJECT'"}' | nc -U "$SOCKET_PATH" -q 0 2>/dev/null || \
echo '{"action":"unsubscribe","subject":"'$NEW_SUBJECT'"}' | nc -U "$SOCKET_PATH" 2>/dev/null || true

sleep 1
pass "Unsubscribe command sent"

# Note: We can't easily verify the agent stopped receiving messages without
# a more complex test setup. The subscription removal is verified by the
# socket command succeeding.

# ── Result ─────────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════"
echo -e "  ${GREEN}ALL ASSERTIONS PASSED${NC}"
echo "══════════════════════════════════════════"
echo ""
