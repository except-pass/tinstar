# Review & Critique Pattern — Design Spec

Multi-agent pattern where an orchestrator spawns a worker, reviews their work, and iterates until satisfied.

## Goals

1. **Single point of contact** — User prompts the orchestrator; it handles coordination
2. **Reusable patterns** — Pattern templates as markdown files, like skills
3. **Minimal new concepts** — Pattern files use existing Tinstar session API fields
4. **Observable** — All sessions visible on canvas, messages flow via NATS

## Non-Goals

- Schema enforcement for agent messages (future work — start lightweight)
- Custom pattern builder UI (patterns are files, not entities)
- More than 2 agents in this pattern (orchestrator + worker is sufficient)

---

## Architecture

### 2-Agent Model

```
┌─────────────────────────────────┐
│  ORCHESTRATOR                   │  ← Your single point of contact
│  - Receives your prompt         │
│  - Sends task to worker (NATS)  │
│  - Reviews submitted work       │
│  - Sends feedback or approves   │
│  - Reports final result to you  │
└─────────────────────────────────┘
                ↕ NATS
┌─────────────────────────────────┐
│  WORKER                         │
│  - Spawned by orchestrator      │
│  - Receives task + instructions │
│  - Does the actual work         │
│  - Submits work for review      │
│  - Revises based on feedback    │
└─────────────────────────────────┘
```

The orchestrator wears two hats: **coordinator** (spawns, routes) and **reviewer** (critiques, approves). This keeps the user with one point of contact while enabling a real review loop.

### Message Flow

1. User selects pattern, enters prompt, clicks Create
2. Tinstar spawns both orchestrator and worker sessions (both visible immediately)
3. Orchestrator receives user's prompt, sends task to worker via NATS
4. Worker does work, submits back to orchestrator via NATS
5. Orchestrator reviews, sends feedback or approves
6. Loop until orchestrator satisfied
7. Orchestrator reports result to user

---

## Pattern File Format

Pattern templates live in `~/.config/tinstar/patterns/` as markdown files with YAML frontmatter.

### Location

```
~/.config/tinstar/patterns/
├── bug-review.md
├── code-review.md
└── research.md
```

### Format

Pattern files define session configs using the **same fields as the Tinstar session API**, plus Jinja-style templating for dynamic values.

```yaml
---
name: bug-review
description: Worker searches for root cause, orchestrator reviews with /proveit
---

orchestrator:
  backend: tmux
  project: cmsandbox
  prompt: |
    You are orchestrating a bug review for {{task}}.
    
    1. Spawn a worker session using the tinstar API
    2. Tell the worker to use /bugsearcher to find the root cause
    3. Review their work using /proveit discipline
    4. Don't accept claims without file:line evidence
    5. Push back on speculation
    6. When satisfied, report the findings

worker:
  backend: tmux
  project: cmsandbox
  worktree: true
  prompt: |
    You are a worker on {{task}}.
    Use /bugsearcher to find the root cause.
    Submit your findings to the orchestrator.
    Address any feedback and resubmit until approved.
```

### Template Variables

| Variable | Description |
|----------|-------------|
| `{{task}}` | Task name or ID |
| `{{taskId}}` | Task ID |
| `{{sessionId}}` | This session's ID |
| `{{orchestrator}}` | Orchestrator's NATS subject (for worker to reply to) |
| `{{worker}}` | Worker's NATS subject |

### Session Config Fields

Same as `POST /api/sessions`:

| Field | Type | Description |
|-------|------|-------------|
| `backend` | string | `tmux` or `docker` |
| `project` | string | Project name from `~/.config/tinstar/projects.json` |
| `worktree` | boolean | Create new git worktree |
| `worktreePath` | string | Use existing worktree |
| `skipPermissions` | boolean | Run without permission prompts |
| `prompt` | string | Initial prompt (supports templating) |

---

## UX Flow

### Session Start Dialog

Add a **Pattern** dropdown to the existing session start dialog.

```
┌──────────────────────────────────────┐
│ New Session                          │
├──────────────────────────────────────┤
│ Name:     [jira-123-review        ]  │
│ Pattern:  [bug-review           ▾]  │
│ Prompt:   [Review JIRA-123...     ]  │
│                                      │
│              [Cancel]  [Create]      │
└──────────────────────────────────────┘
```

**Behavior:**
- Pattern defaults to "Single" (current single-session behavior)
- Selecting a multi-agent pattern shows sessions that will be created
- User's prompt is injected into the **orchestrator only**
- On create, Tinstar spawns all sessions defined in the pattern

### Canvas Layout

When a pattern starts, all sessions appear on canvas immediately:
- Orchestrator and worker spawn side by side
- Both are real session widgets, observable and interactive
- User can peek into worker's session to see progress

---

## Implementation Notes

### Pattern Discovery

Tinstar scans `~/.claude/patterns/*.md` on startup and when patterns change. Pattern names appear in the session start dropdown.

### Session Spawning

When user creates a session with a pattern:

1. Parse pattern file, extract session configs
2. Interpolate template variables (`{{task}}`, etc.)
3. Spawn orchestrator session with user's prompt
4. Spawn worker session (prompt from pattern, no user input)
5. Create Run entries so both appear in UI
6. Both sessions get NATS subscriptions scoped to the task

### NATS Channel MCP Requirement

Multi-agent patterns require the **nats-channel-mcp** server. Only agents with this MCP server configured can participate in patterns.

When Tinstar spawns pattern sessions, it auto-configures `.mcp.json` in each session's workspace with the nats-channel-mcp server and appropriate subscriptions.

### NATS Subject Convention

Sessions in the same task share a namespace:
```
tinstar.{space}.{initiative}.{epic}.{task}.{session-name}
```

Orchestrator can message worker at `tinstar.{...}.{task}.worker`.
Worker can message orchestrator at `tinstar.{...}.{task}.orchestrator`.

### Orchestrator Behavior

The orchestrator is a regular Claude session with:
1. The pattern file in its context (so it knows its role)
2. The user's prompt
3. NATS for messaging worker (worker already exists, spawned by Tinstar)

It interprets worker responses naturally — no schema enforcement. If the worker says "here's what I found", the orchestrator evaluates it. If it says "done", the orchestrator decides if that's acceptable.

---

## Migration from Current Patterns

The current `patterns.ts` hardcoded patterns will be replaced by:
1. Pattern files in `~/.claude/patterns/`
2. Pattern discovery at startup
3. Session spawning using the new format

The session start dialog replaces the task creation pattern dropdown. Patterns are now about how you start sessions, not how you create tasks.

---

## Success Criteria

1. User can select "bug-review" pattern when starting a session
2. Orchestrator and worker sessions both spawn and appear on canvas immediately
3. User's prompt goes to orchestrator only
4. Orchestrator can send tasks to worker via NATS
5. Worker can submit work back to orchestrator via NATS
6. Orchestrator can review, send feedback, and eventually approve
7. User sees final result from orchestrator
