# Multi-Agent Pattern Scaffolding

Tinstar feature for quickly spinning up multi-agent architectures with NATS-based communication.

## Goals

1. **Speed to start** — Pick a pattern, get a working multi-agent setup in seconds
2. **Observability** — See messages flowing between agents in real-time
3. **Simplicity over flexibility** — Hardcoded patterns with sensible defaults, not a visual builder

## Non-Goals

- Visual drag-and-drop pattern builder
- Custom/saveable pattern templates (future work)
- Automatic pattern selection based on job type (future work)
- Swarm pattern (too complex for v1)

---

## Design

### 1. Task Creation UI

Add a **Pattern** dropdown to the task creation dialog.

**Behavior:**
- Defaults to "Single Agent" (current behavior unchanged)
- Selecting a multi-agent pattern shows a "? Preview" expander
- Preview displays: mini topology diagram, pattern description, list of sessions to be created
- On create, Tinstar spawns all sessions with NATS subscriptions auto-wired

**Patterns available:**
- Single Agent (default)
- Sequential (Pipeline)
- Parallel (Fan-out)
- Coordinator (Router)
- Review & Critique

### 2. Canvas Layout

When a multi-agent task is created, sessions spawn **arranged in their pattern topology**.

**Layout rules by pattern:**
- **Sequential:** Left → right (coordinator, stage-1, stage-2, stage-3)
- **Parallel:** Top → middle row → bottom (coordinator, specialists row, aggregator)
- **Coordinator:** Center + radial (coordinator center, specialists around)
- **Review & Critique:** Side by side (generator left, critic right)

Users can drag widgets freely after creation. No automatic enforcement or "snap back."

### 3. Traffic Widget Simplification

Modify the existing `NatsTrafficWidget` to remove single-agent bias.

**Remove:**
- "inbound/outbound" direction framing (assumes one agent's perspective)

**Add:**
- Sender → recipient header (e.g., "coordinator → specialist-1")
- Derived from NATS subject parsing

**Keep:**
- Timestamp
- Subject
- ReplyTo
- Body preview

**Optional:**
- Filter by task (scope to task's entity path) or show all traffic

### 4. Pattern Definitions

Each pattern defines: sessions to create, canvas layout, injected instructions.

#### Single Agent (default)
- **Sessions:** 1 (unnamed, current behavior)
- **Layout:** N/A
- **Instructions:** None injected

#### Sequential (Pipeline)
- **Sessions:** coordinator, stage-1, stage-2, stage-3
- **Layout:** Left → right
- **NATS:** Each stage subscribes to its own subject, publishes to the next
- **Instructions:**
  - Coordinator: "You are the entry point. When you receive a task, begin processing and publish your output to stage-1."
  - Stage-N: "When you receive input, process it and publish to stage-{N+1}. If you are the final stage, publish to the done topic."

#### Parallel (Fan-out)
- **Sessions:** coordinator, specialist-1, specialist-2, specialist-3, aggregator
- **Layout:** Coordinator top → specialists row → aggregator bottom
- **NATS:** Coordinator fans out to specialist subjects; specialists reply to aggregator subject
- **Instructions:**
  - Coordinator: "You are the entry point. Fan out the task to all specialists simultaneously. Tell them to reply to the aggregator."
  - Specialists: "Process your portion of the task and publish your result to the aggregator."
  - Aggregator: "Collect results from all specialists. When all have reported, synthesize and publish the final result."

#### Coordinator (Router)
- **Sessions:** coordinator, specialist-1, specialist-2, specialist-3
- **Layout:** Coordinator center, specialists radial
- **NATS:** Coordinator routes to appropriate specialist based on request classification
- **Instructions:**
  - Coordinator: "You are the entry point. Classify incoming requests and route to the appropriate specialist. Specialists reply directly to the original requester."
  - Specialists: "Handle requests in your domain. Reply to the replyTo subject provided."

#### Review & Critique
- **Sessions:** coordinator (generator), critic
- **Layout:** Side by side
- **NATS:** Generator → critic → generator loop until approval
- **Instructions:**
  - Coordinator/Generator: "You are the entry point. Produce or revise work based on feedback, then send to the critic for review. If critic approves, publish to done topic."
  - Critic: "Evaluate work against quality criteria. If acceptable, reply APPROVED. If not, provide specific feedback for revision."

---

## Implementation Notes

### NATS Subject Computation

Subjects are auto-computed from the task's entity hierarchy + session name:
```
tinstar.<initiative-id>.<epic-id>.<task-id>.<session-name>
```

Existing `computeNatsSubscriptions()` in `src/server/sessions/nats-subscriptions.ts` handles this. Multi-agent patterns reuse this logic — each session gets subscriptions based on its name within the task's entity path.

### Instruction Injection

Pattern-specific instructions are appended to the session's system prompt during creation. The existing session creation flow already supports custom instructions via the `cliTemplate` setting; pattern instructions work similarly but are pattern-derived rather than user-provided.

### Traffic Widget Data Source

The existing `NatsTrafficBridge` subscribes to `_tinstar.traffic.>` and broadcasts events via SSE. The `NatsTrafficEvent` interface already includes `sessionName`, `subject`, `replyTo`, and `body`. The widget update is purely presentational — reformat existing data, remove direction bias.

---

## Out of Scope

- **Swarm pattern:** Too complex, unclear use cases. Add later if needed.
- **Custom templates:** Hardcode patterns first, learn what users actually need.
- **Visual connectors:** Animated message flow lines between widgets. Cool but not v1.
- **Pattern enforcement:** No "snap back to pattern" layout. Users own their canvas.
- **Human-in-the-loop pattern:** Requires pause/resume flow not yet built.

---

## Success Criteria

1. User can create a multi-agent task by selecting a pattern from a dropdown
2. All sessions spawn with correct NATS subscriptions and pattern instructions
3. Sessions appear on canvas in pattern-appropriate arrangement
4. Traffic widget shows message flow without single-agent bias
5. User can prompt the coordinator and observe the pattern executing
