# Fan-out surfaces & the addressable point — requirements / design

> **SUPERSEDED (2026-07-21)** — merged with
> `docs/brainstorms/2026-07-21-a2ui-run-workspace-requirements.md` into the single
> origin doc **`docs/brainstorms/2026-07-21-the-slate-requirements.md`**. Plan from
> that. Kept for history only.

**Date:** 2026-07-21
**Status:** superseded — see the-slate-requirements.md
**Prototype:** the interactive strawman published this session (session `a2ui`) — the
"pane of glass" showing this conversation's own content laid onto eight surfaces.

---

## 1. The problem

Today an agent talks to the user through a single linear transcript — white text on a
black screen. The transcript is the source of truth (the full record of thinking and
work), but a scroll is a poor *interface* to that truth:

- The user runs several threads with one agent at once, but a scroll forces serial
  reading and a single input point.
- To talk about one facet (a decision, an open question, a diagram), the user must
  first re-describe it in words before they can point at it.
- Everything an agent "decides it's done with" (open questions it resolved by
  assumption, follow-up work, calls it made) evaporates into the scroll instead of
  staying visible. (Origin: CMT-1302 — an agent believed it was done while the ticket
  still held an unresolved human decision. It should have left a `needs-you`.)

**The dream:** the agent renders the interactive UI that best fits the circumstance, and
the same underlying transcript is **fanned out** into small, clearly-scoped, two-way
surfaces the user can touch directly — while the agent keeps working on other things.

## 2. The core idea: one primitive — the *addressable threaded point*

Every surface we sketched decomposes to the same object. Do not build them as parallel
special cases; build **one primitive** and render it in different frames.

An **addressable point** is:

- **authored** by the agent, the user, **or any local process** (author-agnostic — this
  unifies agent-authored notices, user-authored pins/comments, and a shell script that
  reports its own progress — see §4a);
- **anchored** to something, optionally: nothing (a standalone open point), a decision,
  or a whole surface/widget (a per-surface discussion);
- **threaded** — an append-only discussion of `Reply { author, text, createdAt }`
  (the exact type already shared by `domain/pinSet.ts` and the Roundup follow-ups);
- **lifecycled** — open → discussing → waiting → resolved, plus dismissed; soft (the
  thread stays readable), never a hard delete;
- **live** — created/amended/resolved events fan out over the existing SSE delta bus.

This is the strongest form of **Converge**: a Roundup notice, a canvas pin, an FYI
comment, and a per-surface thread are all this one object with a different `anchor` and
a different default author. The per-surface threads in the prototype are the proof — a
"discuss this widget" thread *is* an addressable point anchored to a surface.

## 3. Rendering: A2UI — closed vocabulary, open composition

Surfaces are described in **A2UI** (the `@a2ui/web_core` v0_9 schema already adopted for
Roundup notices) and drawn by a host-owned, host-themed renderer. We adopt the **schema,
not the runtime** (already the standing decision — see
`docs/plans/2026-07-17-002-feat-roundup-a2ui-rendering-plan.md`, KTD1).

Mental model: **tool use for UI.** The catalog of component types is a tool schema; an
A2UI content tree is a batch of tool calls; the host executes them by rendering. The
agent cannot invent a brick, but composes known bricks into any tree. **Growing the
catalog grows the kinds of fan-out surface the agent can produce.**

Design principle surfaced by the prototype: **"go straight to the thing" only works when
the thing has a shape.** Every primitive should have a *visual* form, not just a text
form — a state track, a fan schematic, a dataflow graph — so the user points instead of
reading.

## 4. Scope — the two hero surfaces (everything else is secondary)

The user was explicit: two things carry this feature.

1. **The open-points list** (`‹threaded-checklist›`) — the addressable point in its
   standalone frame. A list of points, each with: status pill, author, a visual
   **state track**, an expandable **thread**, resolve (soft), and *add your own point*.
   Agent-authored and user-authored points live in the same list.

