---
name: tinstar
description: Discover and control other Claude agents running in Tinstar via the Tinstar API
---

# Tinstar Agent Control Skill

Use this skill to interact with other Claude sessions running in the Tinstar multi-agent dashboard.

## Base URL

The Tinstar API is available at `$TINSTAR_DASHBOARD_URL` (set in managed sessions) or `http://localhost:5273` by default.

```bash
TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"
```

## Discovering Agents

### List all sessions
```bash
curl -s "$TINSTAR_URL/api/sessions" | jq '.data[] | {name, state, backend, task: .task}'
```

### Get full state (runs, tasks, initiatives, epics)
```bash
curl -s "$TINSTAR_URL/api/state" | jq '{
  runs: [.runs[] | {id, status, task, sessionId}],
  tasks: [.tasks[] | {id, name}]
}'
```

### List sessions with their run status
```bash
curl -s "$TINSTAR_URL/api/state" | jq '[.runs[] | select(.status == "running") | {id, task, sessionId}]'
```

## Controlling Agents

### Send a prompt to a session (preferred — queued, returns immediately)
```bash
curl -s -X POST "$TINSTAR_URL/api/sessions/{name}/prompt" \
  -H "Content-Type: application/json" \
  -d '{"text": "Your message here"}'
```

### Send a prompt and wait for it to be typed + submitted (enter-prompt)
```bash
curl -s -X POST "$TINSTAR_URL/api/sessions/{name}/enter-prompt" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Your message here"}'
```

### Send raw keys to a session (tmux send-keys)
```bash
curl -s -X POST "$TINSTAR_URL/api/sessions/{name}/send-keys" \
  -H "Content-Type: application/json" \
  -d '{"keys": "q"}'
```

### Stop a session
```bash
curl -s -X POST "$TINSTAR_URL/api/sessions/{name}/stop"
```

### Start a stopped session
```bash
curl -s -X POST "$TINSTAR_URL/api/sessions/{name}/start"
```

## Creating New Agent Sessions

```bash
curl -s -X POST "$TINSTAR_URL/api/sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-agent",
    "project": "my-project",
    "prompt": "Initial task description",
    "taskId": "task-id-to-attach-to"
  }'
```

## Typical Workflow

1. **Discover** what's running: `GET /api/state`
2. **Find** the session you want by name or task
3. **Send** a prompt or instruction: `POST /api/sessions/{name}/prompt`
4. **Monitor** via SSE: `GET /api/events` (streams `managed_session.*` events)
5. **Coordinate** by sending follow-up prompts based on run status

## Canvas Widgets

Agents can spawn three types of widgets onto the canvas. All widget types appear immediately for the human watching the canvas.

> **Canvas positioning note:** Widget positions are managed by the human's browser (localStorage). When an agent spawns a widget, it appears on the canvas but the human controls where it lands — there is no API for agents to specify `x, y` coordinates yet. This is a known limitation being addressed in a future version.

### Browser Widgets

Embed a live web page on the canvas — useful for showing a running dev server, test results, or any URL.

```bash
# Create
curl -s -X POST "$TINSTAR_URL/api/browser-widgets" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "my-session-id", "url": "http://localhost:3000"}'

# Update URL on an existing widget
curl -s -X PATCH "$TINSTAR_URL/api/browser-widgets/{id}" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://localhost:3000/results"}'

# Delete
curl -s -X DELETE "$TINSTAR_URL/api/browser-widgets/{id}"
```

**Typical pattern:** create when starting a dev server, then PATCH the URL as new content is ready. The human can also drag the BROWSER button from a run widget header to create one manually.

### File Editor Widgets

Open a file in a read-only inline editor on the canvas — useful for showing generated output, config files, or any file the human should review.

```bash
# Create (filePath can be absolute or relative to the session workspace)
curl -s -X POST "$TINSTAR_URL/api/editor-widgets" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "my-session-id", "filePath": "/path/to/file.ts"}'

# Delete
curl -s -X DELETE "$TINSTAR_URL/api/editor-widgets/{id}"
```

Response includes the widget `id`. The widget is labelled with the run's task, epic, and initiative so the human knows which agent opened it.

### Image Widgets

Display an image file on the canvas — useful for showing screenshots, generated diagrams, or any image output.

```bash
# Create (filePath must be absolute; image dimensions are auto-detected)
curl -s -X POST "$TINSTAR_URL/api/image-widgets" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "my-session-id", "filePath": "/absolute/path/to/output.png"}'

# Delete
curl -s -X DELETE "$TINSTAR_URL/api/image-widgets/{id}"
```

The widget is sized to the image's natural dimensions (capped at 1200×900). Live file-watch is built in — if the file changes on disk, the widget updates automatically.

## Workspace Files

### List a directory in a session's workspace

```bash
curl -s "$TINSTAR_URL/api/sessions/{name}/files?path=relative/dir"
```

Returns `{ok, data: [{name, path, isDir}, ...]}`. `path` defaults to `.` (workspace root). Paths that escape the workspace return `400 INVALID_PATH`.

### Upload a file into a session's workspace

```bash
curl -s -X POST "$TINSTAR_URL/api/sessions/{name}/files/upload" \
  -F "path=relative/target/path.txt" \
  -F "file=@/local/source/file.txt"
```

Multipart fields:
- `path` — workspace-relative destination (must precede `file` in the multipart body)
- `file` — the file content

Response: `{ok: true, data: {path, bytes}}` on success.

Errors:
- `404 SESSION_NOT_FOUND` — no such session
- `400 INVALID_PATH` — destination escapes the workspace
- `413 FILE_TOO_LARGE` — exceeds the configured cap (see `/api/server-prefs`)
- `400 PARSE_FAILED` / `INVALID_MULTIPART` — bad multipart envelope
- `500 WRITE_FAILED` — disk error during write

Writes are atomic: the file streams to `.tinstar-upload.<rand>` in the destination directory, then `rename`s into place only on success. Partial uploads (aborted, oversized, or write-errored) leave no temp file. Intermediate directories are created with `mkdir -p` semantics. The session's recorded `workspace.path` is used as the root, so worktree-based sessions upload into their worktree, not the main repo.

## Server Preferences

```bash
# Read
curl -s "$TINSTAR_URL/api/server-prefs"
# → {"ok": true, "data": {"uploadMaxBytes": 104857600}}

# Update
curl -s -X PUT "$TINSTAR_URL/api/server-prefs" \
  -H "Content-Type: application/json" \
  -d '{"uploadMaxBytes": 52428800}'
```

Persisted to `~/.config/tinstar/server-prefs.json` (or `$TINSTAR_CONFIG_HOME/server-prefs.json`). Currently exposes:
- `uploadMaxBytes` — per-file upload cap in bytes. Minimum 1 MB; default 100 MB. Enforced server-side on both `Content-Length` (early reject) and streamed bytes (busboy limit).

## SSE Event Stream (monitoring)

```bash
curl -s -N "$TINSTAR_URL/api/events" | while read line; do
  echo "$line"
done
```

**Session events:** `managed_session.created`, `managed_session.state_changed`, `managed_session.idle`, `managed_session.deleted`

**Widget events** (entity field + data null = deleted):
- `browserWidget` — browser widget created, updated, or deleted
- `editorWidget` — file editor widget created or deleted
- `imageWidget` — image widget created or deleted
