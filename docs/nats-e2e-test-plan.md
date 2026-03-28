# NATS Agent Channels — E2E Test Plan

_Written 2026-03-28 for Tinstar Phase 2 integration work_

---

## What We're Testing

The Tinstar NATS integration adds real-time agent-to-agent messaging to Tinstar sessions. Agents subscribe to NATS subjects derived from their entity hierarchy and can receive/send messages without polling.

Four capabilities need E2E tests:
1. **Basic agent communication** — A → B → done
2. **Multi-agent broadcast** — one message to all agents on a task
3. **Entity move re-subscription** — move a task/run, subscriptions recompute
4. **Breakout rooms** — ad hoc cross-entity collaboration

---

## Infrastructure Assumptions

- `nats-server` running at `localhost:4222`
- `nats-channel-mcp` package at `~/repo/tinstar/nats-poc/`
- `channel-server.ts` built/runnable via `bun run`
- NATS CLI (`nats`) available for test orchestration
- Claude Code v2.1.86+ (has `--mcp-config` and `--dangerously-load-development-channels`)

---

## Test 1: Basic Agent Communication Chain

**What it proves:** Two agents can communicate through NATS. A sends to B, B signals completion.

**Setup:**
- Agent A1: subscribes to `tinstar.task-abc.a1`
- Agent A2: subscribes to `tinstar.task-abc.a2`
- A1 instructions: "When you receive a message, introduce yourself and publish a greeting to tinstar.task-abc.a2"
- A2 instructions: "When you receive a message, reply and publish to tinstar.done.chain-001"

**Steps:**
1. Start NATS server
2. Subscribe to `tinstar.done.chain-001` (listening for completion)
3. Launch A1 and A2 with channel server via `--mcp-config`
4. Wait for both to acknowledge channels (watch tmux pane for "Listening for channel messages")
5. Publish intro message to `tinstar.task-abc.a1`
6. Assert: `tinstar.done.chain-001` receives a message within 60s

**Pass criteria:**
- Done subject receives a message
- Message contains something from A2 (not empty)

---

## Test 2: Multi-Agent Broadcast

**What it proves:** Publishing to a wildcard subject reaches all agents on a task.

**Setup:**
- Agents A1, A2, A3 each subscribe to `tinstar.task-xyz.<agent-name>` AND `tinstar.task-xyz.*`
- Each instructed to publish to `tinstar.done.broadcast-001` when they receive a broadcast

**Steps:**
1. Launch all three agents
2. Publish to `tinstar.task-xyz.*` (broadcast)
3. Assert: `tinstar.done.broadcast-001` receives 3 messages within 60s

**Pass criteria:**
- All 3 agents acknowledge the broadcast
- Messages arrive from distinct agents (check content/names)

---

## Test 3: Entity Move Re-subscription ⭐ Most Important

**What it proves:** When a run/task is moved to a different parent entity, the agent's NATS subscriptions automatically update to reflect the new hierarchy path.

This is the hard one — requires Tinstar to emit entity-move events and the channel server (or Tinstar) to recompute subscriptions.

**Pre-condition:** Subscription management API exists (`POST/DELETE /api/sessions/:name/subscriptions`)

**Setup:**
- Session A1 attached to task `task-abc` which is under `epic-xyz` under `init-001`
- Initial subscriptions (auto-computed by Tinstar):
  - `tinstar.init-001.epic-xyz.task-abc.a1` (direct)
  - `tinstar.init-001.epic-xyz.task-abc.*` (task broadcast)
  - `tinstar.init-001.epic-xyz.>` (epic wildcard)
  - `tinstar.init-001.>` (initiative wildcard)

**Steps:**
1. Launch A1, verify initial subscriptions via `GET /api/sessions/a1/subscriptions`
2. Verify: publish to `tinstar.init-001.epic-xyz.task-abc.a1` → A1 receives it ✓
3. **Move task-abc to epic-other** (simulate via API or EventBus)
4. Tinstar should emit `task.parent_changed` event
5. Channel server (or Tinstar) recomputes subscriptions:
   - Removes old paths
   - Adds new paths: `tinstar.init-001.epic-other.task-abc.a1`, etc.
