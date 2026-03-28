# NATS Agent Channels — Design (Ephemeral)

_Working design doc. Written during architecture session 2026-03-28. Not final._

---

## What This Is

A system for wiring Claude Code agents together via NATS pub/sub, so multiple agents can communicate with each other and with Clawson — the same way multiple people can message Clawson over Telegram.

The milestone test:
```
Will → Clawson → Agent A1 → Agent A2 → Clawson → Will
```
A deterministic, known pipeline. Two agents, introduced to each other, passing work down the chain.

---

## Core Concept: The NATS Channel Server

Each Tinstar session gets a **NATS channel server** — a small MCP server subprocess that:

1. Subscribes to one or more NATS subjects
2. Bridges incoming messages into the Claude session as `<channel>` tags (via `notifications/claude/channel`)
3. Exposes a **reply tool** so Claude can publish messages back to NATS

Claude's view of an incoming message:
```xml
<channel source="nats" subject="tinstar.team.backend" from="a1">
  auth module refactor complete, see /tmp/result.patch
</channel>
```

Claude reads it, acts on it, and uses the reply tool to publish to another subject.

The MCP server `instructions` string (set at spawn time) tells Claude:
- What subjects it's on and why
- The team protocol (what to do with messages from each subject)
- How to signal completion (which subject to publish to when done)

---

## Channel Management

### Lifecycle

- Spawned by Tinstar when a session is created with `natsEnabled: true`
- Killed when the session stops
- Tracked in session state alongside the tmux/docker process

### Subscriptions

Each session starts with a default subject: `tinstar.agent.<name>`

Subscriptions are **hot-manageable** — no restart required. Tinstar communicates changes to the running channel server via a Unix socket at `/tmp/tinstar-nats-<name>.sock`.

### Tinstar API

```
POST   /api/sessions/:name/subscriptions     { "subject": "tinstar.team.backend" }
DELETE /api/sessions/:name/subscriptions/:subject
GET    /api/sessions/:name/subscriptions     → ["tinstar.agent.a1", "tinstar.team.backend"]
```

### Architecture Boundary

NATS is the **data plane** only. Tinstar never touches the NATS connection — that lives entirely inside the channel server subprocess. Management is HTTP/Unix socket only.

### Session State

```json
{
  "name": "a1",
  "nats": {
    "enabled": true,
    "subscriptions": ["tinstar.agent.a1", "tinstar.team.backend"]
  }
}
```

### Introductions (Team Formation)

Agents don't have global visibility. At spawn time, each agent's `instructions` string tells it only what it needs to know:
- Which subjects to expect messages from
- What those messages mean
- Where to send results

A1 knows about A2's subject. A2 knows nothing about A1 — just "process what arrives." Neither knows about anyone else. Controlled introduction, not a free-for-all.

---

## Status Monitoring

Two paths for checking on a running agent:

**In-band** (through the channel): Publish `{"type": "status"}` to `tinstar.agent.<name>`. Agent receives it as a `<channel>` tag and responds via reply tool. Good for: semantic status ("working on X, ~60% done").

**Out-of-band** (around the side): Tinstar peek / `tmux capture-pane`. Raw terminal output. Good for: ground truth, diagnosing stuck agents, works even when agent can't respond.

For long-running tasks: Clawson subscribes to `tinstar.done.<chain-id>` and notifies Will when the chain completes. No polling.

---

## Topics (NATS Subject Scheme)

### Key Constraint

Entity types (initiative, epic, task) are **not hardcoded** — they're configurable per workspace via `labelConfig` (1–3 levels, user-defined labels). The subject scheme must be entity-ID-based, not level-name-based.

### Two Subject Spaces

```
tinstar.<level3-id>.<level2-id>.<level1-id>.<agent-name>   ← entity hierarchy
tinstar.breakout.<room-name>                                ← breakout rooms
```

These two spaces are siblings under `tinstar.` — structured hierarchy on the left, ad hoc cross-entity rooms on the right.

