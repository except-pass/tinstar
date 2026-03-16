# Orchestrate Skill Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `percentDone` to the task model with a sidebar progress bar, then write the `/orchestrate` foreman skill.

**Architecture:** Two independent pieces — a small data-model + UI change to Tinstar, and a skill document that needs no code. The code change threads `percentDone` from the Task type through the PATCH API, SSE snapshot, and TreeNode into the sidebar renderer. The skill is a markdown file installed as a slash command.

**Tech Stack:** TypeScript, React, Tailwind — existing Tinstar stack. No new dependencies.

---

## Chunk 1: `percentDone` — backend + sidebar UI

### Task 1: Add `percentDone` to the Task type and TreeNode

**Files:**
- Modify: `src/domain/types.ts` (Task interface, line 69; TreeNode interface, line 105)
- Modify: `src/domain/grouping.ts` (task node builder, line ~165)

- [ ] **Step 1: Add `percentDone` to Task interface**

In `src/domain/types.ts`, update the `Task` interface:

```typescript
export interface Task {
  id: string
  name: string
  epicId: string
  initiativeId: string
  status: string
  summary: string
  settings?: EntitySettings
  spaceId?: string
  percentDone?: number | null
}
```

- [ ] **Step 2: Add `percentDone` to TreeNode**

In `src/domain/types.ts`, update `TreeNode`:

```typescript
export interface TreeNode {
  id: string
  label: string
  type: GroupingDimension | 'run'
  entityId: string
  children: TreeNode[]
  runCount: number
  activeCount: number
  color?: string
  orphan?: boolean
  backend?: 'docker' | 'tmux' | null
  percentDone?: number | null
}
```

- [ ] **Step 3: Populate `percentDone` when building task TreeNodes**

In `src/domain/grouping.ts`, find the `nodes.push({...})` block around line 163 (where `label: group.label` is set). The loop variable is `entityId` (from `for (const [entityId, group] of groups)`). The correct method on `taxonomy` is `getTaskById`.

Add `percentDone` conditionally — only task-dimension nodes carry it:
```typescript
percentDone: dimension === 'task' ? taxonomy.getTaskById(entityId)?.percentDone ?? null : undefined,
```

