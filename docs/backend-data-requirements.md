# Backend Data Requirements

What the tinstar backend needs to track. Focused on **what**, not how.

---

## 1. Projects

A **project** is a registered git repository that tinstar manages.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| name | string | Human-friendly name (e.g., "platform-core") |
| path | string | Absolute path to the git repo root |
| registeredAt | timestamp | When the project was registered |

**Notes:**
- A project is a 1:1 mapping to a git repository on disk.
- Projects are registered manually by the user — tinstar doesn't auto-discover them.
- All worktrees, sessions, and runs exist within the context of a project.

---

## 2. Worktrees

A **worktree** is a git worktree providing branch-level isolation for a session.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| projectId | string | FK → Project |
| name | string | Display name (usually matches branch) |
| branch | string | Git branch name |
| path | string | Absolute path to the worktree directory |
| basePath | string | Path to the parent repo (for git operations) |
| createdAt | timestamp | When the worktree was created |

**Notes:**
- Worktrees live at `<project-path>-worktrees/<session-name>/`.
- Each worktree inherits the parent repo's `.claude/` directory.
- A worktree is typically 1:1 with a session, but a session can also run against the main repo directly (no worktree).
- Worktrees are cleaned up when their associated session is deleted.

---

## 3. Sessions

A **session** is a running (or previously running) Claude Code instance. This is the core execution unit.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| name | string | Human-friendly name (lowercase-dashes, unique) |
| projectId | string | FK → Project |
| worktreeId | string? | FK → Worktree (null if using main repo) |
| backend | enum | `'docker'` or `'tmux'` |
| state | enum | See state machine below |
| conversationId | string? | Claude Code conversation ID (for resume) |
| port | number? | Allocated ttyd/terminal port |
| pid | number? | Process ID (ttyd PID for tmux, container ID for docker) |
| skipPermissions | boolean | Whether `--dangerously-skip-permissions` is set |
| oneshot | boolean | Ephemeral single-run session (no terminal) |
| profile | string? | Docker image profile name |
| prompt | string? | Initial prompt sent on creation |
| createdAt | timestamp | When the session was created |
| lastActiveAt | timestamp | Last hook callback time |

### Session State Machine

```
creating → running ↔ idle → stopped → terminated
              ↓                ↑
         needs_attention ──────┘
```

| State | Meaning |
|-------|---------|
| `creating` | Backend is spinning up (container/tmux) |
| `running` | Claude is actively executing (tool use, thinking) |
| `idle` | Claude stopped, waiting for user input |
| `needs_attention` | Running but no hook activity for >120s (likely stuck on permission prompt or question) |
| `stopped` | Explicitly stopped by user, can be resumed |
| `terminated` | Process died unexpectedly or session was cleaned up |

### State Transitions

| From | To | Trigger |
|------|----|---------|
| creating | running | Backend start completes |
| running | idle | `Stop` hook fires |
| idle | running | `PreToolUse` or `UserPromptSubmit` hook fires |
| running | needs_attention | No hook activity for 120s (reconciliation) |
| needs_attention | running | Hook fires again |
| running/idle/needs_attention | stopped | User stops session |
| stopped | running | User restarts session |
| any | terminated | Process missing on reconciliation |

---

## 4. Hooks

Claude Code hooks are how sessions communicate state back to tinstar. These are not stored as entities but configured as part of session setup.

### Hook Events

| Event | When | Callback |
|-------|------|----------|
| `Stop` | Claude finishes and waits for input | → session state becomes `idle` |
| `PreToolUse` | Claude is about to use a tool (bash, file ops, etc.) | → session state becomes `running` |
| `UserPromptSubmit` | User submits a prompt | → session state becomes `running` |

### Hook Mechanism

- Hooks are registered in `.claude/settings.json` within the session's workspace.
- Each hook runs a `curl` POST back to the tinstar server with the session name.
- Hooks are installed when a session is created and removed when it's deleted.
- Hooks are idempotent — reinstalling doesn't duplicate them.

---

## 5. Taxonomy: Initiatives, Epics, Tasks

The organizational hierarchy for planning and grouping work.

### Initiative

The highest-level strategic goal.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| name | string | Display name (e.g., "AI Dev Platform") |
| color | string | Hex color for UI theming |
| status | enum | `'active'`, `'paused'`, `'archived'` |
| summary | string | Brief description |

### Epic

A major body of work within an initiative.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| name | string | Display name |
| initiativeId | string | FK → Initiative |
| status | enum | `'active'`, `'complete'`, `'paused'` |
| summary | string | Brief description |

### Task

A specific piece of work within an epic. This is what a session/run actually works on.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| name | string | Display name |
| epicId | string | FK → Epic |
| initiativeId | string | FK → Initiative (denormalized for query convenience) |
| status | enum | `'active'`, `'complete'`, `'queued'`, `'paused'` |
| summary | string | Brief description |

### Hierarchy

```
Initiative (1) → Epic (many) → Task (many) → Run (many)
```

