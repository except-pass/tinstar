---
title: "Answer-back from a widget to an agent: reuse the notes/pins prompt-delivery pattern"
date: 2026-07-17
category: conventions
module: roundup
problem_type: architecture
component: agent_answer_back
severity: medium
applies_when:
  - Building a widget where the user answers/replies and the answer must reach a specific agent session
  - Adding an interactive control surface that submits back to an agent
  - Wiring any two-way user↔agent channel off a canvas widget
---

# Answer-back from a widget to an agent

Landed while building the Roundup's interactivity slice (the user answers a needs-you notice; the answer must reach the posting agent). Tinstar already had the right pattern; the trap was almost inventing a worse one.

## Reuse the notes/pins prompt-delivery pattern — don't invent a channel

When a widget needs to send a user's answer/reply to a *specific* agent session, follow how notes/pins already do it (`src/pins/replyPrompt.ts`, `POST /api/notes/:id/replies`):

1. **Persist the answer on the entity first**, unconditionally, on valid input. This is durable and independent of whether the agent is reachable, and — because the docstore mutator's equality compare now sees a changed field — it broadcasts the `*.updated` delta that refreshes the widget live for free.
2. **Then deliver best-effort** to the posting session as a prompt (`tmuxBackend.sendPrompt` / the `enter-prompt` path). The entity carries the session identity (for a notice, `runId` is the run id, which *is* the session name — target that). If the session isn't reachable/prompt-ready, the answer is already persisted; return `{ delivered: false }` rather than failing the whole submit.

Rejected alternatives: **NATS reply** (only reaches NATS-enabled sessions; prompt-delivery is the universal channel), and a **bare unpersisted `/prompt`** (loses the durable record the widget needs to show "answered"). Persist-then-deliver-best-effort is the shape.

Optimistic UI (client): flip to "answered" on submit before the server responds, and revert cleanly on failure — the persisted answer arrives back via the delta and keeps the state.

## Two review traps specific to agent-authored interactive controls

Both caught by roborev, not the build — interactive agent-authored UI is a review surface.

- **Don't overload a status field with a second meaning.** The notice's `amendedAt` means "the *agent* edited this" everywhere (footer, PATCH path, skill wording). Bumping it when the *user* answers made the board falsely report an agent edit. Give the user-action its own field (`answeredAt`); don't reuse the agent-edit timestamp. The honesty of the surface depends on each field meaning one thing.
- **Per-instance form state, not one shared bag.** A single shared selection `Set` across every control group silently clobbers when an agent declares two groups (a single-select in one wipes the other). Key form state per control-component id so instances are independent; flatten on submit and let the server validate each id against the declared set.

## Related

- `docs/solutions/tooling-decisions/adopting-a2ui-for-agent-authored-ui.md` — the controls are A2UI *schema* component types rendered by the host custom walker; the web_core action runtime stays deferred (a form doesn't need a streaming data-model runtime).
- `docs/solutions/conventions/adding-a-docstore-entity-and-plugin-widget.md` — the deploy trap and two-place plugin registration still apply.
- `docs/features/2026-06-13-note-replies-design.md` — the original notes/pins reply design this pattern generalizes.