### Entity Hierarchy

One canonical hierarchical path per agent. Tinstar builds it at session creation from whatever entity IDs are attached to the run.

**Example** (3-level workspace, initiative → epic → task):
```
tinstar.init-001.epic-xyz.task-abc.a1
```

**Example** (1-level workspace, task only):
```
tinstar.task-abc.a1
```

NATS `>` wildcard doesn't care about depth — variable-level hierarchies work fine.

### What Each Agent Subscribes To

At creation, the channel server automatically subscribes to the full path plus all ancestor wildcard patterns:

```
tinstar.init-001.epic-xyz.task-abc.a1   ← direct
tinstar.init-001.epic-xyz.task-abc.*    ← task-level broadcast
tinstar.init-001.epic-xyz.>            ← epic-level and below
tinstar.init-001.>                      ← initiative-level and below
tinstar.>                               ← workspace-wide
```

All computed from the entity path — no manual subscription management needed for the hierarchy.

### Publishing Patterns

| Target | Publish to |
|---|---|
| Direct to one agent | `tinstar.init-001.epic-xyz.task-abc.a1` |
| All agents on a task | `tinstar.init-001.epic-xyz.task-abc.*` |
| All agents in an epic | `tinstar.init-001.epic-xyz.*.*` or use `>` |
| All agents in an initiative | `tinstar.init-001.>` |
| Everyone | `tinstar.>` |
| A breakout room | `tinstar.breakout.auth-review` |

### Breakout Rooms

Ad hoc cross-entity collaboration channels. Any agent, regardless of entity membership, can join one.

```
tinstar.breakout.<room-name>
```

- Named by slug: `tinstar.breakout.auth-refactor`, `tinstar.breakout.prod-incident-42`
- No pre-registration — publish to it and it exists
- Created by Clawson publishing a "join this room" message to each agent's direct subject
- Agent (or Clawson via subscription API) adds the subject as an extra subscription
- Dissolves naturally when all agents unsubscribe

Breakout rooms are intentionally flat — no hierarchy, just a shared meeting point.

### Wildcard Monitoring

```bash
nats sub "tinstar.>"               # everything in the workspace
nats sub "tinstar.init-001.>"      # all agents in an initiative
nats sub "tinstar.breakout.>"      # all breakout rooms
```

### Ad Hoc Operational Subjects

Added via subscription API as needed, not part of the hierarchy:
- `tinstar.chain.<chainId>` — pipeline coordination
- `tinstar.done.<chainId>` — completion signals for Clawson to catch

---

## Dynamic Subscription Maintenance (Entity Moves)

Entities can be moved in Tinstar — a task reassigned to a different epic, a run moved to a different task, an epic moved to a different initiative. When this happens, affected sessions must update their NATS subscriptions to reflect the new hierarchy position.

### Trigger

The NATS bridge listens on the EventBus for entity mutation events. This requires Tinstar to emit typed move events that don't currently exist:
- `task.parent_changed` — task moved to a different epic
- `epic.parent_changed` — epic moved to a different initiative
- `run.task_changed` — run reassigned to a different task

These need to be added to the EventBus alongside the existing entity PATCH flow.

### Re-subscription Logic

When a move event fires, for each affected session:
1. Compute **old** subscription set from current session state
2. Compute **new** subscription set from updated entity hierarchy
3. Diff → `toAdd`, `toRemove`
4. Send add/remove commands to channel server via Unix socket
5. Update session state

The channel server receives only "subscribe X" / "unsubscribe Y" — it has no knowledge of why.

### Cascade

A move at a higher level affects all sessions below it:
- Run moved → 1 session affected
- Task moved → all runs on that task affected
- Epic moved → all runs in all tasks of that epic affected
- Initiative moved → cascade to everything below

The bridge must walk the hierarchy downward from the moved entity to find all affected sessions and trigger re-subscription for each.

### Breakout Room Subscriptions Are Unaffected

