---
date: 2026-07-02
topic: background-sessions
---

# Background sessions — hidden-by-default agents that wait for commands

## Summary

A `background` property on managed sessions, set at creation via the API, that keeps a session fully alive and commandable (NATS subscriptions, prompt endpoint) while keeping it off the canvas, the hierarchy, and the inbox. A "show background" toggle in the hierarchy reveals them on demand, and the property can be flipped to promote one to a normal visible session.

---

## Problem Frame

Some agents are machinery, not collaborators. The motivating case: whoachart spawns an agent when a run starts, streams it transition hooks as marbles change state, and the agent exits itself when the run is done (no live marbles, at least one exited). That agent never needs a card on the canvas, a row in the hierarchy, or an inbox entry — it needs to exist, listen, and act. Today every managed session renders everywhere, so running this pattern means paying canvas clutter for agents nobody is looking at, or not running it at all.

The existing hidden-runs eyeball doesn't cover this: it is a per-browser localStorage preference applied after the fact, so a programmatically created session cannot be born hidden, and other viewers still see it.

---

## Key Decisions

- **Server-side property, not a view preference.** Born-hidden must hold for every viewer and every tab from the moment of creation, which only a property on the session record can guarantee. The existing client-side eyeball-hide stays as-is for ad-hoc decluttering of normal sessions.
- **Background is orthogonal to placement.** A background session still lives in a task/space like any other, so the NATS subject scheme, task-scoped settings inheritance, and telemetry all work unchanged. Hidden means not rendered, not homeless.
- **Attention breaks through.** A background session that hits a permission prompt, error, or dead harness surfaces in the inbox until handled. Invisible machinery must not wedge silently for days.
- **Exit logic belongs to the agent.** Tinstar adds no exit-condition machinery; the whoachart agent decides for itself when its condition is met and ends its own session.
- **The property is mutable.** Promote a background session to visible to debug it; demote a noisy watcher to background. One boolean flip, cheap to support.

---

## Actors

- A1. **An external system (whoachart)** — creates the background session via the API at run start and delivers transition hooks over NATS or the prompt endpoint.
- A2. **The background agent** — idles invisibly, acts on each hook, and exits itself when its condition is met.
- A3. **The user** — normally never sees it; occasionally reveals background sessions to inspect one, or handles a break-through attention item.

---

## Requirements

**Creation and the property**

- R1. A session can be created as a background session via the session-creation API, and the property is part of the session record carried to the frontend in state payloads.
- R2. A background session is a managed session in every other respect: same lifecycle, workspace handling, NATS auto-subscriptions, prompt endpoint, status watching, and telemetry.
- R3. The property is mutable after creation, in both directions (promote to visible, demote to background).

**Default invisibility**

- R4. A background session does not render on the canvas by default.
- R5. A background session does not appear in the hierarchy sidebar by default.
- R6. A background session produces no inbox rows by default, including the passive listed-for-visibility rows.
- R7. Session cycling and other affordances that enumerate visible sessions skip background sessions.

**Reveal affordance**

- R8. A "show background" toggle in the hierarchy reveals background sessions in the hierarchy and on the canvas, visually marked as background.
- R9. The toggle shows a count of live background sessions even when off, so their existence stays discoverable.
- R10. The toggle is a per-user view preference and does not change any session's background property.

**Attention and lifecycle**

- R11. A background session in a needs-attention state (permission prompt, error, harness death) surfaces in the inbox until handled, despite R6.
- R12. Stop and delete behave exactly as for visible sessions, including the Graveyard tombstone on delete.

---

## Key Flows

- F1. **Whoachart run**
  - **Trigger:** whoachart starts a run.
  - **Steps:** whoachart creates a background session via the API; the agent idles; whoachart sends a hook on each marble transition; the agent acts on each; when no marbles are live and at least one has exited, the agent ends its own session.
  - **Outcome:** the whole run happens without the session ever appearing on canvas, hierarchy, or inbox. **Covers R1, R2, R4–R6, R12.**
- F2. **Reveal and inspect**
  - **Trigger:** user turns on the "show background" toggle.
  - **Steps:** background sessions appear marked in the hierarchy and as cards on the canvas; the user opens one's terminal, optionally promotes it to visible.
  - **Outcome:** full inspection and control of any background session on demand. **Covers R3, R8–R10.**
- F3. **Stuck background agent**
  - **Trigger:** a background agent hits a permission prompt.
  - **Steps:** an inbox row appears for the session; the user handles the prompt; the row clears.
  - **Outcome:** the session returns to invisibility without the user touching the reveal toggle. **Covers R11.**

---

## Acceptance Examples

- AE1. **Covers R4–R6.** Given a session created with the background property, when the dashboard loads in any browser, then the session appears on no surface, while `tmux` and the session API both show it running.
- AE2. **Covers R11.** Given a background session waiting on a permission prompt, when the inbox renders, then a row for that session appears and remains until the prompt is answered.
- AE3. **Covers R7.** Given one visible session and one background session, when the user cycles sessions, then focus never lands on the background session.

---

## Scope Boundaries

- Whoachart-side changes (hook delivery, exit-condition logic) are whoachart's own work; this feature only needs the flag plus existing NATS/prompt input paths.
- No worker pooling, auto-spawning, or scaling of background agents.
- No separate background-manager panel; the hierarchy toggle is the whole reveal surface.
- The existing client-side hidden-runs eyeball is untouched and not replaced.

---

## Outstanding Questions

**Deferred to planning**

- Exact placement and look of the reveal toggle and the background marking on revealed cards.
- Whether the interactive spawn UI also exposes the background option, or creation stays API-only in v1.

---

## Sources

- `src/hooks/useHiddenRuns.ts` — the client-side hide precedent this deliberately does not extend, and the model for hierarchy dimming.
- `src/hooks/useInbox.ts` — inbox rows include passive listed-for-visibility sessions, which R6 must exclude.
- `src/server/sessions/session.ts` — the session record and creation options the property joins.
- `docs/brainstorms/2026-07-01-session-graveyard-necro-requirements.md` — adjacent work covering dead sessions; this covers live-but-invisible ones.