---

## 6. Runs

A **run** is a single execution of Claude Code against a task. It's the thing the user sees on the canvas. A session may produce multiple runs over its lifetime (e.g., sequential tasks), or a run may map 1:1 to a session.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier (e.g., "R-241") |
| sessionId | string | FK → Session |
| taskId | string | FK → Task |
| worktreeId | string | FK → Worktree |
| status | enum | `'active'`, `'idle'`, `'complete'`, `'failed'`, `'queued'` |
| createdAt | timestamp | When the run started |
| completedAt | timestamp? | When the run finished (null if still running) |

### Run Embedded Data

These are collected during execution and stored with the run:

#### Touched Files

Files modified during the run.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| name | string | Filename (e.g., "scheduler.go") |
| path | string | Directory path (e.g., "pkg/api/v1") |
| additions | number | Lines added |
| deletions | number | Lines deleted |
| kind | enum | `'code'`, `'test'`, `'config'`, `'script'`, `'doc'` |

#### Procedures

Commands or operations executed during the run.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| name | string | Display name (e.g., "Run_Tests") |
| command | string | Shell command (e.g., "go test ./...") |
| status | enum | `'idle'`, `'queued'`, `'running'`, `'complete'`, `'failed'` |

#### Recap Entries

Summarized conversation events — what happened during the run.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| type | enum | `'agent'`, `'user'`, `'status'` |
| content | string | Message text |
| timestamp | string | When this entry occurred |
| diff | DiffBlock? | Optional code diff associated with this entry |

#### Diff Blocks

Code changes associated with a recap entry.

| Field | Type | Description |
|-------|------|-------------|
| filename | string | File that was changed |
| header | string | Hunk header (e.g., "@@ -14,4 +14,5 @@") |
| lines | DiffLine[] | Individual diff lines |

Each DiffLine has a `type` (`'context'`, `'addition'`, `'deletion'`, `'header'`) and `content` (string).

---

## 7. Secrets

Environment variables injected into sessions at launch.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Environment variable name (e.g., `CLAUDE_CODE_OAUTH_TOKEN`) |
| value | string | The secret value (never exposed to frontend) |

### Required Secrets

| Secret | Purpose |
|--------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code authentication |
| `GH_TOKEN` | GitHub CLI access |

### Optional Secrets

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Direct API access (for command parsing, etc.) |
| `GEMINI_API_KEY` | Alternative model access |
| `SLACK_TOKEN` | Slack integration |
| `GH_APP_ID` / `GH_INSTALLATION_ID` / `GH_APP_KEY` | GitHub App authentication |

---

## 8. Profiles

Docker image configurations for session backends.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Profile name (e.g., "default") |
| image | string | Docker image tag (e.g., "qala:latest") |

---

## 9. Real-Time Events

The server must emit events for live UI updates. These aren't stored entities but are the notification channel.

| Event | Payload | Trigger |
|-------|---------|---------|
| `session.created` | `{ name, state }` | New session created |
| `session.state_changed` | `{ name, state }` | Hook callback or reconciliation |
| `session.deleted` | `{ name }` | Session removed |

---

## 10. Reconciliation

The backend must periodically verify that reported state matches reality.

| Check | What | Action |
|-------|------|--------|
| Process alive | Is the docker container / tmux session still running? | If not → `terminated` |
| Stale detection | Has a `running` session had no hook activity for >120s? | → `needs_attention` |
| State correction | Does stored state match actual process state? | Correct and emit SSE event |

Reconciliation runs every ~30 seconds.

---

## Entity Relationship Summary

```
Project (1)
  ├─→ Worktree (many)
  └─→ Session (many)
        ├─→ Worktree (0..1)
        └─→ Run (many)
              ├─ TouchedFile[] (embedded)
              ├─ Procedure[] (embedded)
              └─ RecapEntry[] (embedded)
                    └─ DiffBlock? (optional)

Initiative (1)
  └─→ Epic (many)
        └─→ Task (many)
              └─→ Run (many)

Worktree (1)
  └─→ Run (many)
```

### Cross-Cutting Relationships

- A **Run** connects the taxonomy hierarchy (Initiative→Epic→Task) with the infrastructure hierarchy (Project→Worktree→Session).
- The **grouping dimensions** (initiative, epic, task, worktree) let the UI pivot on any of these axes.
- **Sessions** are the execution containers; **Runs** are the observable work units displayed to the user.

---

## What the Frontend Already Expects

The current prototype frontend (mock data) consumes:

- `Initiative[]`, `Epic[]`, `Task[]`, `Worktree[]` — taxonomy entities
- `Run[]` — with embedded `touchedFiles`, `recapEntries`, `procedures`
- `GroupingDimension` — for dynamic hierarchy pivoting
- `TreeNode` — built client-side from the above via `buildGroupTree()`
- `RunSummaryViewModel`, `GroupRollupViewModel` — computed client-side

The backend needs to serve all of the above as real data instead of mocks.
