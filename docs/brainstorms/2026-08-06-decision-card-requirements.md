---
date: 2026-08-06
topic: decision-card
---

# The Decision card

## Summary

A new A2UI primitive, `Decision`, that presents one open decision on a run's Slate with its
tradeoffs, its risks, its cost to undo, and — the dimension nobody scores — how long the decision
keeps mattering. It is a control component: the user picks an option and leaves a comment, and the
existing Slate answer flow delivers that to the run's agent unchanged.

---

## Problem Frame

An agent that needs a real decision from the user has two bad options today. It can write the
decision into the transcript, where it is buried under tool output within a minute. Or it can
author a Slate point with a `Choice` and a `Submit`, which puts the question on the card but throws
away everything that makes the question hard — what each path costs, what could go wrong, whether
the call can be walked back.

The result is that the card shows a question and the reasoning lives somewhere the user has to go
find. So either the user answers thin, or they go read the scroll anyway and the Slate has bought
nothing.

Prose can carry the reasoning, but prose does not survive the 260px Slate column and does not
survive being written by ten different agents. Each card comes out shaped differently, dimensions
get quietly dropped when the agent is in a hurry, and nothing can be compared across runs.

### The FMEA complaint

The standard tool for this is FMEA (Failure Mode and Effects Analysis), and it has two defects this
design exists to correct.

**Mixed polarity.** FMEA scores Severity, Occurrence, and Detection. Severity and Occurrence run
bad-upward. Detection reads as a virtue — but a high detection *rating* means the failure is hard to
detect, so the number runs bad-upward while the word runs good-upward. The reader has to remember
which is which for every cell, and the whole point of a scored table is that you should not have to
read it to see where the danger is.

**The composite score.** FMEA multiplies the three into an RPN (Risk Priority Number). These are
ordinal scales — the distance from 2 to 3 is not the distance from 8 to 9, and multiplying them
produces a number with no meaning that nonetheless gets sorted, thresholded, and reported. Two
completely different risk profiles collide on the same RPN.

This card fixes the first by defining every scale to run toward the danger, and fixes the second by
computing no composite at all.

---

## Requirements

### R1 — `Decision` is a control component, not a display block

The decision's options carry both the pick and the tradeoff, in one declaration.

The answer endpoint validates a submitted choice against `collectChoiceOptionIds(content)`, which
today scans only `Choice` nodes (`src/a2ui/controls.ts:80`). A read-only Decision block sitting next
to a separate `Choice` would force the author to declare every option twice — once for its label,
once for its tradeoff text — and the two would drift. So `Decision` joins `CONTROL_COMPONENTS` and
its options feed `collectChoiceOptionIds`, `collectChoiceOptionLabels`, and `isAnswerable`.

`controls.ts` is imported by the server bundle for server-side answer validation, so the parse half
(`parseDecision`) must stay React-free and live there; the render half lives in `catalog.tsx`. This
is the split `Choice` already uses.

Selection is single-mode always — you take one path. The Decision node's own `id` keys its selection
through `selectedFor(choiceId)`, exactly as a `Choice` group does, so a Decision and a Choice on one
surface do not clobber each other.

### R2 — Every scale runs from fine to alarming, left to right

| Dimension | fine → | | → alarming |
|---|---|---|---|
| `severity` | `annoying` | `costly` | `severe` |
| `likelihood` | `unlikely` | `possible` | `likely` |
| `discoverability` | `obvious` | `subtle` | `silent` |

`discoverability` keeps its name — it is the dimension the user asked for — but its *values* run
toward the danger, so `silent` sits on the same end as `severe` and `likely`. There is one ramp to
learn and the alarming column is a straight vertical read.

### R3 — Reversal is two numbers, not one

How long to undo the **action** and how long to undo the **damage** are routinely conflated and are
frequently very different. A migration is one commit to revert and three days of backfill to make
whole.

- `reversal.action` — `trivial` | `cheap` | `costly` | `one-way`
- `reversal.damage` — `minutes` | `hours` | `days` | `weeks+`
- `reversal.note` — one line reconciling them