Breakout room subscriptions (`tinstar.breakout.*`) are ad hoc and not tied to the entity hierarchy. Entity moves don't touch them.

---

## Build Order

Tinstar integration is plumbing and convenience. The core technology — agents communicating via NATS channel servers — is provable with zero Tinstar changes.

**Phase 1: PoC (standalone `claude` sessions, no Tinstar)**
Write the channel server, wire up two bare `claude` processes, prove the chain works.

**Phase 2: Clawson integration**
Subscribe to done subjects, dispatch tasks, report completions to Will.

**Phase 3: Tinstar integration**
Lifecycle management, entity-aware subscriptions, subscription API, UI representation.

---

## Phase 1: PoC — Proof of Concept

### What's Needed

- NATS server running on localhost:4222 (`nats-server` binary)
- `nats-channel-server` script (to write — see below)
- Two `claude` CLI processes, each with `.mcp.json` configured
- `nats` CLI for Clawson to publish and subscribe

### The Test

Each agent is given an outrageous name in its `instructions`. They introduce themselves in sequence. Clawson sees both names and reports to Will.

**Agents:**
- A1: **Montgomery Wafflesworth-Pudding**
- A2: **Countess Beets McGillicuddy**

**Chain:**
```
Clawson publishes "introduce yourself" to tinstar.agent.a1
→ A1 receives it as <channel> tag
→ A1 replies: "I am Montgomery Wafflesworth-Pudding"
→ A1 reply tool publishes to tinstar.agent.a2: "a1 said hello, now you go"
→ A2 receives it as <channel> tag
→ A2 replies: "I am Countess Beets McGillicuddy"
→ A2 reply tool publishes to tinstar.done.chain-001
→ Clawson receives done event, reports both names to Will in Telegram
```

**Pass criteria:** Will sees both outrageous names in the correct order. No scripted outputs — agents must actually receive and act on the NATS messages.

### `.mcp.json` for Each Agent

```json
{
  "mcpServers": {
    "nats": {
      "command": "node",
      "args": [
        "/path/to/nats-channel-server.js",
        "--name", "a1",
        "--subscribe", "tinstar.agent.a1",
        "--nats", "nats://localhost:4222"
      ]
    }
  }
}
```

### Launch (research preview flag required)

```bash
# Agent sessions
claude --dangerously-load-development-channels server:nats

# Clawson dispatches
nats pub tinstar.agent.a1 "introduce yourself, then forward to a2"

# Clawson watches for completion
nats sub "tinstar.done.>"
```

---

## `nats-channel-server` — What to Build

Single script, ~100 lines. Parameters:
- `--name <agent-name>` — used in channel `source` attribute and instructions
- `--subscribe <subject>` — initial NATS subject to subscribe to
- `--nats <url>` — NATS server URL (default: `nats://localhost:4222`)
- `--instructions <string>` — injected into MCP server instructions for Claude

Implements:
- MCP `claude/channel` capability (registers notification listener)
- NATS subscribe → `notifications/claude/channel` bridge
- `reply` MCP tool: `{ to: string, text: string }` → publishes to NATS
- Unix socket at `/tmp/tinstar-nats-<name>.sock` for hot subscription management (Phase 3)

---

## Phase 3: Tinstar Integration (Later)

- Session creation accepts `natsEnabled: true`
- Spawns/kills channel server with session lifecycle
- Entity path computed from `taskId`/`epicId`/`initiativeId` → automatic subscription set
- Subscription management API (`POST/DELETE /api/sessions/:name/subscriptions`)
- Session state tracks current subscriptions
- EventBus listens for entity moves → triggers re-subscription cascade

---

## Open Questions

- Permission relay: should agents be able to approve each other's tool calls?
- JetStream: do we need durable message delivery for v1?
- How does the Tinstar UI represent agent-to-agent message flow?
- Should Clawson's NATS subscription be persistent (always-on) or on-demand?
