# Orchestrate Skill — Design Spec

**Date**: 2026-03-15
**Status**: Approved

## Problem

Managing multiple agent sessions in Tinstar creates overhead that doesn't require the architect's judgment: creating tasks, spinning up sessions, writing briefings, tracking worktrees, updating progress. The architect's value is in decision-making. Everything else is foreman work.

## Solution

A `/orchestrate` skill that makes the current session the foreman. The architect provides direction and judgment. The foreman handles all task/session/worktree CRUD, writes worker briefings, and tracks real progress against the codebase.

The Tinstar UI already handles session monitoring (idle state, cycling with `[`). This skill does not replicate that. It handles what the UI can't: decomposing work, briefing workers with full context, and assessing genuine progress.

---

## Phases

### Phase 1 — Brainstorm

Triggered by `/orchestrate <seed>`. The foreman runs a full brainstorm — asking clarifying questions one at a time, going as deep as needed to produce a thorough, well-scoped work plan. The goal is to plan work in large, confident chunks, not rush to dispatch. Output is a markdown work plan listing tasks with:

- Name (short slug, becomes the Tinstar task name and session name)
- Summary (one paragraph — what needs to be built and why)
- Acceptance criteria (bulleted, specific, testable)
- Complexity notes (rough estimate of hard vs. easy parts)
- Dependencies on other tasks in the plan

The architect approves the work plan before anything is dispatched.

### Phase 2 — Dispatch

For each task in the approved plan, the foreman:

1. Creates a Tinstar task via `POST /api/tasks` with `name`, `summary`, `epicId`, and sets `status: "pending"`
2. Finalizes the session name as `<epic-slug>-<task-slug>` (e.g. `v3-3-auth-flow`) — **the branch name equals the session name**, determined before writing the briefing
3. Creates a session via `POST /api/sessions` with `name`, `taskId`, `project`, `prompt` — `project` is required for worktree creation and must be resolved (from the current run's project, or confirmed with the architect)
4. Updates the task to `status: "active"` once the session is running

**Session name convention**: `<epic-slug>-<task-slug>`
**Branch convention**: equals the session name (set automatically on session creation)

Each worker's initial prompt (the briefing) contains:

```
## Epic
<epic name> — <one sentence goal of the epic>

## All Tasks
- [done] task-a: <summary>
- [active] task-b: <summary>   ← you are here
- [pending] task-c: <summary>

## Your Task: <task name>
<full task summary>

### Acceptance Criteria
- <criterion>
- <criterion>

### Complexity Notes
<what's hard, what to watch out for>

### Branch & Commits
Branch: <session-name>  (this is your worktree branch)
Commit with tinstar-commit. Tag: #<task-slug>
If blocked on something outside your scope, say so clearly.
```

Workers get enough context to start immediately and understand how their work fits the whole.

**Task status lifecycle**: `pending` (created) → `active` (session running) → `done` (work complete)

### Phase 3 — Coordination

On-demand. The architect asks; the foreman acts.

**Progress updates** (`"update progress"`):

*Requires the `percentDone` prerequisite to be shipped. Until then, progress assessment is verbal only.*

The foreman reads the codebase — specifically commits filtered from `GET /api/state` by `#<task-slug>` tag to identify per-task diffs — and applies engineering judgment to assess `percentDone` for each task. This is not a checklist count. If 3 of 10 acceptance criteria are met but those 3 were the easy ones, `percentDone` reflects the harder remaining work (e.g. 15%, not 30%). If no tagged commits exist for a task yet, `percentDone` stays `null` — the foreman does not guess.

The foreman then PATCHes each task's `percentDone` so the Tinstar UI progress bars reflect real progress.

**Coordination verbs:**

| Architect says | Foreman does |
|---|---|
| `"add a task for X"` | Creates the Tinstar task entity only (`status: "pending"`). No session started yet. |
| `"spin up [task]"` | Creates session + worktree for an existing pending task, sends briefing, sets `status: "active"` |
| `"[worker] is done"` | Sets `status: "done"`, calls `POST /api/sessions/:name/stop` (preserves run history), sets `percentDone: 100` |
| `"[worker] is stuck on X"` | Sends guidance via `POST /api/sessions/:name/prompt` (queued, non-interrupting) |
| `"reprioritize / cancel [task]"` | Updates task status, stops session if running |
| `"update progress"` | Reads codebase diffs per task, PATCHes `percentDone` on all active tasks |

**Stop vs. delete**: "done" means `POST /api/sessions/:name/stop` — the session and run history are preserved for audit. Sessions are never deleted by the foreman.

---

## Prerequisites

Two pieces of Tinstar need to be built before the full skill is functional:

### 1. `percentDone` on Task model

- Add `percentDone: number | null` to the `Task` interface (default `null`)
- `null` means "not tracking" — the feature is opt-in. The foreman only starts setting `percentDone` when explicitly asked to update progress.
- Expose via `PATCH /api/tasks/:id` — accepts `percentDone` in body
- Include in `GET /api/state` snapshot and SSE deltas

### 2. Progress bar on Task cards in UI

- Render a progress bar on task cards when `percentDone !== null`
- Subtle, inline — fills proportionally to `percentDone`
- Does not render at all when `percentDone` is `null`

---

## What This Skill Does Not Do

- **Monitor workers** — the Tinstar UI does this. The foreman does not poll or watch SSE.
- **Read agent logs or recap entries** — committed code is the source of truth for progress.
- **Make architectural decisions** — blockers and judgment calls are escalated to the architect.
- **Auto-merge worktrees** — merges are handled manually when the architect confirms work is done.
- **Delete sessions** — the foreman only stops sessions; run history is always preserved.
