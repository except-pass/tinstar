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
curl -s "$TINSTAR_URL/api/sessions" | jq '.data[] | {name, state, backend, project: .project, worktree: .workspace.branch}'
```

### Get full state (runs and organizational scope)
```bash
curl -s "$TINSTAR_URL/api/state" | jq '{
  runs: [.runs[] | {id, status, scope, sessionId}]
}'
```

### List sessions with their run status
```bash
curl -s "$TINSTAR_URL/api/state" | jq '[.runs[] | select(.status == "running") | {id, scope, sessionId}]'
```

### Is a session actually working, or stuck on a prompt?

A session parked on an unanswered permission prompt looks identical to one doing
real work — it reports `running` either way, because from the outside a pending
tool call is a pending tool call. `/timeline` tells the two apart by
reconstructing where the session's wall-clock time actually went.

```bash
curl -s "$TINSTAR_URL/api/sessions/$NAME/timeline" | jq '.data.bands[-1]'
```

The band kinds are `approval`, `question`, `subagent`, `compact`, `tool`, `idle`
and `think`. If the last band is `approval` or `question` and its `end` is close
to now, **nobody has answered it** — the agent is blocked on a human, not busy.

```bash
# every session currently parked on a human, and for how long
for s in $(curl -s "$TINSTAR_URL/api/sessions" | jq -r '.data[].name'); do
  curl -s "$TINSTAR_URL/api/sessions/$s/timeline" | jq -r --arg s "$s" '
    .data.bands[-1] // empty
    | select(.kind == "approval" or .kind == "question")
    | "\($s): \(.kind) for \(((.end - .start) / 60) | floor)m — \(.detail)"'
done
```

Bands never overlap and always sum to the span, so totals can be taken directly:

```bash
# where this session's whole life went, as a percentage per kind
curl -s "$TINSTAR_URL/api/sessions/$NAME/timeline" | jq '
  .data as $d | ($d.t1 - $d.t0) as $span
  | reduce $d.bands[] as $b ({}; .[$b.kind] += ($b.end - $b.start))
  | with_entries(.value = ((.value / $span * 100) | round))'
```

Two caveats worth knowing before you act on this:

- `think` is a **residual** — in-turn time with no tool outstanding. It absorbs
  genuine reasoning and anything the transcript format doesn't record, so read it
  as an upper bound, not a measurement.
- `data` is `null` when the session has no resolvable transcript (a Codex session
  with no workspace path, for instance). That is a real answer, not an error.

Failures are reported separately as `marks`, and only a non-zero exit code counts
— the words "error" and "failed" appear in a large share of ordinary tool output:

```bash
curl -s "$TINSTAR_URL/api/sessions/$NAME/timeline" | jq '.data.marks[] | select(.kind == "tool-failed")'
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
    "worktree": true,
    "prompt": "Initial work description"
  }'
```

## Typical Workflow

1. **Discover** what's running: `GET /api/state`
2. **Find** the session you want by name, Project, or Worktree
3. **Send** a prompt or instruction: `POST /api/sessions/{name}/prompt`
4. **Monitor** via SSE: `GET /api/events` (streams `managed_session.*` events)
5. **Coordinate** by sending follow-up prompts based on run status

## Canvas Widgets

Agents can spawn three types of widgets onto the canvas. All widget types appear immediately for the human watching the canvas.

Every widget has an optional organizational scope. A Worktree always belongs to
exactly one Project; omit both fields for Unscoped. Widgets spawned by a session
inherit its scope automatically. To move any existing run, editor, browser,
image, graveyard, or plugin widget in the hierarchy:

```bash
curl -s -X PATCH "$TINSTAR_URL/api/widgets/<widget-id>/scope" \
  -H "Content-Type: application/json" \
  -d '{"project":"my-project","worktree":"feature-branch"}'

# Clear to Unscoped
curl -s -X PATCH "$TINSTAR_URL/api/widgets/<widget-id>/scope" \
  -H "Content-Type: application/json" -d '{}'
```

Changing scope updates the hierarchy immediately but does not move the widget.
The human uses the single **Organize** action when they want the canvas repacked.

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

**Never embed Tinstar in a browser widget.** `POST` and `PATCH` reject URLs whose origin is the Tinstar dashboard (`localhost:5273`, `localhost:5280`, or `$TINSTAR_DASHBOARD_URL`). Loading the dashboard inside itself ("Tinstar-ception") duplicates every session and widget and will crawl the machine. Use browser widgets for **external** pages (dev servers, stretchplan at `http://localhost:8932/p/<slug>`, etc.) or `POST /api/artifacts` for agent-generated HTML.

#### Stretchplan

"Spawn a stretchplan" means **write a plan file and give the user a URL** — not open a browser widget by default.

```bash
# Default — no canvas widget
# 1. Write ~/.config/stretchplan/plans/<slug>.json
# 2. bin/stretchplan server start   # one shared server on port 8932
# 3. Tell the user: http://localhost:8932/p/<slug>
```

Only when the user explicitly asks to put the plan **on the canvas**:

1. Browser widget at `http://localhost:8932/p/<slug>` (path is `/p/<slug>`, not `?plan=`)
2. Optional: `stretchplan-task` plugin widget in the same constellation slot (see stretchplan `tinstar-plugin/README.md`)

Never point a browser widget at `$TINSTAR_URL` or `localhost:5273` for stretchplan work.

#### Spawning with `attach`

Both `POST /api/browser-widgets` and `POST /api/plugin-widgets` accept an optional `attach` field that positions the new widget flush against an existing one by aligning named anchor points:

```json
{
  "url": "http://localhost:3000",
  "attach": {
    "to": "<target-widget-id>",
    "anchors": "<existing-anchor>/<new-anchor>"
  }
}
```

- `to` — the node id of the existing widget to attach to.
- `anchors` — a `/`-separated pair: the anchor on the **target** (left of `/`) and the anchor on the **new** widget (right of `/`). The new widget is positioned so those two points coincide, and a snap edge joins them into the target's constellation.

**Example:** `"anchors": "top-right/top-left"` places the new widget flush to the right of the target, aligning their top edges.

**Valid anchor names** — the 8 defaults, accepted on any widget:

`top-left`, `top-center`, `top-right`, `middle-left`, `middle-right`, `bottom-left`, `bottom-center`, `bottom-right`

The `attach` API currently accepts only these 8 names. Supplying any other name returns `400 INVALID_PARAMS`. (Plugins can declare custom anchor sets in their manifest, but those are not yet honored by `attach` or drag-to-snap.)

**Target layout constraint:** `attach.to` must be a widget that already has a persisted layout entry in the canvas layout store (`tinstar-layouts-v3`). This is the same resolution path used by `nearNodeId`. A widget created moments ago via the API whose position has not yet been flushed to the store will not resolve as an attach target — use a widget that is already placed on the canvas (e.g. the session's run widget, a seeded workspace widget, or any widget the user has positioned). If the target layout cannot be resolved the request returns an error.

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

Response includes the widget `id`. The widget inherits the spawning run's Project/Worktree scope.

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
