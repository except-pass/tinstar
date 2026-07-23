---
title: "Authoring a skill progress tracker on the Slate"
date: 2026-07-22
category: conventions
module: slate
problem_type: convention
component: slate_surface_authoring
severity: medium
tags:
  - slate
  - a2ui
  - stepper
  - surface-authoring
  - progress
  - agent-skills
applies_when:
  - A skill runs in phases and wants the user to see how far along it is
  - Showing pipeline / checklist / phase progress on a run's Slate
  - Choosing between a Stepper surface and a Text/List checklist
  - Deciding whether a progress surface should carry a `refresh` recipe
---

# Authoring a skill progress tracker on the Slate

## Context

A multi-phase skill (the compound-engineering pipeline: **brainstorm → plan → work → review → compound**) is opaque while it runs. The user sees a busy terminal and has to read scrollback to answer one question: *how far along is this?*

The Slate already carries everything needed to answer it. A skill writes `<run-workdir>/.tinstar/slate/<slug>.json`, the watcher validates and projects it onto `run.slate`, and the client renders the file-owned A2UI body in a standalone card. **No new plumbing** — no surface `kind`, no server change, no schema change.

What was missing was the ability to say *which* phase is which. A2UI's contract is "JSON carries structure, never color" (`docs/slate-design-language.md`), and `Text` has no status prop — so an authored `Column` of `Text` rows is unavoidably **monochrome**. It can only distinguish phases by glyph (`✓ ▸ ○`), throwing away the design system's whole status vocabulary. The `Stepper` primitive (Slate S3) closes that gap: it is the one A2UI component that colors a row by state.

This page is the convention any skill copies to get a live progress tracker.

## Guidance

### The file

One object, written to `<run-workdir>/.tinstar/slate/<slug>.json`, rewritten in place on every phase transition. The canonical copy-me version lives at **[`docs/examples/slate/skill-progress-tracker.json`](../../examples/slate/skill-progress-tracker.json)**. A test drives it through the three real gates in pipeline order — the watcher's own `toPointInput` envelope validator, then `parseA2uiContent`, then `A2uiRenderer` — calling each one rather than restating its rules, so the example can't rot into something that silently never appears:

```json
{
  "id": "ce-pipeline",
  "headline": "Compound Engineering",
  "author": "agent",
  "anchor": { "kind": "surface" },
  "content": {
    "root": "root",
    "components": [
      { "id": "root", "component": "Stepper", "steps": [
        { "label": "Brainstorm", "status": "done" },
        { "label": "Plan",       "status": "done" },
        { "label": "Work",       "status": "active", "detail": "implementing unit 2/4" },
        { "label": "Review",     "status": "pending" },
        { "label": "Compound",   "status": "pending" }
      ] }
    ]
  }
}
```

The full field table for the envelope lives in the [surface authoring contract](../documentation-gaps/slate-surface-authoring-contract.md); only the tracker-specific rules are repeated here.

### The `Stepper` component

| Prop | Type | Notes |
|------|------|-------|
| `steps` | `Array<{ label, status, detail? }>` | The rows, top to bottom. Capped at **60**; beyond that the rail draws a `+N more not shown` marker. A tracker that long has stopped being readable anyway. |
| `steps[].label` | string (non-empty) | The phase name. Short — it renders as a mono label, not prose. A row with no label is **dropped**. |
| `steps[].status` | `'pending' \| 'active' \| 'done' \| 'skipped'` | Anything else (or absent) coerces to `pending`. |
| `steps[].detail` | string, optional | A one-line caption under the label. Put running commentary here, on the **active** step only. |

`Stepper` is a **leaf** — no `children`/`child`. It composes anywhere a component id can go, so a tracker can be the whole body (as above) or one child of a `Column` alongside an intro `Text`.

**The status vocabulary** (deliberately *not* `PointStatus` — a progress phase is not a point lifecycle):

