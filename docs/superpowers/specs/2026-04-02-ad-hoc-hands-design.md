# Ad-Hoc Hands: Multi-Agent Orchestration

Spawn collaborators on-demand from any running session. No rigid patterns required.

## Terminology

| Term | Meaning |
|------|---------|
| **Hand** | A collaborator definition — personality, CLI template, NATS wiring |
| **Session** | A running hand on the canvas |
| **Orchestrator** | The hub agent that coordinates others (first agent or explicitly designated) |

## Hand Definitions

Hand definitions use Claude CLI's existing agent format (`.md` with frontmatter):

```yaml
---
name: reviewer
description: Reviews code for quality, edge cases, security
cliTemplate: Claude (multi-agent)  # optional, defaults to multi-agent
---

You are a code reviewer. When introduced to other agents, announce yourself
and your capabilities. Respond to introduction messages with your own.

<agent-protocol>
When you spawn:
1. Announce yourself on the task channel
2. Respond to other agents' introductions  
3. If you're the orchestrator, coordinate work across agents
</agent-protocol>
```

**Locations (searched in order):**
1. `~/.config/tinstar/hands/*.md` — User-defined
2. Claude CLI plugin agents — From marketplace/plugins
3. Built-in agents — Claude's defaults

**Prompt override:** At spawn time, user can inject additional prompt (appended to hand's base prompt). Like Docker CMD override.

## Ad-Hoc Spawning

### UI

**Hands panel** in the left sidebar (below Changed Files):
- Vertically resizable
- Lists available hands from all sources
- **Drag hand onto canvas** → spawns on that task/worktree
- **"+" button** → opens prompt input dialog before spawning

### API

```
POST /api/sessions/:sessionId/spawn
{
  "hand": "reviewer",            // hand definition name
  "prompt": "Focus on security", // optional override
  "orchestrator": false          // optional: make this the orchestrator
}
```

### Spawn Flow

1. User drags hand onto canvas (or clicks + and enters prompt)
2. Tinstar creates new session on same task, same worktree
3. Uses hand's CLI template (defaults to `Claude (multi-agent)`)
4. Reads hand definition and passes prompt via `--append-system-prompt`
5. Appends any user-provided prompt override
6. Injects NATS channel server with task subscriptions
7. Session appears as sibling widget on canvas

**Note:** We use `--append-system-prompt` (not `--agent`) because Tinstar's hand definitions live in `~/.config/tinstar/hands/`, not Claude's plugin locations.

### Orchestrator Designation

- **Ad-hoc:** First agent on a task becomes orchestrator by default
- **Override:** `"orchestrator": true` in spawn request
- **Patterns:** Explicit `orchestrator:` field in pattern frontmatter

## Agent Discovery

**No new machinery.** Agents discover each other via existing NATS task broadcast.

### How It Works

1. All agents on a task subscribe to `tinstar.<init>.<epic>.<task>.*` (automatic)
2. Agent spawns → announces itself on task broadcast
3. Other agents hear the announcement → respond with their own intro
4. Orchestrator tracks who's online

### The Handshake (Prompt Convention)

Hands include this protocol in their definition:

```
When you spawn:
1. Announce yourself: reply(to="<task-channel>.*", text="Hi, I'm <name>. I <capability>.")
2. When you hear another agent's intro, respond with yours
3. If you're orchestrator, acknowledge new agents and coordinate
```

### Orchestrator Death

Workers keep running but can't coordinate new agents. Recovery:
1. User spawns new orchestrator
2. New orchestrator announces itself
3. Existing agents re-introduce
4. Back in sync

## Patterns Integration

Patterns become orchestration templates that reference hand definitions:

```yaml
---
name: review-critique
orchestrator: reviewer   # which role is the hub
---

worker:
  hand: general-purpose  # references hand definition
  prompt: |
    You do the implementation work.
    
reviewer:
  hand: reviewer         # references hand definition
  dependsOn:
    worker:
      condition: ready
```

**Changes:**
- Pattern roles reference hand definitions instead of inline prompts
- `orchestrator:` field explicitly declares the hub
- Inline prompts still work for backward compatibility (treated as anonymous hands)

## NATS Subject Scheme (Reference)

```
tinstar.<init>.<epic>.<task>.<agent>   ← entity hierarchy
tinstar.breakout.<room-name>            ← ad-hoc rooms
```

Each agent auto-subscribes to:
- Direct: `tinstar.<path>.<name>`
- Task broadcast: `tinstar.<path>.*`
- Ancestor wildcards: `tinstar.<path>.>`, etc.

See [docs/nats-agent-channels.md](../../nats-agent-channels.md) for full details.

## Implementation Scope

### New Code

1. **Hands panel UI** — Sidebar component listing available hands
2. **Spawn API** — `POST /api/sessions/:id/spawn`
3. **Hand loader** — Read definitions from `~/.config/tinstar/hands/`
4. **Pattern parser update** — Support `hand:` references and `orchestrator:` field

### Existing Code Changes

1. **Session spawn** — Pass `--agent` flag when hand specified
2. **CreateSessionDialog** — Option to specify hand + prompt override
3. **RunWorkspace header** — Quick-spawn button for companions

### No Changes Needed

- NATS channel server — Already handles task subscriptions
- Readiness tracker — Works as-is
- Subject scheme — Already supports task broadcast

## Success Criteria

1. User can start single-agent session, then spawn reviewer hand ad-hoc
2. Both agents hear each other via task broadcast
3. Handshake happens via prompt conventions (no new machinery)
4. Patterns can reference hand definitions instead of inline prompts
5. First agent is orchestrator by default; can be overridden
