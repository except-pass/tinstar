# Breakout Rooms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically create a private NATS channel between parent and child when one agent spawns another.

**Architecture:** At spawn time, generate a `tinstar.room.<8-char-uuid>` subject, add it to the child's initial subscriptions, hot-subscribe the parent via its control socket, store the room on both Run records, and inject the room subject into the child's system prompt. No changes to nats-channel-mcp.

**Tech Stack:** Node.js server (routes.ts, types.ts), NATS via existing control socket infrastructure.

---

### Task 1: Add `breakoutRooms` field to RunData

**Files:**
- Modify: `src/types.ts:68-90`

- [ ] **Step 1: Add the field**

In `src/types.ts`, add `breakoutRooms` to the `RunData` interface after the existing `parentId` field:

```typescript
  parentId?: string  // ID of the run that spawned this one (for hands)
  breakoutRooms?: string[]  // NATS room subjects for parent-child communication
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (field is optional, no consumers need updating)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(nats): add breakoutRooms field to RunData"
```

---

### Task 2: Generate breakout room in spawn handler

**Files:**
- Modify: `src/server/api/routes.ts:2444-2618`

This is the core change. After the child session is created, generate a room, hot-subscribe the parent, include the room in the child's subscriptions, rewrite the system prompt injection, and store the room on both Runs.

- [ ] **Step 1: Generate room subject and add to child's NATS subscriptions**

In `src/server/api/routes.ts`, find the block that builds `natsConfig` for the spawned session (lines 2488-2501). After it, generate the room and append it to the child's subscriptions:

```typescript
      // Build NATS subscriptions for the spawned session
      // Inherit NATS from parent regardless of taskId — use whatever hierarchy is available
      let natsConfig: { enabled: boolean; subscriptions: string[] } | null = null
      if (parentSession.nats?.enabled) {
        const natsCtx = {
          sessionName: spawnedName,
          spaceId: ctx.docStore.activeSpaceId || null,
          taskId: taskId || null,
          epicId: parentRun?.epic || null,
          initiativeId: parentRun?.initiative || null,
        }
        const subscriptions = computeNatsSubscriptions(natsCtx, ctx.docStore)
        natsConfig = { enabled: true, subscriptions }
      }

      // Generate a breakout room for parent-child communication
      const breakoutRoom = natsConfig?.enabled
        ? `tinstar.room.${randomUUID().slice(0, 8)}`
        : undefined

      // Add breakout room to child's initial subscriptions
      if (breakoutRoom && natsConfig) {
        natsConfig.subscriptions.push(breakoutRoom)
      }
```

- [ ] **Step 2: Hot-subscribe the parent to the breakout room**

After the session is created and started (after the `emitSessionEvent('managed_session.state_changed', ...)` call on line 2563), hot-subscribe the parent:

```typescript
      // Hot-subscribe parent to the breakout room
      let breakoutWarning: NatsSocketWarning | null = null
      if (breakoutRoom) {
        breakoutWarning = await trySendNatsSocketCommand(parentName, {
          action: 'subscribe',
          subject: breakoutRoom,
        })
      }
```

- [ ] **Step 3: Rewrite the child's system prompt injection to use the room**

Replace the existing system prompt injection block (lines 2549-2553) that injects the parent's full NATS subject:

Old code:
```typescript
          // Build hand system prompt with parent's NATS subject for intro
          const parentNatsSubject = parentRun?.natsSubject || buildNatsSubject(parentName, ctx.docStore, taskId, parentRun?.epic || undefined, parentRun?.initiative || undefined)
          const handSystemPrompt = hand.prompt
            ? `${hand.prompt}\n\n## Your Parent\n\nYou were spawned by **${parentName}**. Their NATS subject is: \`${parentNatsSubject}\`\n\nYour FIRST action must be to introduce yourself to your parent:\n\`\`\`\nreply(to="${parentNatsSubject}", text="${handName} online. <your one-line capability>. Ready.")\n\`\`\``
            : null
