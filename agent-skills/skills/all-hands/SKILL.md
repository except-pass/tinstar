---
name: all-hands
description: Orchestrate a high-consequence build with a team of specialist hands briefing, consulting, and reviewing around a single accountable implementer. Use when the goal is one coherent feature or fix that crosses multiple expertise lanes (security, perf, testability, UX, etc.) and getting it wrong is expensive. Three phases — brief, implement, review — in a shared NATS breakout room. Skip for multi-track parallel work, simple solo tasks, or already-decided designs with no remaining uncertainty.
---

# All Hands

A team of specialists briefs you, stays available while you build, and reviews your work — all in one shared room. You are the implementer and the accountable agent.

## When to use

- A single coherent feature or fix (not a multi-track parallel goal)
- High consequence — getting it wrong is expensive (auth, migrations, public APIs, data integrity, architectural change)
- Crosses multiple expertise lanes — security, performance, testability, UX, etc. — and no single agent has full coverage
- Worth the token cost — hands stay alive across the arc, so for a 10-minute change this is overkill

## When NOT to use

- Independent parallel tracks → use a different orchestration pattern, not this one
- Already-decided design with no remaining uncertainty → just implement
- Small fixes — overhead isn't worth it

## Cast

| Role | Identity | Lifetime | Responsibility |
|------|----------|----------|----------------|
| **Implementer** | The agent that ran `/all-hands` (you, if you're reading this) | Whole arc | Bootstrap the room, write code, make final calls when hands disagree, write `decisions.md` |
| **Hand** | A Tinstar hand spawned per specialist archetype | Whole arc | Owns `hands/<name>/`, declares standing watch + review checklist, briefs, consults, reviews |

There is no separate foreman. You bootstrap (with subagent help if useful for roster brainstorming), then become the implementer.

## Phase 1 — Briefing (parallel)

### Bootstrap (you, the implementer)

1. Read the goal. Ask the user any blocking clarifications.
2. Draft a roster proposal: 4–8 hands, each with a one-line "why this hand". A subagent may help brainstorm against the goal. See `references/hand-archetypes.md` for a catalog of common archetypes.
3. Show the roster to the user. They can swap, add, or drop hands. Once approved, proceed.
4. Spawn the hands via the `tinstar-hand` skill. Pass each hand its mandate and a pointer to the workspace.
5. Open the breakout room (Tinstar's existing primitive — see the `tinstar` skill).
6. Copy `assets/entrypoint-template.md` into the workspace as `entrypoint.md` and fill in the goal restatement, room subject, and `hands/<name>/` index.
7. Post the goal + roster + each hand's mandate to the room.

### Hand work (parallel, independent)

Each hand owns `hands/<name>/` and produces its own progressively-disclosed mini-wiki. The internal structure is up to the hand, but each must include:

- An **entry doc** — what an implementer reads first to know what this hand cares about
- **`standing-watch.md`** — the 1–2 triggers that should ping this hand mid-implementation. See `references/standing-watch-format.md`.
- **`review-checklist.md`** — what this hand will grade against in Phase 3 (locked here; prevents goalpost drift). See `references/review-checklist-format.md`.
- Optional deeper detail docs for progressive disclosure

Hands work only in their own sub-dir — no write collisions. They may read each other's wikis but must not edit them. If hand A thinks hand B missed something, A says so in the room.

### Done

Each hand posts `briefing-ready` to the room. When all hands have posted, you post `briefing-closed` and begin Phase 2. The user can interject anytime and effectively reopen briefing.

## Phase 2 — Implementation (solo)

One agent in the worktree (you), hands lurking in the room.

### Your behavior

- Read `entrypoint.md` to discover what's available, then drill into whichever `hands/<name>/` wikis are relevant to the part you're working on. Progressive disclosure — no obligation to read all of them up front.
- Implement normally.
- Two ways to involve a hand:
  1. **Pull (@-mention):** `@security: is storing the refresh token in localStorage acceptable here?` Use the `reply` MCP tool with the hand's NATS subject.
  2. **Push (standing watch):** when a commit hits a hand's declared trigger, that hand pipes up unsolicited.
- After each commit, post a one-liner to the room: `committed: <files changed> — <commit subject>`. Each hand reads its own `standing-watch.md` and self-decides whether to wake. This is the v1 trigger mechanism — no external watcher required.
- You are not obligated to follow advice. Acknowledge in the room either way (`acknowledged, not changing — reasoning: X`). The transcript is the audit trail.

### Hand behavior (for reference; hands handle this themselves)

- Default: lurking. Subscribe to the broadcast, do nothing on most messages.
- Wake on (a) @-mention, (b) standing-watch trigger, (c) cross-lane issue from another hand. Otherwise silent.
- When woken, answer crisply. Do not re-litigate the briefing.

### Done

Post `ready-for-review` with a short summary of what landed and a pointer to the diff. Phase 3 begins.

## Phase 3 — Review (parallel)

### Hand reviews (independent)

Each hand:

1. Reads the diff
2. Inspects code as their lane demands (tester runs tests, security greps for secrets and auth changes, perf reads hot paths, etc.)
3. Posts a verdict to the room — exactly one of: **pass**, **concerns** (non-blocking), **block** (must fix)
4. Findings must be concrete: `file:line + what's wrong + suggested fix or open question`. No vague "looks risky."

### Public disagreement

Hands see each other's verdicts. If hand A blocks on something hand B has data on, they say so in the room. Hands can update verdicts in response. No private channels.

### Final calls (you)

Once verdicts are in and back-and-forth has settled, make the call: address findings, defer with reasoning, or override. Every override needs a stated reason in the room.

Then write `decisions.md` summarizing:
- Findings addressed (with commit refs)
- Findings deferred (with reasoning + follow-up if any)
- Findings overridden (with reasoning)

### Hard rule

> **Do not ship while any hand has an open `block` verdict without explicit user approval.**

This is your behavioral instruction, not a mechanism. If you find yourself wanting to override a block silently, stop — escalate to the user instead.

### Exit

Post `all-hands-complete`. Hands tear themselves down (use the `tinstar-hand` teardown procedure). The durable artifacts are:

- `entrypoint.md`
- `hands/<name>/` (each hand's wiki + verdict)
- `decisions.md`
- `room-transcript.md`

## Workspace layout

Under your Tinstar task's session dir (e.g. `~/.config/tinstar/tasks/<task-id>/all-hands/`):

````
all-hands/
  entrypoint.md            # router only — you write this at bootstrap
  hands/
    skeptic/               # each hand owns its sub-dir
      entry.md
      standing-watch.md
      review-checklist.md
      details/...
    security/
    tester/
    ...
  decisions.md             # you write this at end
  room-transcript.md       # NATS dump
````

## NATS subjects

Use Tinstar's existing breakout-room primitive. Subjects scoped to the all-hands instance:

- Room broadcast: `tinstar.<init>.<epic>.<task>.allhands`
- Direct to a hand: `tinstar.<init>.<epic>.<task>.allhands.<hand-name>`

All hands subscribe to the broadcast. @mentions resolve to the per-hand subject.

## Cost guardrails (norms, not enforcement)

- Hands lurk by default during implementation
- Hands answer concisely; if a deeper dive is needed, they update their own wiki and link to it
- Briefing soft budget: one round of authoring + one round of reading peers' wikis. No iteration forever.
- Standing watches fire only on commit-summary lines, not every message

## See also

- `tinstar-hand` — how to spawn, steer, and tear down hands
- `tinstar` — broader control-plane API including breakout rooms
- `references/hand-archetypes.md` — catalog of common archetypes for roster picking
- `references/example-arc.md` — worked example of a complete all-hands run
