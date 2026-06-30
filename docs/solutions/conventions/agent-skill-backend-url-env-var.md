---
title: Agent skills must derive the backend URL from TINSTAR_DASHBOARD_URL, not TINSTAR_BACKEND_PORT
date: 2026-06-30
category: docs/solutions/conventions
module: agent-skills
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "Writing or editing an agent-facing skill under agent-skills/skills/ that curls the backend"
  - "Any agent-run snippet (skill, hand prompt, docs/agent-api example) needs the backend base URL"
  - "Tempted to build the URL from a port (localhost:5273) or a port env var"
tags: [agent-skills, env-vars, backend-url, managed-sessions, tinstar-dashboard-url, conventions, tinstar]
---

# Agent skills must derive the backend URL from TINSTAR_DASHBOARD_URL, not TINSTAR_BACKEND_PORT

## Context

A new agent skill (`tinstar-push-file`) needed to POST to the backend. The first
draft built the base URL from a port:

```bash
curl ... "http://localhost:${TINSTAR_BACKEND_PORT:-5273}/api/sessions/..."
```

This looks reasonable but is wrong: **`TINSTAR_BACKEND_PORT` is never injected into
an agent's session environment.** It's only read by `standalone.ts` for the
server's own startup arg parsing and by Vite/e2e fixtures — it never reaches the
shell an agent runs in. So the `:-5273` default always wins, silently ignoring any
operator override that points agents at a non-default backend (a dev server on
5280, or a second backend isolated via `TINSTAR_CONFIG_HOME`). The push lands on
the wrong dashboard — or `SESSION_NOT_FOUND` against the wrong backend.

A code-review pass (agent-native reviewer) caught it before merge.

## Guidance

Every agent-facing snippet derives the backend base URL the same way the rest of
the skill set already does:

```bash
TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"
curl -sS "$TINSTAR_URL/api/sessions/${TINSTAR_SESSION_NAME}/..."
```

- **`TINSTAR_DASHBOARD_URL`** is the var actually injected into managed sessions,
  and is the documented override for a non-default backend (`docs/agent-api.md`:
  *"The Tinstar API is available at `$TINSTAR_DASHBOARD_URL` (set in managed
  sessions) or `http://localhost:5273` by default."*).
- **`TINSTAR_SESSION_NAME`** is the only other reliably-injected identity var —
  it's the agent's own session name, so don't guess it.

What `tmux set-environment` actually injects into a session (see
`src/server/sessions/backends/tmux.ts`): `TINSTAR_SESSION_NAME`, the NATS vars
(`TINSTAR_NATS_TOPICS_FILE`, `TINSTAR_NATS_CONTROL_SOCKET`), secrets, and OTEL
telemetry vars. Nothing else from the server's own env is propagated — so an
agent snippet may only rely on those.

## Why This Matters

- **Silent wrong-target failures.** A port-based URL ignores the operator's
  `TINSTAR_DASHBOARD_URL`, so a second backend or a dev server is invisible to the
  skill. The failure is silent (wrong dashboard) or a confusing `SESSION_NOT_FOUND`,
  not a clear error.
- **Consistency is discoverability.** Every existing skill uses the
  `TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"` line. A skill
  that invents its own scheme is the one an agent or maintainer trips over.
- **Plan text is not authority.** The first draft's port approach was carried from
  the plan; the convention (and the env-injection reality in `tmux.ts`) overrides
  it. Verify env-var availability against `tmux.ts`, not against what looks
  plausible.

## When to Apply

- Writing or reviewing any skill under `agent-skills/skills/` that talks to the
  backend over HTTP.
- Authoring agent-run curl examples in docs or hand prompts.
- Any time a snippet that runs *inside an agent session* needs the backend URL or
  a session-identity value — only `TINSTAR_DASHBOARD_URL` and
  `TINSTAR_SESSION_NAME` (plus NATS/secret/OTEL vars) are guaranteed present.

## Examples

**Before (rejected) — port var that's never injected into the session:**

```bash
curl -sS -X POST \
  "http://localhost:${TINSTAR_BACKEND_PORT:-5273}/api/sessions/${TINSTAR_SESSION_NAME}/files/push-download" \
  -H 'content-type: application/json' -d '{"path":"report.csv"}'
```

**After (shipped) — the established convention, honors operator overrides:**

```bash
TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"
curl -sS -X POST \
  "$TINSTAR_URL/api/sessions/${TINSTAR_SESSION_NAME}/files/push-download" \
  -H 'content-type: application/json' -d '{"path":"report.csv"}'
```

## Related

- `docs/agent-api.md` — documents `$TINSTAR_DASHBOARD_URL` as the canonical agent base URL
- `agent-skills/skills/tinstar/SKILL.md`, `agent-skills/skills/tinstar-hand/SKILL.md` — sibling skills using the `TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-...}"` line
- `src/server/sessions/backends/tmux.ts` — the `set-environment` calls that define exactly which vars reach a session
- `src/server/hands/builtins/index.ts` — built-in hand prompt that also documents the same URL convention
