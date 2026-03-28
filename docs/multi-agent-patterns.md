# Multi-Agent Patterns in Tinstar + nats-channel-mcp

_Reference: Google Cloud "Choose a design pattern for your agentic AI system" + Anthropic "Building Effective Agents"_

This document describes each canonical multi-agent orchestration pattern and gives practical guidance on how to implement it using Tinstar sessions with NATS channels.

---

## Prerequisites

- NATS server running (`nats-server -p 4222`)
- Tinstar session created with `nats: { enabled: true, subscriptions: [...] }`
- Agent instructions include the universal NATS preamble (auto-injected by Tinstar):
  ```
  Messages arrive as:
  --- incoming message ---
  from:     <sender name or 'unknown'>
  replyTo:  <reply subject or 'none'>
  subject:  <subject this arrived on>
  ---
  <body>

  Rules: ignore messages from yourself. Reply to the replyTo subject.
  Stop if you've sent 3+ replies with no new input.
  ```

---

## Subject Naming Conventions

```
tinstar.<entity-ids...>.<agent-name>   — direct agent inbox
tinstar.breakout.<room-name>           — shared room for swarm / breakout
tinstar.done.<chain-id>                — completion signal (fire and forget)
_INBOX.<random>                        — auto-generated reply inbox (use nats req)
```

---

## Pattern 1: Single Agent

**What it is:** One agent, multiple tools, handles the full task autonomously.

**When to use:** Prototypes, simple tasks, when you need one agent with access to several tools. Start here before adding agents.

**Tinstar setup:**
```json
POST /api/sessions
{
  "name": "researcher",
  "nats": { "enabled": true, "subscriptions": ["tinstar.task-abc.researcher"] }
}
```

**Send task:**
```bash
nats req tinstar.task-abc.researcher "Research competitors for X and summarize"
# agent replies to auto-generated _INBOX
```

**No completion topic needed** — use `nats req` and wait for the reply.

---

## Pattern 2: Sequential (Pipeline)

_Anthropic calls this: Prompt Chaining_

**What it is:** Agents run in a fixed order. A → B → C. Each agent's output is the next agent's input.

**When to use:** Structured, repeatable pipelines where steps don't change. Data extraction → cleaning → loading. Document draft → translation → formatting.

**Tinstar setup:**
```json
// Three sessions
{ "name": "extractor", "nats": { "subscriptions": ["tinstar.pipeline.extractor"] } }
{ "name": "cleaner",   "nats": { "subscriptions": ["tinstar.pipeline.cleaner"] } }
{ "name": "loader",    "nats": { "subscriptions": ["tinstar.pipeline.loader"] } }
```

**Agent instructions pattern:**
- Extractor: "When you receive a task, extract raw data, then publish result to `tinstar.pipeline.cleaner`"
- Cleaner: "When you receive data, clean and normalize it, then publish to `tinstar.pipeline.loader`"
- Loader: "When you receive clean data, load it and publish done signal to `tinstar.done.<chain-id>`"

**Kick off:**
```bash
nats pub tinstar.pipeline.extractor "Extract sales data from Q1 report: ..."
nats sub tinstar.done.pipeline-001  # listen for completion
```

**Note:** Use `tinstar.done.<chain-id>` (not `nats req`) because the chain takes time and crosses multiple hops.

---

## Pattern 3: Parallel (Fan-out / Fan-in)

_Anthropic calls this: Parallelization_

**What it is:** One orchestrator fans out subtasks to N agents simultaneously. An aggregator collects all results.

**When to use:** Independent subtasks that can run concurrently. Analyzing feedback from multiple angles. Gathering data from multiple sources.

**Tinstar setup:**
```json
{ "name": "orchestrator", "nats": { "subscriptions": ["tinstar.task-abc.orchestrator"] } }
{ "name": "sentiment",    "nats": { "subscriptions": ["tinstar.task-abc.sentiment"] } }
{ "name": "keywords",     "nats": { "subscriptions": ["tinstar.task-abc.keywords"] } }
{ "name": "urgency",      "nats": { "subscriptions": ["tinstar.task-abc.urgency"] } }
{ "name": "aggregator",   "nats": { "subscriptions": ["tinstar.task-abc.aggregator"] } }
```

**Orchestrator instructions:**
"When you receive a task, fan it out simultaneously to sentiment, keywords, and urgency agents. All three should reply to `tinstar.task-abc.aggregator`."

**Aggregator instructions:**
"Collect results from sentiment, keywords, and urgency agents. When all three have arrived, synthesize and publish final result to `tinstar.done.<chain-id>`."

**Publish simultaneously (bash):**
```bash
MSG="Analyze this feedback: <text>"
nats pub tinstar.task-abc.sentiment "$MSG. Reply to tinstar.task-abc.aggregator"
nats pub tinstar.task-abc.keywords  "$MSG. Reply to tinstar.task-abc.aggregator"
nats pub tinstar.task-abc.urgency   "$MSG. Reply to tinstar.task-abc.aggregator"
```