2. **Diagram surfaces with per-surface threads** — agent-authored A2UI surfaces that
   render as *pictures* (dataflow graph, concept map, composition tree, before/after),
   each carrying its own scoped discussion thread at the bottom. "Talk about just this
   widget while I hold the whole conversation."

Secondary (do **not** gold-plate): decisions log, idea shelf, graveyard, prototype
previews. They fall out of the same primitive for free but are not the point.

## 4a. Process-authored surfaces (the long-running-command pattern)

The store is reachable over plain local HTTP (`POST/PATCH/DELETE /api/notices`,
`POST …/:id/replies`) with **no auth gate** — the handler only takes a `sessionId` in
the body (`server/api/routes.ts:2029`). So **any local process can author and drive a
surface**, not just the agent or the user. This makes long-running work hands-off:

- **start** — the process `POST`s a progress surface ("running…").
- **during** — it `PATCH`es the surface to advance it (step N/M, elapsed, last log line,
  a progress brick). Each amend fans out over the `notice.updated` SSE delta, so the
  widget updates live.
- **exit** — it `PATCH`es the surface to the terminal state (✓/✗ + result) **and**
  `POST`s a reply to deliver a completion prompt to the agent's session.

Everyone is notified from **one surface**: the user by glancing at the card, the agent by
the delivery on exit. Motivating gap (session `vppOps`): the agent posted a milestone FYI
*after* a deploy step, but nothing lived on the board *during* the run — so the user had
to ask for status. "Out of the brain onto the pane" generalizes to **out of the process
onto the pane**.

**Deliverable:** a thin wrapper (`tinstar-run <cmd>` / a shell function) that emits the
start/amend/exit boilerplate so any command becomes self-reporting. The agent uses it
instead of a bare long-running call; humans can use it directly too.

**Non-goal (this pass):** no auth/identity model on the endpoint (it stays local-trust);
no generic job scheduler — just the wrapper + the surface it drives.

---

## 5. Architecture decision: **A — presentation bricks over a durable store**

Chosen over B (adopt A2UI's stateful runtime) and litigated against reusing the Pin
element.

- The durable objects (points, threads, lifecycle, anchors) live in a **docstore
  collection**, extending the shipped **notices** substrate — which already is exactly
  "durable, threaded, resolvable object + A2UI view + host-wired interactions + SSE".
- Bricks are **stateless views** that bind by id to those stored objects. Interactions
  (resolve, reply, add, choose) hit **host endpoints** that mutate the store; the delta
  re-renders.
- **Do not reuse the `Pin` type.** A pin's identity is geometric (`nx/ny/nodeId`,
  enforced by `isPinSet`) and space-scoped; a point is anchor-optional and
  session-scoped. Reuse the pin's *plumbing pattern* (unsent→submit, threads, soft
  resolve, merge-preserving replies), not its element.

**Tradeoff (why A):** gains reuse of shipped notices plumbing (store, SSE, endpoints,
safe-degrade) and keeps each brick simple and themed; costs a bespoke host endpoint +
wiring per interactive brick, so the menu grows in host effort per brick. **Wrong if**
the interactive-brick count explodes and hand-wiring becomes the bottleneck — then
revisit B.

**A is now the only option (not just the safer one).** Process-authored surfaces (§4a)
require a store reachable over plain HTTP — a shell script can `curl` an endpoint but
cannot drive A2UI's in-browser stateful runtime. Choosing B would lock surface-authoring
inside the browser, making the long-running-command pattern impossible.

## 6. Delivery model — immediate injection + guardrail (resolved)

When the user posts a scoped comment / adds a point while the agent works elsewhere:

- **Deliver immediately** by injecting into the agent's session — reuse the existing
  notice-reply → prompt delivery path. No separate queue store, no next-surface polling.