6. Verify new subscriptions via `GET /api/sessions/a1/subscriptions`
7. Publish to **old** subject `tinstar.init-001.epic-xyz.task-abc.a1` → A1 does NOT receive ✓
8. Publish to **new** subject `tinstar.init-001.epic-other.task-abc.a1` → A1 receives ✓

**Pass criteria:**
- Subscriptions updated within 5s of move
- Old path no longer active
- New path active

---

## Test 4: Breakout Room

**What it proves:** Agents on different entities can join a shared ad hoc room.

**Setup:**
- A1 is on `task-abc` (under `epic-xyz`)
- A2 is on `task-def` (under `epic-other`)
- A breakout room `tinstar.breakout.incident-99` created by publishing a join invitation

**Steps:**
1. Launch A1 and A2 with their respective hierarchy subscriptions
2. Publish join message to both agents' direct subjects: "join tinstar.breakout.incident-99"
3. Each agent adds the breakout subject via `POST /api/sessions/:name/subscriptions`
4. Publish a coordination message to `tinstar.breakout.incident-99`
5. Assert: both A1 and A2 receive the coordination message

**Pass criteria:**
- Both agents receive the breakout room message
- Neither would have received it without joining (no false positives)

---

## Implementation Order

These tests should be implemented in this order:

1. **Test 1** — Can write immediately, just needs `--mcp-config` flag wiring
2. **Test 3** — Requires entity-move events + subscription API (new Tinstar work)  
3. **Test 2** — Can implement once multi-agent sessions work
4. **Test 4** — Requires subscription API + agent instruction handling

---

## Key Implementation Tasks for Tinstar

### Must build first (unblocks all tests):
1. `nats-mcp.json` at fixed path (e.g., `nats-poc/nats-mcp.json`)
2. `buildAgentCommand` changes: `--mcp-config` + `--dangerously-load-development-channels server:nats`
3. Session schema: `nats?: { enabled: boolean, subscriptions: string[] }`
4. `computeNatsSubscriptions(session)` — entity IDs → NATS subjects

### For Test 3 specifically:
5. `POST/DELETE/GET /api/sessions/:name/subscriptions` — hot subscription management API
6. Unix socket at `/tmp/tinstar-nats-<name>.sock` on channel server
7. `task.parent_changed` EventBus event  
8. Bridge: EventBus → diff computation → Unix socket subscription updates

### Channel server additions needed:
9. Unix socket listener (add to `channel-server.ts`)
10. Hot subscribe/unsubscribe via socket messages

---

## Test Infrastructure

All tests should live in `nats-poc/test/e2e/` following the existing `intro-chain.sh` pattern:

```
nats-poc/test/e2e/
  intro-chain.sh          (existing — proves basic chain)
  multi-agent.sh          (Test 1 — basic comms)
  broadcast.sh            (Test 2)
  entity-move.sh          (Test 3 — requires Tinstar API)
  breakout-room.sh        (Test 4)
  run-all.sh              (master runner)
```

Each test:
- Starts/stops NATS server
- Launches agents with `--dangerously-skip-permissions` (automated)
- Publishes test messages via `nats` CLI
- Asserts on received messages (timeout-based)
- Kills agents on cleanup

---

## Open Questions for Brainstorming

1. **Confirmation dialog automation**: `echo 1 | claude` breaks TTY. Best Tinstar-specific approach for confirming the experimental channels prompt on first session start?

2. **Unix socket vs HTTP for hot subscription updates**: Socket is lower latency but adds complexity to channel-server.ts. Is there a simpler approach (e.g., SIGTERM + restart with new subjects)?

3. **Subscription computation timing**: Should Tinstar compute subjects at session CREATE time only, or also re-compute on every start? (Sessions can resume.)

4. **Entity move granularity**: Should `task.parent_changed` carry the old+new hierarchy path, or should Tinstar always recompute from scratch? From-scratch is simpler but needs entity lookup.

5. **nats-mcp.json path**: Should this live in `nats-poc/` (dev-time) or get installed somewhere standard (like `~/.local/share/tinstar/`)? Affects how Tinstar finds it at runtime.