Or let the orchestrator do the fan-out automatically.

---

## Pattern 4: Loop

**What it is:** A sequence of agents runs repeatedly until a termination condition is met (max iterations, time limit, or goal achieved).

**When to use:** Monitoring/polling tasks. Processes that must retry until success. Iterative tasks without a fixed endpoint.

**Tinstar setup:**
```json
{ "name": "monitor", "nats": { "subscriptions": ["tinstar.task-abc.monitor"] } }
```

**Agent instructions:**
"Check the build status every 60 seconds. If passing, publish `BUILD_GREEN` to `tinstar.done.build-watch`. If still failing after 10 checks, publish `BUILD_TIMEOUT`. Otherwise, wait and retry."

**Note:** The termination condition must be explicit. Infinite loops are expensive. Always set a max iteration count in the agent instructions.

---

## Pattern 5: Review and Critique (Generator + Critic)

_Anthropic calls this: Evaluator-Optimizer_

**What it is:** Agent A generates output. Agent B evaluates it. B either approves (signals done) or sends feedback back to A for revision. Repeats until quality threshold met.

**When to use:** Content that must meet strict criteria before use. Code generation with security review. Document drafting with quality gates.

**Tinstar setup:**
```json
{ "name": "generator", "nats": { "subscriptions": ["tinstar.task-abc.generator"] } }
{ "name": "critic",    "nats": { "subscriptions": ["tinstar.task-abc.critic"] } }
```

**Generator instructions:**
"When you receive a task or feedback, produce/revise the content. Publish your output to `tinstar.task-abc.critic`. If you receive APPROVED from the critic, stop."

**Critic instructions:**
"When you receive content, evaluate it against these criteria: [criteria]. If it passes, publish `APPROVED` to `tinstar.done.<chain-id>` AND to `tinstar.task-abc.generator`. If it fails, publish specific feedback to `tinstar.task-abc.generator`."

**Important:** Set max revision rounds in generator instructions (e.g., "After 5 revisions, publish your best attempt regardless").

---

## Pattern 6: Iterative Refinement

**What it is:** One or more agents progressively improve an output through multiple cycles. Similar to Review & Critique but a single agent may refine its own work.

**When to use:** Complex creative or technical tasks difficult to complete in one shot. Code debugging. Long-form document writing.

**Tinstar setup:**
```json
{ "name": "refiner", "nats": { "subscriptions": ["tinstar.task-abc.refiner"] } }
```

**Agent instructions:**
"Produce a first draft, critique it yourself, then revise. Repeat up to 3 times. After your final revision, publish the result to `tinstar.done.<chain-id>`."

This is effectively a ReAct loop within a single agent — no separate critic needed.

---

## Pattern 7: Coordinator

_Anthropic calls this: Routing (simple) / Orchestrator-Subagents (full)_

**What it is:** A central coordinator agent receives a request, decomposes it into subtasks, and routes each to the appropriate specialist. Uses AI reasoning for routing (not hardcoded logic).

**When to use:** Complex tasks requiring different specializations. Customer service routing. Research requiring multiple expert domains.

**Tinstar setup:**
```json
{ "name": "coordinator", "nats": { "subscriptions": ["tinstar.task-abc.coordinator"] } }
{ "name": "billing",     "nats": { "subscriptions": ["tinstar.task-abc.billing"] } }
{ "name": "technical",   "nats": { "subscriptions": ["tinstar.task-abc.technical"] } }
{ "name": "returns",     "nats": { "subscriptions": ["tinstar.task-abc.returns"] } }
```

**Coordinator instructions:**
"Receive user requests. Classify the request type and route to the appropriate specialist by publishing to their subject. Tell specialists to reply to `tinstar.done.<chain-id>`."

**Kick off:**
```bash
nats pub tinstar.task-abc.coordinator "Customer says: my order arrived damaged, I want a refund"
```

Coordinator reasons → routes to `returns` agent automatically.

---

## Pattern 8: Hierarchical Task Decomposition

**What it is:** Multi-level coordinator hierarchy. Root agent decomposes a complex goal into sub-goals, delegates to sub-coordinators, which decompose further into worker tasks.

**When to use:** Highly complex, ambiguous research or planning tasks. Tasks that naturally decompose into multi-level subtasks. When no single coordinator can hold all context.

**Subject scheme maps to Tinstar's entity hierarchy:**
```
tinstar.<initiative-id>.<coordinator>     — root coordinator
tinstar.<initiative-id>.<epic-id>.<coordinator>  — sub-coordinator
tinstar.<initiative-id>.<epic-id>.<task-id>.<worker>  — leaf worker
```

**This is Tinstar's native hierarchy** — the subscription scheme was designed for this. A root coordinator at the initiative level delegates to epic-level coordinators, which delegate to task-level workers. Tinstar's entity model IS the hierarchy.

---

## Pattern 9: Swarm