### R4 — Horizon: how long the decision keeps mattering

The dimension no decision template carries. A haircut matters until the hair grows back. A red shirt
matters until you change. A red shirt at your wedding matters for as long as the photographs do.
Nothing about the shirt changed — only the horizon — and the horizon alone is what makes it a real
decision.

- `horizon.span` — `until-next-commit` | `until-this-ships` | `while-the-code-lives` | `permanent`
- `horizon.until` — a string naming *what ends it*, phrased to complete "this matters until…"

`until` is required whenever `span` is present. It is the field that forces the author to say out
loud what survives an undo.

### R5 — Horizon and reversal are independent, and the gap is the point

A decision can be trivially reversible in code and still `permanent` in horizon, because the
migration already ran, the mail already sent, the API already went public, or a person already saw
it. Reverting the commit does not retract any of those. Every card must be able to express that
combination, and the `until` line is where it gets stated.

The other cell worth staring at is `silent` × `permanent` — a risk nothing will alert on, attached to
a decision that never stops mattering. When a card carries both, the host renders those two chips one
step brighter. This is the only cross-field inference the host makes; it changes emphasis only and
never computes a score.

### R6 — Risks attach to the decision, not to individual options

Per-option risk sets would multiply the card's height by the option count, and the Slate column is
260px. An author who needs to scope a risk to one path names that path in the risk's `note`.

### R7 — A freeform comment field, always present

The card renders a comment box at its foot, above the submit, whether or not the author asks for one.
The author may customize its label and placeholder; the author may not remove it. The user always has
somewhere to say the thing the options did not anticipate.

**Load-bearing constraint:** `usePointAnswerForm` holds exactly **one** `text` value per point and
POSTs `{ choices?, text? }` (`src/components/RunWorkspaceWidget/usePointAnswerForm.ts:45,82`). The
Decision card's comment box binds to that single field, which is why it needs no endpoint change —
and also why a `Decision` and a sibling `TextInput` on one surface render two boxes mirroring the
same string. The renderer does not deduplicate them. The authoring guidance states the rule: a
Decision card owns its surface's text field; do not pair it with a `TextInput`.

### R8 — The host never invents a rating it does not understand

An unrecognized enum value renders as the author's own word, at low ink, uncolored. It is neither
coerced down (which would silently understate a risk) nor up (which would cry wolf).

This deliberately differs from `Stepper`, which coerces an unknown status to `pending`. A neutral
default is safe for progress and unsafe for risk.

### R9 — Degradation is per block, and two options is the floor

A malformed `risks` array degrades to the standard inline amber notice without taking the options
down with it; likewise `reversal` and `horizon`. A `Decision` with fewer than two usable options is
not a decision and degrades whole — same posture as a `Stepper` with unusable steps.

### R10 — Reachable from the composer

A `decision` entry in `SURFACE_CATALOG` (`src/components/RunWorkspaceWidget/surfaceCatalog.ts`) whose
prompt instructs the agent to author a Decision card, so it is discoverable from "+ Add surface"
alongside the existing templates.

---

## The shape

```json
{
  "id": "d",
  "component": "Decision",
  "options": [
    { "id": "worktree", "label": "Isolated worktree per hand",
      "gain": "Hands can't stomp each other's checkouts.",
      "cost": "~400ms + disk per hand; node_modules needs symlinking.",
      "wrongIf": "Hands mostly read and rarely write." },
    { "id": "locks", "label": "Shared tree, advisory locks",
      "gain": "Zero setup cost.",
      "cost": "A crashed hand leaves a stale lock behind.",
      "wrongIf": "Two hands ever write the same file." }
  ],
  "risks": [
    { "label": "Stale lock wedges the fleet",
      "severity": "severe", "likelihood": "possible", "discoverability": "silent",
      "note": "Nothing alerts; it reads like a slow hand." }
  ],
  "reversal": { "action": "costly", "damage": "days",
                "note": "Revert is one commit, but the backfill has to re-run." },
  "horizon": { "span": "permanent",
               "until": "The migration writes rows we can't un-write." },
  "comment": { "label": "Anything else?", "placeholder": "Constraints I've missed…" }
}
```

