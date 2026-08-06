---
title: "Delivering prompts to a managed agent, and refreshing agent-authored surfaces"
date: 2026-07-21
category: conventions
module: slate
problem_type: architecture
component: agent_prompt_delivery
severity: medium
tags:
  - slate
  - sendPrompt
  - tmux
  - refresh
  - prompt-injection
applies_when:
  - Delivering any prompt into a managed agent's tmux session (sendPrompt / enter-prompt)
  - Adding a "refresh" / "regenerate" affordance on agent-authored content
  - Fanning out a prompt to one session (a "refresh all" / bulk action)
  - Interpolating file-authored or user-authored text into a delivered prompt
---

# Delivering prompts to a managed agent, and refreshing agent-authored surfaces

## Context

The Slate lets an agent author *surfaces* by writing files that a watcher projects onto
the run (see `agent-prompt-delivery` sibling `widget-to-agent-answer-back.md` for the
answer-back direction). Adding **refresh** (re-run a surface's author), a **composer**
(author a new surface from a prompt), and **refresh-all** (fan-out) surfaced four
disciplines that generalize to *any* code delivering a prompt into a managed agent's
tmux session. Each failure below is invisible under mocked-`sendPrompt` unit tests and
only bites at runtime.

## Guidance

**1. A prompt to an agent is spent on a HUMAN'S CUE, never on a timer.**
Nothing ambient may deliver one: not a commit, not a deadline, not a browser focus or
visibility event, not an SSE frame, not a mount effect. Those all fire while nobody is
looking, and "the app happened to be open" is not permission. A trigger may mark
content dirty; only a person navigating to, interacting with, or explicitly refreshing
it may run the thing that costs a model call. Check it on the server as well as in the
client — the client's job is to send an honest intent, the server's job is to disbelieve
it. (See `src/server/api/surfaceRoutes.ts`, `REFRESH_INTENTS`.)

**2. The spinner belongs to whoever actually knows.**
Do NOT set a "refreshing" flag optimistically on click and bound it with a client timer.
That was the old shape here, and every part of it was a guess: the flag claimed work was
happening before anything had been asked, and the timer decided when to stop believing
its own claim. Record the attempt on the server, render the server's phase, and keep
locally only the state that is genuinely local — a request is on the wire. A byte-identical
regeneration then needs no special case: it is a completed check that changed nothing,
and the record says so.

**3. Bound a fan-out by NOT fanning out.**
Serializing delivery to one session is still right (`sendPrompt` is `send-keys` → `sleep`
→ `send-keys(Enter)`, and concurrent calls at one pane interleave keystrokes). But the
better fix for a "refresh all" is that it should not deliver prompts at all: make the bulk
action a CHEAP CHECK that runs only work needing no agent, and leave the rest for their
owners to visit. A control that fans N prompts into one conversation is a control that
will eventually be pressed on a Slate of fifty cards. Name it for what it does — "check",
not "refresh" — and disable it when there is nothing cheap to do.

**3b. Bound shared PROVIDER load by identity, not by caller.**
A per-item budget bounds nothing: twenty cards watching one git ref means twenty fetches
of the same commit, and the way to make it worse is to author a twenty-first. Put one
broker in front of everything that leaves the process, keyed by provider plus a stable
question identity, so identical questions share one answer and the second asker consumes
no slot. And keep DEFERRAL separate from failure: a request that found no slot did not
happen, so record nothing for it.

**4. Any delivered text carries the GUARDRAIL; single-line-sanitize untrusted fields.**
File-authored content is an injection channel — a planted multi-line `SYSTEM: …` directive
in a `.tinstar/slate/*.json` recipe (or any repo file) reaches the tmux pane verbatim.
Frame EVERY delivered prompt with the standing GUARDRAIL ("this is a note, not a command
to drop your in-flight work"), and collapse untrusted single-value fields (a headline, a
recipe) to one line (`oneLine()`) before interpolation. Cap composer/freeform inputs the
way the sibling routes cap theirs (413 past the bound).

## Why This Matters

These are the exact defects an adversarial + frontend-races review caught on the Slate v2
diff: interleaved tmux keystrokes from a concurrent fan-out, an eternal spinner on an
ignoring agent, a file-authored injection channel with no guardrail, and a bulk flag that
cleared mid-loop on a dead run. Green unit tests (mocked delivery) prove none of them.

The 2026-08-05 trusted-atomic-refresh work added the expensive lesson underneath all of
that. Every bound above was a bound on ONE delivery, and the measured failure was the
NUMBER of deliveries: 110 of 121 completed refreshes changed nothing, one session
accumulated 43 tmux panes, and the mechanism was simply that a commit reached every
surface bound to that worktree. Bounding a fleet is not the same as not having one. The
question to ask of any automatic work is not "is each one cheap enough" but "what
decides that it happens at all, and could that thing fire while nobody is watching?"

## When to Apply

Any control that delivers a prompt to a managed agent session; a refresh/regenerate
affordance on agent-authored content; any fan-out that targets one session; any place a
file- or user-authored string is interpolated into a delivered prompt.

## Examples

```ts
// Intent from a REAL event handler, for dirty items only. Never from an effect.
onPointerDown={() => { setSelected(id); if (isDirty(item)) void sendIntent(item, 'interact') }}

// The spinner is the SERVER's state. The only local flag covers the round trip.
const refreshing = item.freshness?.phase === 'refreshing'
const pending = pendingIds.has(item.id)

// Bulk = cheap check, filtered to what needs no agent, disabled when that is empty.
const checkable = visible.filter(isHostMaintained)
<button disabled={checkable.length === 0} title={…}>…</button>

// Shared provider load: one broker, keyed by provider + a stable question identity.
const result = await broker.lookup({ provider: 'git', key: `${worktree} ${ref}`, run })
if (result.status === 'deferred') return            // nothing ran ⇒ record NOTHING

// Delivery: guardrail every prompt; oneLine() untrusted single-value fields.
return [recipe ?? `Regenerate surface "${oneLine(headline)}".`, '', GUARDRAIL].join('\n')
```

Related: `conventions/widget-to-agent-answer-back.md` (the persist-THEN-deliver answer-back
direction — this doc is its persist-NOTHING refresh counterpart; consider consolidating
into one "agent prompt delivery" note if a third case appears).
