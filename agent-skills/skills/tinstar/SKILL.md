---
name: tinstar
description: Tinstar control plane — the broader API beyond spawning hands. Use for editor widgets, breakout rooms, arbitrary session queries, and when the tinstar-hand skill doesn't cover what you need.
---

# Tinstar

Control plane reference for the Tinstar multi-agent dashboard. **For the common case — spawning/steering/tearing-down a hand — use the `tinstar-hand` skill.** This skill covers everything else.

```bash
TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"
```

## Server modes

| Port | Mode | Command | Use case |
|---|---|---|---|
| 5273 | Standalone | `npx tinstar` | Stable, preferred |
| 5280 | Dev server | `npm run dev` | HMR during Tinstar development |

Detect: `lsof -i :5273 -i :5280 2>/dev/null | grep LISTEN`

Never start the dev server (5280) unless explicitly asked — HMR disrupts live workflows.

## Naming constraint

Session names **cannot contain dots** — tmux reads `.` as a pane separator and creation fails. Stick to `[a-z0-9-]`.

## Essential endpoints

```bash
curl -s "$TINSTAR_URL/api/state" | jq .                              # Full state (sessions, runs, tasks, epics)
curl -s "$TINSTAR_URL/api/hands" | jq .                              # Installed hands
curl -s "$TINSTAR_URL/api/cli-templates" | jq .                      # Agent templates
curl -s -X POST "$TINSTAR_URL/api/sessions/NAME/prompt" -d '{"text":"…"}'   # Non-NATS prompt
```

## Recall a dead session — the Graveyard

When a session is deleted it isn't gone: it's retired into the **Graveyard** with a
summary of what it covered and the handle needed to revive it. Before starting work,
check whether a past session already covered the same ground — then dig it up and ask it.

```bash
# 1. Search the graveyard by topic (matches the covers-summary, name, task).
curl -s "$TINSTAR_URL/api/graveyard?q=influx%20backfill" | jq '.data[] | {convId, sessionName, coversSummary}'

# 2. Necro one — revives the REAL agent (best-effort: works while Claude Code still
#    has the transcript). Returns {revivable, sessionName} or {revivable:false, reason}.
curl -s -X POST "$TINSTAR_URL/api/graveyard/<convId>/revive" | jq .

# 3. Ask it something (once revived, steer via the prompt endpoint — NOT tmux send-keys).
curl -s -X POST "$TINSTAR_URL/api/sessions/<sessionName>/prompt" -d '{"text":"What did you conclude about X?"}'

# Forget one forever (removes it from the graveyard):
curl -s -X POST "$TINSTAR_URL/api/graveyard/<convId>/purge"
```

Notes:
- A revived session whose worktree was deleted remembers the **conversation** but not the
  files — fine for "what did you find?", not for "go change that code."
- If revive returns `revivable:false`, the transcript is gone; use the `coversSummary` from
  the search result instead.
- Always build the URL from `TINSTAR_DASHBOARD_URL` (top of this skill) — never a raw port.

## Creating a standalone session (not a child hand)

Use this only when the session is genuinely standalone — a new line of work, not a helper for your current task. **If it's a helper, use the `tinstar-hand` skill** (spawns under `/api/sessions/<parent>/spawn`).

**Send the kickoff prompt IN the creation request** via the `prompt` field — do NOT create the session and then `POST .../prompt` as a second step. The CLI re-initializes during boot (the conversation id changes), so a separate prompt fired right after creation hits a race and is silently dropped. The `prompt` field is stored as the session's `initialPrompt` and delivered once the agent is actually ready.

```bash
curl -s -X POST "$TINSTAR_URL/api/sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-feature",
    "backend": "tmux",
    "cliTemplate": "Claude (multi-agent)",
    "project": "myproject",
    "worktree": true,
    "prompt": "Read context/entrypoint.md, then continue the work: <clear first task>."
  }'
```

`cliTemplate: "Claude (multi-agent)"` enables NATS. Omit only for plain non-collaborative sessions. `prompt` is the kickoff message (preferred). The separate `POST /api/sessions/<name>/prompt` endpoint is for **steering an already-running** session, not for the initial kickoff.

## Editor widgets (file on canvas)

Open a file in a read/write editor widget on the canvas — no agent session needed:

```bash
curl -s -X POST "$TINSTAR_URL/api/editor-widgets" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "my-session",
    "filePath": "relative/path/to/file.md"
  }'
```

- `sessionId`: session **name**, not UUID. Widget inherits the session's workspace, color, and taxonomy.
- `filePath`: relative to the session's workspace root, or absolute.

Delete: `DELETE /api/editor-widgets/:id`.

Use this when a user says "put this on the canvas" / "open this file on the canvas" — don't spawn an agent session for a file view.

## Breakout rooms

Cross-cutting NATS channels any session can join regardless of task hierarchy — useful for ad-hoc collaboration. Subscriptions are hot-managed; no restart required.

Subject: `tinstar.breakout.<room-name>`. No pre-registration — the room exists as soon as someone publishes to it.

**Requires:** target session must have NATS enabled (`cliTemplate: "Claude (multi-agent)"`), otherwise the subscription API returns `NATS_DISABLED`.

```bash
SESSION="my-session"
ROOM="tinstar.breakout.harness"

# Join (works on yourself or on another session — that's how "invite" works)
curl -s -X POST "$TINSTAR_URL/api/sessions/$SESSION/subscriptions" \
  -H "Content-Type: application/json" \
  -d "{\"subject\": \"$ROOM\"}"

# List subscriptions
curl -s "$TINSTAR_URL/api/sessions/$SESSION/subscriptions" | jq .

# Leave — DELETE takes a JSON body, NOT a URL param
curl -s -X DELETE "$TINSTAR_URL/api/sessions/$SESSION/subscriptions" \
  -H "Content-Type: application/json" \
  -d "{\"subject\": \"$ROOM\"}"

# Who's in the room? (no dedicated endpoint — filter /api/state)
curl -s "$TINSTAR_URL/api/state" \
  | jq -r --arg r "$ROOM" '.sessions[] | select(.nats.subscriptions[]? == $r) | .name'
```

Speak in a room with the `reply` MCP tool: `reply(to="tinstar.breakout.harness", text="anyone alive?")`.

## NATS subject scheme

```
tinstar.<space>.<initiative>.<epic>.<task>.<session>
```

Each session auto-subscribes to its task broadcast (`*` at the task level) and ancestor wildcards (`>`). Use the `reply` MCP tool to publish — from inside a running agent session it's the only sanctioned way to speak on NATS.

Full scheme lives in `docs/nats-agent-channels.md` in the Tinstar repo.

## Show the user an HTML artifact

When you want to show the user a chart, table, diagram, or any rendered output — **don't** ask them to open a file or browser tab. Write the HTML and POST its path; Tinstar reads the file, stores it, and auto-opens a browser widget on the canvas.

```bash
# 1. Write the HTML with your normal file tool, e.g. /tmp/energy-chart.html
# 2. Hand Tinstar the path:
curl -s -X POST "$TINSTAR_URL/api/artifacts" \
  -H "Content-Type: application/json" \
  -d '{ "path": "/tmp/energy-chart.html", "name": "energy-chart" }'
# → { "ok": true, "data": { "artifactId": "eph-ab12", "url": ".../api/artifacts/eph-ab12", "widgetId": "browser-7" } }
```

```bash
# Iterate: rewrite the same file, then PUT the path to refresh the open widget in place
curl -s -X PUT "$TINSTAR_URL/api/artifacts/eph-ab12" \
  -H "Content-Type: application/json" \
  -d '{ "path": "/tmp/energy-chart.html" }'
```

- The HTML is copied into Tinstar at POST/PUT time; the source file can be deleted after.
- Optional placement: `position`, `size`, `nearNodeId`, `slot`, `color` — same as `POST /api/browser-widgets`. Pass `sessionId` to color/associate the widget with a session.
- Spawned widgets snap to the session's constellation by default (so they raft with the session and tile in a row to its right); pass `"snapToSession": false` to spawn free-floating.
- An artifact and its browser widget share a lifecycle: closing/removing the widget deletes the artifact, and deleting the artifact removes the widget. `DELETE /api/artifacts/<id>` removes one artifact and closes its widget; `DELETE /api/artifacts` clears every artifact and closes their widgets.
- Max 5 MB. `console.log` from the page shows in the widget's console panel.

## See also

- `tinstar-hand` skill — spawn / steer / teardown (the 80% flow)
- `tinstar-tmux` skill — why direct tmux commands are an antipattern here