**What it is:** Multiple specialized agents with all-to-all communication. A dispatcher routes the initial request to the best starting agent. Agents can hand off to each other freely. No central orchestrator. Must have explicit exit conditions.

**When to use:** Highly complex, ambiguous problems benefiting from debate and diverse perspectives. Creative synthesis. Problems where the solution path isn't known in advance.

**This is the most expensive and complex pattern. Start with Coordinator instead.**

**Tinstar setup (using breakout room):**
```json
{ "name": "researcher",  "nats": { "subscriptions": ["tinstar.breakout.swarm-001", "tinstar.task-abc.researcher"] } }
{ "name": "engineer",    "nats": { "subscriptions": ["tinstar.breakout.swarm-001", "tinstar.task-abc.engineer"] } }
{ "name": "financial",   "nats": { "subscriptions": ["tinstar.breakout.swarm-001", "tinstar.task-abc.financial"] } }
{ "name": "dispatcher",  "nats": { "subscriptions": ["tinstar.task-abc.dispatcher"] } }
```

All swarm members subscribe to the shared `tinstar.breakout.swarm-001` subject. The dispatcher decides which agent to engage first.

**Agent instructions (all):**
"You are in a collaborative swarm on `tinstar.breakout.swarm-001`. Contribute your perspective when relevant. If another agent's expertise is better suited, hand off by publishing directly to their inbox. When the group reaches consensus or after 10 total exchanges, publish the final result to `tinstar.done.swarm-001` — whoever determines consensus publishes the done signal."

**Critical:** Set explicit exit conditions. Without them, swarms run forever.

---

## Pattern 10: Human-in-the-Loop

**What it is:** Workflow pauses at predefined checkpoints for human review, approval, or input before continuing.

**When to use:** High-stakes decisions. Safety-critical approvals. Subjective sign-offs. Financial transactions above a threshold.

**Tinstar + NATS approach:**
```json
{ "name": "worker", "nats": { "subscriptions": ["tinstar.task-abc.worker", "tinstar.task-abc.worker.approved"] } }
```

**Agent instructions:**
"Complete phase 1, then publish a summary to `tinstar.review.human` and wait. When you receive `APPROVED` on `tinstar.task-abc.worker.approved`, proceed with phase 2."

**Human approval (Clawson/operator):**
```bash
nats pub tinstar.task-abc.worker.approved "APPROVED — proceed"
```

This is also how Clawson acts as the human-in-the-loop for Tinstar agent workflows.

---

## Pattern 11: ReAct (Reason + Act)

**What it is:** Single-agent pattern where the agent iteratively reasons, acts (calls a tool), observes the result, and repeats until the task is complete. Built into Claude's default behavior.

**When to use:** Complex, dynamic tasks requiring continuous planning and adaptation. Any task with multiple tool calls. This is how Claude works by default.

**Tinstar setup:** Standard NATS session — no special configuration needed. The ReAct loop is internal to Claude. NATS is just the entry/exit transport.

---

## Quick Reference

| Pattern | Agents | NATS topology | Best for |
|---|---|---|---|
| Single agent | 1 | point-to-point | Simple tasks, prototypes |
| Sequential | N (linear) | chain | Structured pipelines |
| Parallel | N + aggregator | fan-out + fan-in | Independent concurrent subtasks |
| Loop | 1+ | cycle | Retry, polling, monitoring |
| Review & Critique | 2 (loop) | back-and-forth | Quality-gated output |
| Iterative Refinement | 1 | self-loop | Complex generation tasks |
| Coordinator | 1 + N specialists | hub-and-spoke | Routing, structured business logic |
| Hierarchical | Multi-level | tree | Complex decomposition, deep planning |
| Swarm | N (all-to-all) | breakout room | Debate, synthesis, high ambiguity |
| Human-in-loop | N + human | paused chain | High-stakes approvals |
| ReAct | 1 | N/A (internal) | Default Claude behavior |

## Cost / Complexity Ordering (cheapest → most expensive)

Single agent → ReAct → Sequential → Parallel → Loop → Review & Critique → Iterative Refinement → Coordinator → Hierarchical → **Swarm**

**Start simple. Add agents only when a single agent demonstrably fails.**

---

## Universal Standing Instructions Template

Tinstar injects this preamble into every NATS-enabled session's instructions:

```markdown
## NATS Channel Protocol

You receive messages via the nats-channel-mcp. Each message is formatted as:

--- incoming message ---
from:     <sender agent name, or 'unknown'>
replyTo:  <NATS reply-to subject, or 'none'>
subject:  <NATS subject this message arrived on>
---
<message body>

Rules:
1. If `from` matches your own name, discard the message silently.
2. If `replyTo` is not 'none', publish your response there.
3. If `replyTo` is 'none', use the reply subject specified in your instructions.
4. After 3+ consecutive replies with no new inbound message, stop and wait.
5. Never publish to a subject you are currently subscribed to (prevents echo loops).
```