```

New code:
```typescript
          // Build hand system prompt with breakout room for parent-child communication
          const handSystemPrompt = hand.prompt
            ? breakoutRoom
              ? `${hand.prompt}\n\n## Your Parent\n\nYou were spawned by **${parentName}**.\nTalk to your parent on: \`${breakoutRoom}\`\n\nYour FIRST action must be to introduce yourself to your parent:\n\`\`\`\nreply(to="${breakoutRoom}", text="${handName} online. <your one-line capability>. Ready.")\n\`\`\``
              : `${hand.prompt}\n\n## Your Parent\n\nYou were spawned by **${parentName}**.`
            : null
```

- [ ] **Step 4: Store breakout room on child's Run record**

In the `ctx.docStore.upsertRun(runId, { ... })` call (lines 2572-2598), add `breakoutRooms`:

```typescript
          natsSubscriptions: natsConfig?.enabled ? natsConfig.subscriptions : undefined,
          breakoutRooms: breakoutRoom ? [breakoutRoom] : undefined,
          taskId: taskId ?? '',
```

- [ ] **Step 5: Store breakout room on parent's Run record**

After the child's Run is created, update the parent's Run to include the new room:

```typescript
        // Add breakout room to parent's run record
        if (breakoutRoom && parentRun) {
          const parentRooms = parentRun.breakoutRooms ?? []
          ctx.docStore.upsertRun(parentRun.id, {
            breakoutRooms: [...parentRooms, breakoutRoom],
          })
        }
```

- [ ] **Step 6: Include room and warning in spawn response**

Update the response object (lines 2600-2608):

```typescript
        return json(res, {
          ok: true,
          data: {
            session: spawnedName,
            hand: handName,
            parentSession: parentName,
            orchestrator: orchestrator ?? false,
            room: breakoutRoom ?? null,
            natsWarning: breakoutWarning ?? undefined,
          },
        }, 201)
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/api/routes.ts
git commit -m "feat(nats): create breakout room at spawn time for parent-child communication"
```

---

### Task 3: Update NATS channel documentation

**Files:**
- Modify: `docs/nats-agent-channels.md:179-193`

- [ ] **Step 1: Update the breakout rooms section**

Replace the existing breakout rooms section (lines 179-193) with:

```markdown
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
```

- [ ] **Step 2: Update the "publish to" table**

Update the table at lines 171-175 to use the new room subject format:

```markdown
| Target | Publish to |
|---|---|
| DM to one agent | `tinstar.space.init-001.epic-xyz.task-abc.a1` |
| All agents on a task | `tinstar.space.init-001.epic-xyz.task-abc` |
| Parent-child room | `tinstar.room.f7e2a91c` |
```

- [ ] **Step 3: Commit**

```bash
git add docs/nats-agent-channels.md
git commit -m "docs(nats): update breakout rooms section to reflect auto-creation at spawn"
```

---

### Task 4: Manual integration test

- [ ] **Step 1: Start the dev server with sim data**

Run: `TINSTAR_FAST_SIM=1 npm run dev`

- [ ] **Step 2: Create a parent session and spawn a child**

```bash
# Create a parent session (adjust name/project as needed)
curl -s http://localhost:5273/api/sessions -X POST \
  -H "Content-Type: application/json" \
  -d '{"name":"room-test-parent","backend":"tmux","project":"/home/ubuntu/repo/tinstar"}' | jq .

# Spawn a child hand
curl -s http://localhost:5273/api/sessions/room-test-parent/spawn -X POST \
  -H "Content-Type: application/json" \
  -d '{"hand":"general-purpose"}' | jq .
```

Expected: Response includes `"room": "tinstar.room.XXXXXXXX"` field.

- [ ] **Step 3: Verify the child's subscriptions include the room**

```bash
curl -s http://localhost:5273/api/state | jq '.runs[] | select(.sessionId | startswith("room-test-parent-general")) | .natsSubscriptions'
```

Expected: Array includes `tinstar.room.XXXXXXXX`.

- [ ] **Step 4: Verify the parent's breakoutRooms include the room**

```bash
curl -s http://localhost:5273/api/state | jq '.runs[] | select(.sessionId=="room-test-parent") | .breakoutRooms'
```

Expected: Array includes `tinstar.room.XXXXXXXX`.

- [ ] **Step 5: Clean up test sessions**

```bash
curl -s -X DELETE http://localhost:5273/api/sessions/room-test-parent
```