| status | reads as | color |
|---|---|---|
| `done` | finished | emerald (`hue.resolved`), with a `✓` |
| `active` | **the live edge** | cyan (`primary`) + the live glow. This is the one legitimate cyan use — P4 reserves cyan for liveness, and the active phase *is* the live edge |
| `pending` | not started | faint rail dot, low ink |
| `skipped` | deliberately not run | slate (`hue.dismissed`), dimmed + struck through |

Keep **exactly one** step `active`. Two live edges is a contradiction, and the rail stops reading at a glance.

### The four rules

1. **Stable `id`, reused on every write.** The store merges by id, so rewriting `ce-pipeline` *amends* the existing panel — preserving its thread and freshness stamp. A fresh id per phase spawns five duplicate panels.
2. **`author: "agent"`.** Matches the authoring-contract examples and keeps the surface off the self-prompting loop. `'process'` is defensible — its stall sweep would mark a tracker whose skill died mid-run as stalled — but the surface's own freshness stamp already ambers past 15 minutes when untended, so `'agent'` is the simpler default. Choose deliberately if you want the stall sweep.
3. **No `refresh` recipe.** A progress tracker is **session-derived**: it fails the authoring contract's [vacuum test](../documentation-gaps/slate-surface-authoring-contract.md). A refresh spawns a fresh, context-free one-shot author in the workdir; that author cannot possibly know how far *your* skill has got. Owning the rewrite is the skill's job. Giving it a recipe it can't honor produces a confidently wrong tracker.
4. **One write per phase transition.** Rewrite the *whole* file with the updated statuses — flip the finished step to `done`, the next to `active`, and clear or replace the old `detail`. The watcher (inotify plus a ~3s poll backstop) reprojects well under the poll cadence, so the panel updates within seconds. Write the terminal state too: when the skill finishes, the last step should end `done`, not stranded `active`.

### Wiring it into a skill

Only three edits to a phased skill:

- **At start** — write the file with every step `pending` except the first, which is `active`.
- **At each transition** — rewrite with the completed step `done` and the next `active`. A phase the run deliberately skipped goes `skipped`, not `done`.
- **At the end** — rewrite with the final step `done`, and drop the `detail`.

The CE pipeline is the first rider, but nothing here is CE-specific: a release checklist, a migration runbook, or a long test matrix all fit the same shape.

## Why This Matters

**Every gate in this pipeline fails silently.** An invalid `content` is dropped by the watcher and the panel simply never appears — no error anywhere. So the failure mode of a hand-rolled tracker is "the user sees nothing and nobody finds out". Copying the validated example and keeping the four rules is what avoids that.

**A stale tracker is worse than none.** The panel is a claim about the present. A skill that writes the tracker at start and never updates it asserts "we're still on Brainstorm" for the rest of the run, and the user trusts it. If your skill can't reliably rewrite on every transition, don't ship the tracker.

**The `Stepper` degrades, it doesn't crash.** A2UI props are passthrough (`unknown`), so `steps` gets a total, never-throwing parse: non-object rows and label-less rows are dropped, unknown statuses coerce to `pending`, and a `steps` that is missing, not an array, or entirely unusable renders one small inline amber marker with the rest of the surface intact. It is also **bounded** — one `Stepper` node is the only catalog prop that expands into an unbounded number of DOM rows, and the renderer's node budget can't see inside a leaf's props, so the parse stops at 60 rows and says how many it cut. You will not blank or hang a card by getting the JSON slightly wrong — but you may silently lose rows, so validate against the example.

## Related

- [`docs/solutions/documentation-gaps/slate-surface-authoring-contract.md`](../documentation-gaps/slate-surface-authoring-contract.md) — the full file + A2UI contract this convention specializes, including the vacuum test and the component vocabulary table.
- [`docs/slate-design-language.md`](../../slate-design-language.md) — where the status hues and the "cyan means live" rule come from.
- [`docs/examples/slate/skill-progress-tracker.json`](../../examples/slate/skill-progress-tracker.json) — the committed reference example, guarded by `src/a2ui/__tests__/progressTrackerExample.test.ts`.
- [`docs/solutions/conventions/agent-prompt-delivery-and-surface-refresh.md`](./agent-prompt-delivery-and-surface-refresh.md) — the refresh machinery this convention deliberately opts out of.