- **Guardrail instruction** (ships in the agent-facing skill/prompt): *an injected
  scoped comment is a note, not a command to drop in-flight work. If mid-turn, finish or
  checkpoint the current action first, then address it. Never let it replace your work.*

**Tradeoff:** gains radical simplicity and leans on the agent's robustness to midstream
context; costs the risk of derailing an in-flight multi-step action, which the guardrail
neutralizes. **Wrong if** work is still lost with the guardrail in place → add a
lightweight "busy, hold until end of turn" gate.

## 7. Data model (sketch — refine in planning)

Extend the notice/point stored object (docstore), roughly:

```
Point {
  id, sessionId/runId,
  author: 'agent' | 'user',
  anchor?: { kind: 'none' | 'decision' | 'surface', ref?: string },
  kind: 'needs-you' | 'fyi' | 'open-point',
  headline: string,
  content?: A2uiContent,          // optional A2UI body / view
  status: 'open'|'discussing'|'waiting'|'resolved'|'dismissed',   // derived where possible
  replies?: Reply[],              // append-only thread (shared Reply type)
  createdAt, amendedAt, resolvedAt?, dismissedAt?
}
```

Reuse: `Reply` (`domain/pinSet.ts`), `A2uiContent` + renderer
(`plugins/roundup/src/a2ui/`), notices routes (`server/api/routes.ts`), docstore
(`server/stores/document-store.ts`), the `notice.updated` SSE delta.

## 8. Two-way endpoints (reuse/extend the notices API)

- `POST /api/points` (or extend `/api/notices`) — create (agent or user).
- `PATCH /api/points/:id` — amend headline/content/status.
- `POST /api/points/:id/replies` — append a thread message (already exists for notices).
- `POST /api/points/:id/resolve` / `DELETE` — soft resolve / reopen.
- All mutations emit an SSE delta; widgets re-read. `merge-preserving-replies` semantics
  apply so client whole-doc writes never clobber server-appended replies.

## 9. Non-goals (YAGNI)

- No A2UI stateful runtime (data-binding/action engine) — option B, deferred.
- No hard delete, no status enum workflow beyond the soft lifecycle above.
- No new pin geometry; no changes to canvas pins.
- Not building the secondary surfaces to production polish this pass.

## 10. Risks

- **Menu sprawl** — each interactive brick is bespoke host work (the cost of A). Mitigate
  by shipping the two hero surfaces first and adding bricks on demand.
- **Injection derail** — mitigated by the guardrail; watched, not pre-solved.
- **Volatile A2UI dep** — already pinned exactly (KTD3); do not float it.
- **Staleness kills trust** — a board of stale points is worse than none. The soft
  lifecycle + auto-recede (existing `age.ts`) + "pull when resolved" discipline apply.

## 11. Acceptance criteria / proof gates

- A **point** can be created by the agent *and* by the user, threaded by both, and
  soft-resolved, with all four mutations fanning out live over SSE (unit + one runtime
  smoke).
- The **open-points list** renders points with a visual state track and per-point
  thread; user can add a point and resolve one; both round-trip to the store.
- A **diagram surface** renders A2UI as a picture and carries a per-surface thread; a
  user comment on it is delivered to the session immediately, and the guardrail
  instruction is present in the agent skill.
- A **long-running command wrapped by `tinstar-run`** posts a live progress surface,
  amends it as it runs (visible live in the widget), and on exit both finalizes the
  surface and delivers a completion prompt to the agent's session — with no agent turn
  spent babysitting it (§4a).
- `npm run build:all` bundles the widget(s); type-check + vitest green; malformed A2UI
  still degrades per the existing R16 path.

## 12. Open questions for planning

- Extend `/api/notices` in place vs a new `/api/points` collection (back-compat: notices
  have real users now — unlike the pre-A2UI slice).
- How `status` is derived vs stored (last-author + lifecycle) to avoid a state machine.
- Whether the two hero surfaces are one widget or two palette tiles.
