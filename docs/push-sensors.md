# Push Sensors Inventory

Every push-based event source available to tinstar, organized by what we're sensing.

---

## 1. Claude Code Hooks (18 events)

Claude Code has a native hook system. Hooks are registered in `.claude/settings.json` and fire shell commands (typically `curl` back to tinstar). Every hook receives JSON on stdin with common fields: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`.

### Session Lifecycle

| Hook | Fires When | Can Block? | Key Data |
|------|-----------|------------|----------|
| **SessionStart** | Session begins or resumes | No | `source` (startup/resume/clear/compact), `model` |
| **SessionEnd** | Session terminates | No | matcher: clear/logout/prompt_input_exit/other |
| **Stop** | Claude finishes responding, waits for input | Yes (exit 2 continues conversation) | — |
| **PreCompact** | Before context compaction | No | matcher: manual/auto |

### User Interaction

| Hook | Fires When | Can Block? | Key Data |
|------|-----------|------------|----------|
| **UserPromptSubmit** | User submits a prompt | Yes (exit 2 erases prompt) | `prompt` text |
| **Notification** | Claude sends a notification | No | `message`, `notification_type` (permission_prompt, idle_prompt, auth_success, elicitation_dialog) |

### Tool Use (richest data source)

| Hook | Fires When | Can Block? | Key Data |
|------|-----------|------------|----------|
| **PreToolUse** | Before a tool executes | Yes (exit 2 blocks tool) | `tool_name`, `tool_input` (full args), `tool_use_id`. Matcher on tool name: Bash, Edit, Write, Read, Glob, Grep, etc. |
| **PostToolUse** | After a tool succeeds | No | `tool_name`, `tool_input`, `tool_response` |
| **PostToolUseFailure** | After a tool fails | No | `tool_name`, `tool_input`, `error` |
| **PermissionRequest** | Permission dialog appears | Yes (exit 2 denies) | `tool_name`, `tool_input`, `permission_suggestions` |

### Agent/Subagent

| Hook | Fires When | Can Block? | Key Data |
|------|-----------|------------|----------|
| **SubagentStart** | Subagent spawned | No | `agent_id`, `agent_type` (Explore, Plan, custom) |
| **SubagentStop** | Subagent finishes | Yes | `agent_id`, `agent_type` |
| **TeammateIdle** | Team teammate about to go idle | Yes | `agent_id`, `agent_type` |
| **TaskCompleted** | Task marked as completed | Yes | `task_id`, `task_state` |

### Configuration & Workspace

| Hook | Fires When | Can Block? | Key Data |
|------|-----------|------------|----------|
| **InstructionsLoaded** | CLAUDE.md or rules loaded | No | `file_path`, `file_type`, `scope` |
| **ConfigChange** | Config file changes mid-session | Yes | `source` (user/project/local/policy/skills), `file_path` |
| **WorktreeCreate** | Worktree being created | Yes | `branch`, `base_branch`; stdout = worktree path |
| **WorktreeRemove** | Worktree being removed | No | `worktree_path` |

### What This Gives Us

With hooks alone we can push:

- **Session state** (running/idle/stopped) — via Stop, PreToolUse, UserPromptSubmit, SessionStart, SessionEnd
- **What Claude is doing** — via PreToolUse/PostToolUse (tool name + full input/output)
- **What files are being touched** — via PreToolUse/PostToolUse on Write, Edit, Read tools (`tool_input.file_path`)
- **What commands are running** — via PreToolUse/PostToolUse on Bash (`tool_input.command`)
- **Conversation content** — via PostToolUse (`tool_response`), UserPromptSubmit (`prompt`)
- **Permission prompts** — via Notification + PermissionRequest
- **Subagent activity** — via SubagentStart/Stop
- **Task completion** — via TaskCompleted

---

## 2. Docker Events (container lifecycle)

Docker's event stream is a persistent HTTP connection or CLI stream. Fully push-based.

| Event | Fires When | Key Data |
|-------|-----------|----------|
| `create` | Container created | container name, image, labels |
| `start` | Container starts | — |
| `stop` | Container stops (graceful) | — |
| `die` | Container process exits | **`exitCode`** in attributes |
| `kill` | Container receives signal | signal name |
| `restart` | Container restarts | — |
| `destroy` | Container removed | — |
| `health_status` | Health check changes | healthy/unhealthy/starting |
| `oom` | Out of memory kill | — |
| `exec_create`/`exec_start`/`exec_die` | Exec instances | — |

**How to subscribe:** `docker events --filter container=<prefix> --format '{{json .}}'` or via Docker Engine API `GET /events`.

**What this gives us:** Instant notification when a session's container starts, dies, or is removed — no polling needed for process liveness.

---

## 3. tmux Hooks (session/pane lifecycle)

tmux hooks fire shell commands on specific events. Set via `tmux set-hook`.

| Hook | Fires When | Key Data |
|------|-----------|----------|
| `session-created` | New tmux session | `#{session_name}` |
| `session-closed` | Session destroyed | `#{session_name}` |
| `pane-died` | Process in pane exits | `#{session_name}`, **`#{pane_dead_status}`** (exit code), `#{pane_pid}` |
| `alert-silence` | No pane output for N seconds | `#{session_name}` (configure with `monitor-silence <seconds>`) |
| `alert-activity` | Output detected in monitored pane | `#{session_name}` (configure with `monitor-activity on`) |