Paired with a `Submit` sibling, as every control surface is today.

Rendered:

```
┌───────────────────────────────────────────────┐
│ Worktree isolation for parallel hands?  ⟳ – ✕ │
├───────────────────────────────────────────────┤
│ OPTIONS                                       │
│ ○ Isolated worktree per hand                  │
│     + hands can't stomp each other's checkout │
│     − ~400ms + disk each; symlink node_modules│
│     ⚑ wrong if hands mostly read, rarely write│
│ ○ Shared tree, advisory locks                 │
│     + zero setup cost                         │
│     − a crashed hand leaves a stale lock      │
│     ⚑ wrong if two hands ever write one file  │
│                                               │
│ RISKS                                         │
│ Stale lock wedges the fleet                   │
│   severity SEVERE · likelihood POSSIBLE       │
│   discoverability SILENT                      │
│   Nothing alerts; it reads like a slow hand.  │
│                                               │
│ REVERSAL      undo action COSTLY              │
│               undo damage DAYS                │
│   Revert is one commit, backfill must re-run. │
│                                               │
│ HORIZON                         PERMANENT     │
│   until: the migration writes rows we can't   │
│          un-write.                            │
│                                               │
│ Anything else?                                │
│ ┌───────────────────────────────────────────┐ │
│ │                                           │ │
│ └───────────────────────────────────────────┘ │
│               [ Make the call ]               │
└───────────────────────────────────────────────┘
```

---

## Design language compliance

The JSON carries structure only. The host owns every color, radius, and spacing value, per
`docs/slate-design-language.md`.

- **Type.** Section labels (`OPTIONS`, `RISKS`, `REVERSAL`, `HORIZON`) use the mono 10–11px caps meta
  ramp. Option labels use reading sans. Every authored prose string — `gain`, `cost`, `wrongIf`,
  `note`, `until` — pins `font-sans` explicitly, because the run card defaults to mono and unpinned
  prose renders as terminal output.
- **Color.** The alarming end of each ramp is an **amber intensity ramp**: the low value is low-ink
  and unfilled, the high value is bright amber. No new hue is introduced and red stays reserved for
  a failed action, per the existing rule. The chips do not change hue across dimensions — the label
  differentiates them, and the color carries exactly one meaning: *this end is the dangerous one*.
- **Cyan.** None. The card is not a live edge; the selected radio follows the existing control
  accent.
- **Shell.** The card is an ordinary surface in the standard shell — no accent border, no tint, no
  special radius. It earns its distinction from its content.

---

## Out of scope

- **A decision record.** The card is a call you still have to make. Answering resolves it like any
  other open point; the card does not lock into a durable "here is what was decided and why"
  artifact. If the reasoning needs to outlive the answer, that is a separate surface kind.
- **Composite scoring.** No RPN, no weighted total, no sort key derived from the ratings. See the
  FMEA complaint above.
- **Per-option risk sets.** See R6.
- **Cross-run querying.** "Show me every `permanent`-horizon decision across all runs" is a natural
  follow-on and is exactly what the structured primitive makes possible later. It is not this change.

---

## Files in scope

| File | Change |
|---|---|
| `src/a2ui/controls.ts` | `DECISION_COMPONENT`, `parseDecision`, join `CONTROL_COMPONENTS`, feed the option-id/label collectors. React-free. |
| `src/a2ui/controlComponents.tsx` | `DecisionControl` — the rendered card, reading `selectedFor` / `setText` / `submit` from the form context. |
| `src/a2ui/catalog.tsx` | Register `Decision` in the walker's catalog. |
| `src/components/RunWorkspaceWidget/surfaceCatalog.ts` | A `decision` template entry. |
| `docs/the-slate.md` | Add `Decision` to the rendered vocabulary. |
| `docs/slate-design-language.md` | Add the primitive and its ramp. |
| `agent-skills/skills/slate-surface/SKILL.md` | Add the row to the component table plus the authoring rules (R7's text-field ownership, R2's polarity, R4's `until`). |
