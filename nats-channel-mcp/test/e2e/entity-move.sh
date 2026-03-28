#!/usr/bin/env bash
# E2E Test: entity-move
#
# Verifies that when a task is moved to a different parent (epic/initiative),
# the session's NATS subscriptions are automatically updated.
#
# Prerequisites:
#   - NATS server running
#   - Tinstar server running at localhost:3000
#   - An initiative with at least two epics
#
# Usage: ./test/e2e/entity-move.sh
# Exit: 0 = PASS, 1 = FAIL

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TINSTAR_URL="${TINSTAR_URL:-http://localhost:3000}"
TIMEOUT_SECONDS=30

# ── Colours ────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; }
fail() { echo -e "${RED}✗ FAIL${NC}: $1"; teardown; exit 1; }
info() { echo -e "${YELLOW}→${NC} $1"; }
skip() { echo -e "${YELLOW}⊘ SKIP${NC}: $1"; exit 0; }

# ── Teardown ───────────────────────────────────────────────────────────────────

SESSION_NAME=""
teardown() {
  info "Tearing down..."
  if [ -n "$SESSION_NAME" ]; then
    curl -s -X POST "$TINSTAR_URL/api/sessions/$SESSION_NAME/stop" >/dev/null 2>&1 || true
    curl -s -X DELETE "$TINSTAR_URL/api/sessions/$SESSION_NAME" >/dev/null 2>&1 || true
  fi
}

trap teardown EXIT

# ── Setup ──────────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════"
echo "  E2E Test: entity-move"
echo "══════════════════════════════════════════"
echo ""

# Check prerequisites
if ! pgrep -x nats-server > /dev/null; then
  skip "NATS server not running"
fi
pass "NATS server is running"

if ! curl -s "$TINSTAR_URL/health" >/dev/null 2>&1; then
  skip "Tinstar server not running at $TINSTAR_URL"
fi
pass "Tinstar server is running"

# ── Create test entities ───────────────────────────────────────────────────────

TIMESTAMP=$(date +%s)
INIT_NAME="test-init-$TIMESTAMP"
EPIC1_NAME="test-epic1-$TIMESTAMP"
EPIC2_NAME="test-epic2-$TIMESTAMP"
TASK_NAME="test-task-$TIMESTAMP"
SESSION_NAME="test-session-$TIMESTAMP"

info "Creating initiative: $INIT_NAME"
INIT_ID=$(curl -s -X POST "$TINSTAR_URL/api/initiatives" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$INIT_NAME\",\"color\":\"#ff0000\",\"status\":\"active\",\"summary\":\"Test initiative\"}" \
  | jq -r '.data.id // empty')

if [ -z "$INIT_ID" ]; then
  fail "Failed to create initiative"
fi
pass "Created initiative: $INIT_ID"

info "Creating epic 1: $EPIC1_NAME"
EPIC1_ID=$(curl -s -X POST "$TINSTAR_URL/api/epics" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$EPIC1_NAME\",\"initiativeId\":\"$INIT_ID\",\"status\":\"active\",\"summary\":\"Test epic 1\"}" \
  | jq -r '.data.id // empty')

if [ -z "$EPIC1_ID" ]; then
  fail "Failed to create epic 1"
fi
pass "Created epic 1: $EPIC1_ID"

info "Creating epic 2: $EPIC2_NAME"
EPIC2_ID=$(curl -s -X POST "$TINSTAR_URL/api/epics" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$EPIC2_NAME\",\"initiativeId\":\"$INIT_ID\",\"status\":\"active\",\"summary\":\"Test epic 2\"}" \
  | jq -r '.data.id // empty')

if [ -z "$EPIC2_ID" ]; then
  fail "Failed to create epic 2"
fi
pass "Created epic 2: $EPIC2_ID"

info "Creating task: $TASK_NAME (under epic 1)"
TASK_ID=$(curl -s -X POST "$TINSTAR_URL/api/tasks" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$TASK_NAME\",\"epicId\":\"$EPIC1_ID\",\"initiativeId\":\"$INIT_ID\",\"status\":\"active\"}" \
  | jq -r '.data.id // empty')

if [ -z "$TASK_ID" ]; then
  fail "Failed to create task"
fi
pass "Created task: $TASK_ID"

# ── Create session with NATS enabled ───────────────────────────────────────────

info "Creating session with NATS enabled..."
SUBS=$(cat <<EOF
["tinstar.$INIT_ID.$EPIC1_ID.$TASK_ID.$SESSION_NAME", "tinstar.$INIT_ID.$EPIC1_ID.$TASK_ID.*", "tinstar.$INIT_ID.$EPIC1_ID.>", "tinstar.$INIT_ID.>"]
EOF
)

curl -s -X POST "$TINSTAR_URL/api/sessions" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$SESSION_NAME\",\"backend\":\"tmux\",\"taskId\":\"$TASK_ID\",\"nats\":{\"enabled\":true,\"subscriptions\":$SUBS}}" \
  | jq .

pass "Created session: $SESSION_NAME"

# ── Verify initial subscriptions ───────────────────────────────────────────────

info "Verifying initial subscriptions..."
sleep 2  # Give the session time to start

INITIAL_SUBS=$(curl -s "$TINSTAR_URL/api/sessions/$SESSION_NAME/subscriptions" | jq -r '.data.subscriptions[]')
if ! echo "$INITIAL_SUBS" | grep -q "tinstar.$INIT_ID.$EPIC1_ID"; then
  fail "Initial subscriptions don't include epic1 path"
fi
pass "Initial subscriptions include epic1 path"

# ── Move task to epic 2 ────────────────────────────────────────────────────────

info "Moving task from epic1 to epic2..."
curl -s -X PATCH "$TINSTAR_URL/api/tasks/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d "{\"epicId\":\"$EPIC2_ID\"}" \
  | jq .

pass "Task moved to epic2"

# ── Verify subscriptions updated ───────────────────────────────────────────────

info "Waiting for subscriptions to update..."
sleep 3  # Give time for event processing

UPDATED_SUBS=$(curl -s "$TINSTAR_URL/api/sessions/$SESSION_NAME/subscriptions" | jq -r '.data.subscriptions[]')

if echo "$UPDATED_SUBS" | grep -q "tinstar.$INIT_ID.$EPIC1_ID"; then
  fail "Subscriptions still include old epic1 path"
fi
pass "Old epic1 subscriptions removed"

if ! echo "$UPDATED_SUBS" | grep -q "tinstar.$INIT_ID.$EPIC2_ID"; then
  fail "Subscriptions don't include new epic2 path"
fi
pass "New epic2 subscriptions added"

# ── Test message routing ───────────────────────────────────────────────────────

# Note: Full message routing test would require the agent to be running and
# listening. This is tracked as a separate integration test.

# ── Result ─────────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════"
echo -e "  ${GREEN}ALL ASSERTIONS PASSED${NC}"
echo "══════════════════════════════════════════"
echo ""
