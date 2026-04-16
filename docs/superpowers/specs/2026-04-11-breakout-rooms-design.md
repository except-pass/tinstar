# Breakout Rooms — Parent-Child Auto-Channels

**Date:** 2026-04-11
**Status:** Design

## Problem

When agent A spawns agent B, they need a reliable private channel. Today the child gets the parent's full NATS subject injected into its prompt and uses it as a DM address. This is brittle:

- The parent's NATS subject is derived from the task hierarchy (`tinstar.<space>.<init>.<epic>.<task>.<session>`). If the parent moves to a different task, the subject is stale.
- Parent and child may not share a task at all — children are often spawned into different projects, worktrees, or repos.
- Task broadcast (`tinstar.<space>.<init>.<epic>.<task>`) is too noisy for parent-child coordination when multiple agents share the same task.

## Design

### Core Concept

At spawn time, the server generates a **breakout room** — a NATS subject `tinstar.room.<8-char-uuid>` — and subscribes both parent and child to it. This is the primary channel for parent-child communication. It has no dependency on the task hierarchy.

### Spawn Flow (changes to `POST /api/sessions/:id/spawn`)

After the child session is created and before the response is sent:

1. **Generate room ID:** `tinstar.room.${randomUUID().slice(0, 8)}`
2. **Add to child's initial subscriptions:** The room subject is included in the child's NATS subscription list at session creation time. No control socket needed — it's there from the start.
3. **Hot-subscribe the parent:** Send `{"action":"subscribe","subject":"tinstar.room.<id>"}` to the parent's control socket at `natsControlSocketPath(parentSession.name)`. This uses the existing control socket infrastructure (already wired up in `tmux.ts` and used by `routes.ts`).
4. **Inject into child's system prompt:** Replace the current parent-subject injection with the room subject (see below).
5. **Store on both Runs:** Add the room subject to `breakoutRooms` on both the parent and child Run records.
6. **Include in spawn response:** Return the room subject so the spawning agent knows where to talk to its child.

### Run Model Change

Add one field to `RunData`:

```typescript
breakoutRooms?: string[]
```

Array because a parent can spawn multiple children, each with its own room. A child that was spawned (not an orchestrator) will typically have exactly one entry — its room with its parent.

### Child System Prompt Injection

Replace:

```
## Your Parent
You were spawned by **{parentName}**. Their NATS subject is: `{parentNatsSubject}`
Your FIRST action must be to introduce yourself to your parent:
reply(to="{parentNatsSubject}", text="{handName} online. Ready.")
```

With:

```
## Your Parent
You were spawned by **{parentName}**.
Talk to your parent on: `tinstar.room.{roomId}`

Your FIRST action: reply(to="tinstar.room.{roomId}", text="{handName} online. Ready.")
```

### Spawn Response

Add `room` to the response:

```json
{
  "ok": true,
  "data": {
    "session": "reviewer-a1b2c3d4",
    "hand": "reviewer",
    "parentSession": "my-orchestrator",
    "orchestrator": false,
    "room": "tinstar.room.f7e2a91c"
  }
}
```

### What Doesn't Change

- **Task broadcast** still works for agents that share a task.
- **DM inbox** still works for direct-addressing any agent by its full subject.
- **Hand definitions, discovery, parsing** — untouched.
- **NATS traffic widget** — rooms show up as another subject, no special handling needed.
- **nats-channel-mcp** — no changes needed. The control socket already supports `subscribe`/`unsubscribe` commands, and initial subscriptions are passed via `--subscribe` args.

### Relationship Model

Flat, not inherited. If O spawns A, and A spawns B:

- Room `O↔A`: only O and A are subscribed.
- Room `A↔B`: only A and B are subscribed.
- O cannot see A↔B traffic. If O needs to reach B, it asks A to relay or uses B's DM inbox.

### Error Handling

If the parent's control socket is unavailable (session crashed, socket missing), the spawn still succeeds — the child gets its room subscription at creation time regardless. The spawn response includes a warning that the parent couldn't be hot-subscribed. The parent knows the room subject from the spawn response and can still publish to it (NATS doesn't require a subscription to publish), but it won't receive the child's replies until the subscription is restored or the session is restarted.

## Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `breakoutRooms?: string[]` to `RunData` |
| `src/server/api/routes.ts` | Spawn handler: generate room, hot-subscribe parent, inject into child prompt, store on Runs, return in response |
| `docs/nats-agent-channels.md` | Document breakout rooms as implemented (update from "Phase 3" to current) |

## Files That Don't Change

| File | Why |
|------|-----|
| `nats-channel-mcp/channel-server.ts` | Control socket already supports dynamic subscribe |
| `src/server/sessions/backends/tmux.ts` | Already passes `--control-socket` to MCP server |
| `src/server/sessions/nats-subscriptions.ts` | Task-based subscriptions are orthogonal |
| `src/server/hands/parser.ts` | Hand definitions don't need room awareness |
| `src/server/hands/discovery.ts` | Unchanged |
