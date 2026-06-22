---
title: Don't add bespoke per-plugin server routes — compose generic endpoints
date: 2026-06-16
category: docs/solutions/conventions
module: plugin-system
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "A tinstar plugin (bundled or external) needs server-side data or to run a host command"
  - "You're tempted to add an /api/<plugin-name> route for a single plugin's needs"
  - "A standalone (non-session-backed) plugin widget needs per-session or host state"
tags: [plugin-api, plugin-boundary, api-design, server-routes, generic-endpoints, composition, tinstar]
---

# Don't add bespoke per-plugin server routes — compose generic endpoints

## Context

V5 tinstar plugins are **frontend-only by design** (`docs/plugins/README.md` → "Widgets,
panes, commands only — no server-side plugin code"). When a plugin needs something the
browser can't do — read host state, run a command in a worktree, probe a service — the
tempting shortcut is to add a plugin-named core route like `GET /api/roborev/fleet`.

That shortcut quietly defeats the plugin boundary. The plugin stops being a pure frontend
extension and grows a dedicated tendril into the server, coupling core to that one plugin's
needs. Will flagged this directly while building the roborev fleet widget: *"I don't like
/api/roborev … that's kind of defeating the plugin nature."*

## Guidance

**Reach for an existing generic endpoint before inventing a plugin-specific one.** A plugin
widget composes server capability through `api.http.fetch` against the same general-purpose
routes any widget can use. Add a new core route only when the capability is genuinely generic
(useful to many widgets/agents), name it for the *capability*, never for the plugin, and put
it in the relevant domain module — not an `/api/<plugin>` namespace.

The generic primitives that already exist and cover most needs:

| Need | Generic endpoint | Notes |
|---|---|---|
| Host / session / canvas state | `GET /api/state` | Raw state object (`{ sessions, spaces, ... }`), not enveloped |
| Run a command in a session's worktree | `POST /api/sessions/:name/exec` `{ argv }` | Runs argv (no shell) with `cwd = session.workspace.path`; enveloped `{ ok, data: { stdout, stderr, code } }`. Same primitive session-backed widgets get as `api.primitives.useTerminal().exec()` |
| Send a message / prompt to an agent | `POST /api/sessions/:name/enter-prompt` | Types text + Enter into that session |
| Subscribe to host events | `api.events.subscribe(channel, cb)` | SSE channels |

A bundled plugin running shell per worktree, for example, just enumerates sessions from
`/api/state` and calls `/api/sessions/:name/exec` per session — zero new routes.

## Why This Matters

- **The boundary is the value.** "Frontend-only plugins" is what keeps the trust model
  coherent and lets sibling projects (whoachart, stretchplan, papershore) compose without
  forking core. Each bespoke `/api/<plugin>` route erodes that and adds a maintenance coupling
  core can never drop.
- **Generic endpoints get reused; bespoke ones rot.** `/api/sessions/:name/exec` serves any
  plugin that needs in-worktree execution. `/api/roborev/fleet` serves exactly one and becomes
  dead weight if roborev changes.
- **Composing the right primitive often dissolves adjacent problems.** Running `roborev list`
  through the per-session `exec` endpoint executes it *inside* the worktree, so roborev's
  repo+branch scoping is automatic — the "match reviews to the session's branch" sub-problem
  vanished entirely. Reaching for the bespoke route would have meant git-probing each
  worktree's branch by hand. The generic primitive carried context the bespoke one wouldn't.
- Aligns with Will's standing preference for declarative/composable design over hardcoded
  coupling (auto memory [claude]: he challenges coupling assumptions, prefers capability
  composition over N×N tables).

## When to Apply

- Before adding any route under an `/api/<plugin-name>` namespace — stop and check whether an
  existing generic endpoint (or a generically-named new one) covers it.
- When a standalone plugin widget needs per-session data or host actions.
- When a plugin needs to run a command, read state, or message an agent.

## Examples

**Before (rejected) — a bespoke route that pierces the boundary:**

```ts
// core route, coupled to one plugin
// GET /api/roborev/fleet  → runs roborev list per session, returns counts
```

**After (shipped) — the standalone widget composes generic endpoints, no new route:**

```tsx
// enumerate sessions, then run roborev IN each worktree via the generic exec endpoint
const state = await (await api.http.fetch('/api/state')).json()
const sessions = pickFleetSessions(state)            // sessions with a worktree
await Promise.all(sessions.map(async (s) => {
  const r = await api.http.fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ argv: ['roborev', 'list', '--open', '--json'] }),
  })
  const j = await r.json()                            // { ok, data: { stdout, code } }
  return fleetRow(s, j.ok && j.data.code === 0 ? parseReviewList(j.data.stdout) : null)
}))
```

**Counter-example — when a new core route IS justified:** the saloon's NATS broker light
added `GET /api/nats-traffic/status`. That's acceptable because it's named for the *capability/
domain* (nats-traffic) not a plugin, it lives in the existing nats-traffic module, and broker
reachability is a host-level fact several surfaces could read — not a one-plugin convenience.
The test is "would another widget/agent reasonably want this?" and "is it named for a domain,
not a plugin?" — not "does my plugin need it right now?"

## Related

- `docs/plugins/README.md` — "Widgets, panes, commands only — no server-side plugin code" (the design decision this convention enforces)
- `src/plugins/roborev/src/FleetView.tsx` — the standalone fleet widget that composes generic endpoints
- `POST /api/sessions/:name/exec` in `src/server/api/routes.ts` — the generic in-worktree exec primitive