Place this inside the `nodes.push({...})` object alongside the other fields.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/domain/grouping.ts
git commit -m "feat: add percentDone to Task and TreeNode types #tinstar-self-improvement"
```

---

### Task 2: Expose `percentDone` through the API

**Files:**
- Modify: `src/server/api/routes.ts` (POST /api/tasks, line ~403)

The PATCH handler (line ~522) already uses `deepMergeEntity` which will pass through any field in the body — so PATCH works with no changes. Only the POST handler needs updating to accept and default `percentDone`.

- [ ] **Step 1: Update POST /api/tasks to accept `percentDone`**

In `src/server/api/routes.ts`, find the `POST /api/tasks` handler (~line 403) and add `percentDone` to the destructure and entity object:

```typescript
const { name, epicId, initiativeId, status, summary, id: providedId, percentDone } = JSON.parse(body)
const entity = {
  id: providedId ?? shortId('task'),
  name: name ?? 'Untitled Task',
  epicId: epicId ?? '',
  initiativeId: initiativeId ?? '',
  status: status ?? 'active',
  summary: summary ?? '',
  spaceId: ctx.docStore.activeSpaceId,
  percentDone: percentDone ?? null,
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Manual smoke test**

```bash
# Create a task with percentDone
curl -s -X POST http://localhost:5273/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"name":"test","epicId":"","percentDone":42}' | jq '.percentDone'
# Expected: 42

# PATCH to update it
TASK_ID=$(curl -s -X POST http://localhost:5273/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"name":"test2","epicId":""}' | jq -r '.id')
curl -s -X PATCH "http://localhost:5273/api/tasks/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{"percentDone":75}' | jq '.data.percentDone'
# Expected: 75

# Verify null default
curl -s -X POST http://localhost:5273/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"name":"test3","epicId":""}' | jq '.percentDone'
# Expected: null

# Clean up all three test tasks (only $TASK_ID was captured above — delete the others by name or just re-query)
curl -s -X DELETE "http://localhost:5273/api/tasks/$TASK_ID" > /dev/null
# Tip: run `curl -s http://localhost:5273/api/state | jq '[.tasks[] | select(.name | startswith("test")) | .id]'`
# to find and delete any other test tasks left behind
```

- [ ] **Step 4: Commit**

```bash
git add src/server/api/routes.ts
git commit -m "feat: expose percentDone on task POST/PATCH API #tinstar-self-improvement"
```

---

### Task 3: Progress bar in the sidebar

**Files:**
- Modify: `src/components/HierarchySidebar.tsx` (SidebarNode render, ~line 195)

The `SidebarNode` already receives a `TreeNode` which now carries `percentDone`. Render a thin progress bar below the label row when the value is not null.

- [ ] **Step 1: Add the progress bar after the label span**

In `src/components/HierarchySidebar.tsx`, find the label span (~line 196):

```tsx
<span className="truncate flex-1">{node.label}</span>
```

The progress bar belongs after the entire row `<div>` (the one with `group flex items-center`), as a sibling — a narrow full-width bar that sits flush below the row. Add it inside the outer wrapping `<div>` (the one that also contains the drop-before indicator), after the row div:

```tsx
{/* Progress bar — only for tasks with percentDone set */}
{node.type === 'task' && node.percentDone != null && (
  <div
    className="h-px mx-2 bg-surface-raised overflow-hidden"
    style={{ marginLeft: `${depth * 16 + 8}px` }}
  >
    <div
      className="h-full bg-primary/60 transition-all duration-500"
      style={{ width: `${node.percentDone}%` }}
    />
  </div>
)}
```

Keep it subtle: 1px tall, sits flush below the row, uses `primary/60` to match the sidebar's color language. No label or number — the Tinstar UI can surface the number in a tooltip or detail panel if desired later.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Visual smoke test**

With the dev server running (`npm run dev`), open Tinstar in the browser. Use curl to PATCH a task's `percentDone` to 50 and verify a thin bar appears below that task in the sidebar. Then PATCH to `null` and verify the bar disappears.

```bash
# Get a real task id from state
TASK_ID=$(curl -s http://localhost:5273/api/state | jq -r '.tasks[0].id')
curl -s -X PATCH "http://localhost:5273/api/tasks/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{"percentDone":50}' | jq '.data.percentDone'
# Look at the sidebar — bar should appear at 50%

curl -s -X PATCH "http://localhost:5273/api/tasks/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{"percentDone":null}' | jq '.data.percentDone'
# Bar should disappear
```

- [ ] **Step 4: Commit**

```bash
git add src/components/HierarchySidebar.tsx
git commit -m "feat: show percentDone progress bar on task sidebar nodes #tinstar-self-improvement"
```

---

## Chunk 2: `/orchestrate` skill

### Task 4: Write the `/orchestrate` slash command

**Files:**
- Create: `~/.claude/commands/orchestrate.md`

This is a skill document, not application code. It defines the behavior Claude follows when the user runs `/orchestrate`. It must be self-contained — Claude reads it fresh each invocation with no prior context.

- [ ] **Step 1: Write the skill file**

Create `~/.claude/commands/orchestrate.md`:

````markdown
# Orchestrate

You are the **foreman**. The user is the **architect**. Your job is to handle all task/session/worktree management so the architect only touches decisions and judgment.

## How to be invoked

`/orchestrate <seed>` — the architect gives you a seed idea. You brainstorm it into a full work plan, then dispatch workers to implement it.

---

## Phase 1 — Brainstorm

Run a full brainstorm using the `superpowers:brainstorming` skill (invoke it now). The output is not a spec — it is a **work plan**: a flat list of tasks, each with:

- **Name** — short slug, e.g. `auth-flow` (becomes the session name and commit tag)
- **Summary** — one paragraph: what to build and why
- **Acceptance criteria** — bulleted, specific, testable
- **Complexity notes** — what's hard, what to watch for
- **Dependencies** — which tasks must complete first

Go as deep as needed. Plan big chunks confidently.

The architect approves the work plan before anything is dispatched.

---

## Phase 2 — Dispatch

Once the plan is approved, for each task:

### 2a. Get context
```bash
TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"
curl -s "$TINSTAR_URL/api/state" | jq '{epics: [.epics[] | {id,name}], tasks: [.tasks[] | {id,name,epicId}]}'
```

Identify the target epic. If none exists for this work, create one:
```bash
curl -s -X POST "$TINSTAR_URL/api/epics" \
  -H "Content-Type: application/json" \
  -d '{"name":"<epic name>"}'
```

### 2b. Create all tasks first (no sessions yet)

For each task in the plan:
```bash
curl -s -X POST "$TINSTAR_URL/api/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<task-slug>",
    "epicId": "<epic-id>",
    "summary": "<one paragraph summary>",
    "status": "pending"
  }'
```

### 2c. Spin up sessions

Session name convention: `<epic-slug>-<task-slug>` (e.g. `v3-3-auth-flow`).
The branch name equals the session name.

Get the current project name from your own session:
```bash
SESSION=$(tmux display-message -p '#S' 2>/dev/null || echo "")
# Try sessions endpoint first; fall back to "tinstar"
PROJECT=$(curl -s "$TINSTAR_URL/api/sessions" | jq -r --arg s "$SESSION" '.data[] | select(.name == $s) | .project // empty' | head -1)
PROJECT="${PROJECT:-tinstar}"
echo "Project: $PROJECT"
```

Respect dependencies from the work plan — only spin up a task when all tasks it depends on are `done`. Spin up independent tasks in parallel.

For each task ready to start, create a session with the briefing as the initial prompt:
```bash
curl -s -X POST "$TINSTAR_URL/api/sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<session-name>",
    "backend": "tmux",
    "project": "<project>",
    "taskId": "<task-id>",
    "prompt": "<briefing — see format below>"
  }'
