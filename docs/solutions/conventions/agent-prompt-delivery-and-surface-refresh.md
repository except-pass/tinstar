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

**1. A "refresh"/"regenerate" is a persist-nothing NUDGE that re-runs the author.**
Don't mutate stored state on refresh. Deliver a best-effort prompt to the authoring
agent and let the content regenerate through the normal author → file → projection → SSE
path — one write path, not two. Carry an optional author-supplied *recipe* ("re-run the
eval of PR #N"), falling back to a bare "regenerate surface X" nudge when absent.

**2. A client "refreshing" spinner claims a fresh version is coming — BOUND it.**
Clear it three ways: (a) a newer version landed — the projected item's `amendedAt`
advanced past the value recorded at click time; (b) a bounded timeout elapsed (mirror the
existing shimmer bound, e.g. `SHIMMER_MAX_MS`); (c) delivery failed — `delivered:false`
clears at once and shows "not reachable". An unbounded spinner lies on an agent that
ignored, dropped, or died on the request. **Caveat:** a byte-identical regeneration does
NOT advance `amendedAt` (the store's zero-change short-circuit suppresses the emit), so
the timeout is the honest backstop for "regenerated, unchanged".

**3. Serialize fan-out delivery to one session.**
`tmuxBackend.sendPrompt` is `send-keys(text)` → `sleep` → `send-keys(Enter)`, and it is
NOT serialized. Firing N concurrent `sendPrompt`s at the SAME session interleaves
keystrokes into one pane and garbles the agent's input. A "refresh all" / bulk fan-out
must `await` each delivery before the next. And clear the bulk-loading flag in a
`.finally()` when the dispatch loop ends — NOT on a transient "nothing in flight", because
a dead run clears its first surface immediately and would flip the bulk flag off mid-loop.

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

## When to Apply

Any control that delivers a prompt to a managed agent session; a refresh/regenerate
affordance on agent-authored content; any fan-out that targets one session; any place a
file- or user-authored string is interpolated into a delivered prompt.

## Examples

```ts
// Fan-out: serialize, and clear the bulk flag when dispatch ENDS (not mid-loop).
const refreshAll = (visible) => {
  if (!visible.length) return
  setBulk(true)
  void (async () => { for (const s of visible) await refresh(s) })()
    .finally(() => setBulk(false))   // NOT: an effect on refreshing.size===0
}

// Bounded spinner: clear on newer amendedAt OR timeout OR delivered:false.
mark(id, surface.amendedAt)                       // baseline at click
timers.set(id, setTimeout(() => clear(id), MAX))  // the bound
// …later, in the projection effect: if (s.amendedAt > baseline) clear(id)
// …in the POST result: if (delivered === false) { note(id); clear(id) }

// Delivery: guardrail every prompt; oneLine() untrusted single-value fields.
return [recipe ?? `Regenerate surface "${oneLine(headline)}".`, '', GUARDRAIL].join('\n')
```

Related: `conventions/widget-to-agent-answer-back.md` (the persist-THEN-deliver answer-back
direction — this doc is its persist-NOTHING refresh counterpart; consider consolidating
into one "agent prompt delivery" note if a third case appears).
