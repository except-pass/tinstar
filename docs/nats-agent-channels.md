# NATS Agent Channels

Multi-agent communication via NATS pub/sub.

## TL;DR — Subject Scheme

```
tinstar.<space>.<init>.<epic>.<task>           ← task broadcast (like a Slack channel)
tinstar.<space>.<init>.<epic>.<task>.<agent>   ← direct DM to specific agent
tinstar.breakout.<room-name>                    ← ad-hoc rooms
```

**Each agent auto-subscribes to (two-tier model):**
```
tinstar.work-space.init-001.epic-xyz.task-abc       ← task broadcast (all agents see)
tinstar.work-space.init-001.epic-xyz.task-abc.a1    ← my DM inbox (only I see)
```

**Publishing:**
| Target | Publish to |
|--------|------------|
| One agent (DM) | `tinstar.<space>.<init>.<epic>.<task>.<agent>` |
| All on task (broadcast) | `tinstar.<space>.<init>.<epic>.<task>` |
| Breakout room | `tinstar.breakout.<room-name>` |

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

At creation, the channel server subscribes to **two subjects** (two-tier model):

```
tinstar.space.init-001.epic-xyz.task-abc       ← task broadcast (like Slack #channel)
tinstar.space.init-001.epic-xyz.task-abc.a1    ← my DM inbox (only I receive)
```

This enables both broadcast and private messaging:
- Messages to the task channel → everyone on the task sees them
- Messages to an agent's direct channel → only that agent sees them (DM)

### Publishing Patterns

| Target | Publish to |
|---|---|
| DM to one agent | `tinstar.space.init-001.epic-xyz.task-abc.a1` |
| All agents on a task | `tinstar.space.init-001.epic-xyz.task-abc` |
| Parent-child room | `tinstar.room.f7e2a91c` |

**Note:** The task broadcast channel has NO trailing wildcard or agent name — it's an exact subject that all task agents subscribe to. DMs append the agent name as an additional token.

### Breakout Rooms

Private parent-child communication channels, created automatically at spawn time.

```
tinstar.room.<8-char-uuid>
```

- **Created automatically** when `POST /api/sessions/:id/spawn` is called
- One room per parent-child pair (flat — grandchildren don't inherit parent rooms)
- Parent is hot-subscribed via control socket; child gets it in initial subscriptions
- Room subject is injected into the child's system prompt for immediate use
- No task hierarchy dependency — works across projects, worktrees, and repos
- Stored on both Run records in the `breakoutRooms` field

**Ad-hoc breakout rooms** can still be created manually by publishing to any `tinstar.room.*` subject and having agents subscribe via the subscription management API.

### Control Socket Orphan Recovery

The parent's control socket (`/tmp/tinstar-nats-<name>.sock`) is how Tinstar hot-subscribes the parent to a new breakout room. The external `nats-channel-mcp` package binds that socket with `unlinkSync(path); listen(path)` — so if the MCP server restarts (or a duplicate instance starts with the same name), the original listener ends up bound to an inode that's no longer on disk. The kernel still reports LISTEN, but `connect()` hits `ECONNREFUSED`. Static subscriptions from startup keep working; dynamic subscribe is silently dead.

Spawn pre-flights the parent subscribe and classifies failures:

| Code | Meaning | What happens |
|---|---|---|
| `NATS_SOCKET_UNREACHABLE` (ENOENT) | Parent session isn't running | Registry update persists, will apply on next start |
| `NATS_SOCKET_ORPHANED` (ECONNREFUSED + file present) | Parent is alive but control socket is orphaned | **Fallback:** child's effective "room" becomes the parent's persistent direct subject (already subscribed at startup). Parent hears the child there. Session record persists `natsControlOrphanedAt`; SSE event `managed_session.nats_orphaned` fires; session restart recommended to recover dynamic subscribe. |
| `NATS_SOCKET_ERROR` | Unexpected | Logged at error, spawn still proceeds with fallback |

Spawn response reports the fallback explicitly:

```json
{
  "session": "my-child",
  "room": "tinstar.work-space.foo.bar.my-parent",   // effective room
  "breakoutRoom": "tinstar.room.abc12345",          // what we would have used
  "breakoutFallback": true,
  "fallbackReason": "NATS_SOCKET_ORPHANED",
  "restartRecommended": true,
  "natsWarning": { "code": "...", "message": "..." }
}
```

The `natsControlOrphanedAt` timestamp is cleared when the session restarts — the new channel-server gets a fresh control socket.

### NATS Wildcard Reference

NATS has two wildcards with **very different behavior**:

| Wildcard | Matches | Example |
|----------|---------|---------|
| `*` | Exactly ONE token | `task.*` matches `task.agent1` but NOT `task.agent1.sub` |
| `>` | One or MORE tokens | `task.>` matches `task.agent1` AND `task.agent1.sub.deep` |

**When to use which:**

- **`*` (single token)** — Use for task-level broadcasts where you want to reach all direct children (sessions) but not their descendants. Session names are single tokens (no dots), so `task.*` safely matches all sessions on a task.

- **`>` (multi-level)** — Use for hierarchical subscriptions where you want to catch EVERYTHING below a certain level. This is the "catch-all" for a subtree.

**Common mistake:** Using `*` when you meant `>`. If you're not receiving messages you expected, check your wildcard.

```bash
# These are NOT equivalent:
nats sub "tinstar.init-001.*"      # Only direct children of init-001
nats sub "tinstar.init-001.>"      # Everything under init-001 (epics, tasks, agents)
```

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