```

Update task status to active:
```bash
curl -s -X PATCH "$TINSTAR_URL/api/tasks/<task-id>" \
  -H "Content-Type: application/json" \
  -d '{"status": "active"}'
```

### Worker briefing format

```
## Epic
<epic name> — <one sentence goal>

## All Tasks in This Epic
- [done] <task-a>: <summary>
- [active] <task-b>: <summary>   ← you are here
- [pending] <task-c>: <summary>

## Your Task: <task name>
<full task summary>

### Acceptance Criteria
- <criterion>
- <criterion>

### Complexity Notes
<what's hard, what to watch for>

### Branch & Commits
Branch: <session-name>  (this is your worktree branch)
Use /tinstar-commit for all commits. Tag: #<task-slug>
If blocked on something outside your scope, say so clearly.
```

---

## Phase 3 — Coordination

The architect runs the UI — they can see session states, cycle through idle agents, send messages. Your job is on-demand management.

### Verbs the architect will use

| Architect says | You do |
|---|---|
| `"add a task for X"` | `POST /api/tasks` — creates the entity only, no session |
| `"spin up [task]"` | Create session for an existing pending task, send briefing, PATCH status → active |
| `"[worker] is done"` | `POST /api/sessions/:name/stop`, PATCH task status → done, PATCH percentDone → 100 |
| `"[worker] is stuck on X"` | `POST /api/sessions/:name/prompt` if idle; `POST /api/sessions/:name/enter-prompt` if mid-turn |
| `"reprioritize [task]"` | Update `summary` or reorder in the work plan — no status change, no session stop |
| `"cancel [task]"` | `POST /api/sessions/:name/stop` if running, PATCH task status → cancelled |
| `"update progress"` | Read codebase (see below), PATCH percentDone on all active tasks |

### Updating progress

When asked to update progress:

1. Get all active tasks and their slugs from `/api/state`
2. For each task, filter commits by `#<task-slug>` tag. Commits in the state snapshot look like `{ sha, subject, taskTags: ["slug1", "slug2"], ... }`:
   ```bash
   curl -s "$TINSTAR_URL/api/state" | jq '[.commits[] | select(any(.taskTags[]; . == "<task-slug>"))]'
   ```
3. Read the actual diffs — use `git log` and `git show` on the relevant commits to understand what's been built
4. Apply engineering judgment: how much of the *hard* work remains? What's left is more important than what's done.
5. PATCH each task:
   ```bash
   curl -s -X PATCH "$TINSTAR_URL/api/tasks/<task-id>" \
     -H "Content-Type: application/json" \
     -d '{"percentDone": <0-100>}'
   ```
   - `null` if no commits exist yet (do not guess)
   - Weight by complexity: if the scaffolding is done but the hard integration isn't, that might be 15% not 50%

### Session stop vs delete

Always use `POST /api/sessions/:name/stop` — never delete. Run history is preserved.

---

## What you do NOT do

- Monitor workers — the Tinstar UI handles this
- Read agent logs or recap entries — committed code is the source of truth
- Make architectural decisions — escalate to the architect
- Auto-merge worktrees — the architect confirms merges
````

- [ ] **Step 2: Verify the file is loadable as a slash command**

```bash
ls -la ~/.claude/commands/orchestrate.md
# Expected: file exists, readable
wc -l ~/.claude/commands/orchestrate.md
# Expected: ~100+ lines
```

- [ ] **Step 3: Commit the skill to the repo for reference**

Also save a copy in the repo so it's version-controlled alongside the spec:

```bash
cp ~/.claude/commands/orchestrate.md /home/ubuntu/repo/tinstar/docs/superpowers/
git add docs/superpowers/orchestrate.md
git commit -m "docs: add /orchestrate skill document #tinstar-self-improvement"
```
````