**What this gives us:** Push notification when a tmux-backed session's Claude process exits (`pane-died` with exit code), plus idle detection (`alert-silence`).

---

## 4. Filesystem Watchers (inotify)

Linux inotify provides push events when files change. Node.js `fs.watch()` uses this.

### What to Watch

| Target | Watch Path | Events | What It Tells Us |
|--------|-----------|--------|------------------|
| JSONL conversation files | `~/.claude/projects/<id>/*.jsonl` | `CLOSE_WRITE` | New conversation entries appended (can tail from last offset) |
| Working directory changes | `<worktree-path>/` (recursive, exclude `.git/`) | `CLOSE_WRITE`, `CREATE`, `DELETE` | Files being created/modified/deleted during a run |
| Claude config changes | `<workspace>/.claude/` | `CLOSE_WRITE`, `CREATE` | Settings or hook config modified |
| Session state files | `~/.config/tinstar/sessions/` | `CLOSE_WRITE`, `CREATE`, `DELETE` | Session metadata changes |

### Limitations

- inotify watch limit per user (default 8192, increase via `sysctl`)
- No events for content diffs — you know *that* a file changed, not *what* changed
- Doesn't work on network filesystems (NFS, CIFS)
- Bind mounts in Docker generally work; named volumes work

---

## 5. Git Hooks (repository events)

Git hooks fire on git operations. Installed in `.git/hooks/` or via `core.hooksPath`.

| Hook | Fires When | Key Data |
|------|-----------|----------|
| `post-commit` | After a commit | `HEAD` sha, branch, changed files via `git diff-tree` |
| `post-checkout` | After branch switch | previous ref, new ref, branch-flag |
| `post-merge` | After a merge | squash-flag |
| `post-rewrite` | After amend/rebase | old-sha → new-sha pairs on stdin |

**Worktree note:** Worktrees share the parent repo's `.git/hooks/`, so installing hooks once covers all worktrees. Or use `core.hooksPath` per-worktree for isolation.

**What this gives us:** Push notification on commits (with changed file list), branch switches, merges — without polling `git status`.

---

## 6. Process Lifecycle (child process events)

| Mechanism | What It Does | When to Use |
|-----------|-------------|-------------|
| Node.js `child_process` `'exit'` event | Push notification when a spawned process exits, with exit code and signal | When tinstar directly spawns docker/tmux |
| pidfd (Linux 5.3+) | File descriptor that becomes readable when a process exits | Monitoring processes we didn't spawn |
| cgroup events | `cgroup.events` file signals when all processes in a container's cgroup exit | Lower-latency alternative to Docker events |

---

## Coverage Matrix

What each sensor covers, mapped to the data requirements:

| Data Need | Best Sensor | Backup Sensor |
|-----------|------------|---------------|
| Session state (running/idle) | **Claude hooks** (Stop, PreToolUse, UserPromptSubmit) | tmux `alert-silence` |
| Session alive/dead | **Docker events** (die) / **tmux hooks** (pane-died) | Reconciliation poll |
| Touched files | **Claude hooks** (PostToolUse on Write/Edit) | inotify on worktree |
| Commands executed | **Claude hooks** (PreToolUse/PostToolUse on Bash) | — |
| Git commits | **Git hooks** (post-commit) | inotify on `.git/refs/heads/` |
| Branch switches | **Git hooks** (post-checkout) | — |
| Conversation updates | **Claude hooks** (PostToolUse) or **inotify** on JSONL | — |
| Permission prompts | **Claude hooks** (Notification, PermissionRequest) | — |
| Stale/stuck detection | **Claude hooks** (absence of activity) + timer | Reconciliation poll |
| Subagent activity | **Claude hooks** (SubagentStart/Stop) | — |
| Task completion | **Claude hooks** (TaskCompleted) | — |

---

## What Still Needs Polling

Even with all push sensors, a few things require periodic reconciliation (~30s):

1. **Stale detection** — if no hook has fired in >120s for a "running" session, it may be stuck. This is a timer, not a poll, but it's not strictly push.
2. **Orphan cleanup** — if the tinstar server restarts, it needs to reconcile stored state against actual Docker/tmux state. This is a one-time startup sweep, not continuous polling.
3. **Resource usage** (CPU/memory) — Docker `stats` is a polling stream. Only needed if we want to show resource metrics.
