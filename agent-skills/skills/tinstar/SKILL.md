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

## Creating a standalone session (not a child hand)

Use this only when the session is genuinely standalone — a new line of work, not a helper for your current task. **If it's a helper, use the `tinstar-hand` skill** (spawns under `/api/sessions/<parent>/spawn`).

```bash
curl -s -X POST "$TINSTAR_URL/api/sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-feature",
    "backend": "tmux",
    "cliTemplate": "Claude (multi-agent)",
    "project": "myproject",
    "worktree": true
  }'
```

`cliTemplate: "Claude (multi-agent)"` enables NATS. Omit only for plain non-collaborative sessions.

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

## See also

- `tinstar-hand` skill — spawn / steer / teardown (the 80% flow)
- `tinstar-tmux` skill — why direct tmux commands are an antipattern here
