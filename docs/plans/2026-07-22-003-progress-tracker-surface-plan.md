# S3 — Generic skill-progress tracker surface

**Plan doc.** Downstream `/lightsout` builds, tests, and merges this as ONE squash-merged PR.
Date: 2026-07-22. Author: planning pass (no code written here).

## Problem & Scope

A skill wants to show the user a **live stepper** on a run's Slate: a list of phases,
each `pending` / `active` / `done` / `skipped`, that the skill advances one step at a
time. The compound-engineering pipeline (**brainstorm → plan → work → review → compound**)
is the first rider, but the deliverable is the **general mechanism**, not a CE-specific
widget.

The prior note — *"needs no new plumbing — a skill rewrites its surface file per phase"* —
is correct and load-bearing. The Slate already carries everything: a skill writes
`<run-workdir>/.tinstar/slate/<slug>.json` with `anchor:{kind:'surface'}`; the watcher
validates it, `projectRunToSlate` derives `kind:'diagram'`, and `DiagramSurface.tsx`
renders the file-owned A2UI `body` through the shared `A2uiRenderer`
(`src/components/RunWorkspaceWidget/DiagramSurface.tsx:29`). Rewriting the same-`id` file
each phase amends the panel in place (merge-by-id). **No watcher / store / SSE / kind /
routing change is needed.**

The one real question is decision (a) below: A2UI is a **closed vocabulary** and, by design,
*JSON carries structure, never color* (`docs/slate-design-language.md:58`). So an authored
surface cannot color a step by status using existing primitives. That gap is what this plan
resolves — with a single small catalog primitive, no schema or plumbing change.

**In scope:** one A2UI catalog primitive (`Stepper`); a documented authoring convention any
skill can adopt; a committed reference example (the CE pipeline) that doubles as a test
fixture; registration of the new primitive in the two existing Slate docs.

**Out of scope:** a new `'progress'` surface `kind`; any server/watcher/store/SSE/`projectRunToSlate`
change; changes to `A2uiContentSchema`; wiring the CE skill itself to emit the file (the
convention is the deliverable — a rider skill adopts it later); interactivity/controls on the
stepper.

## Decisions

### (a) Render via existing primitives, or a small new A2UI component? → **Add one primitive: `Stepper`.**

**Decision:** add a single leaf component `Stepper` to the host catalog
(`src/a2ui/catalog.tsx`). It reads a passthrough `steps` prop — an array of
`{ label, status, detail? }` — and renders a vertical status rail that reuses the exact
hue vocabulary the open-points lifecycle track already uses
(`src/components/RunWorkspaceWidget/OpenPointsSurface.tsx:41,62`).

**Why not pure existing primitives (a Column of Rows with glyphs)?** They do *not* suffice
for a **status-colored** stepper, and status color is the whole point:

- A2UI's contract is *"JSON carries structure, never color/spacing"* — the catalog owns all
  color. `Text` has no status/hue prop, so an authored Column/List stepper is unavoidably
  **monochrome**. It can show status only by glyph shape (`✓ ▸ ○ ⊘`), throwing away the
  design system's entire status vocabulary: `done`→emerald, `active`→cyan (live), `skipped`→slate.
- The **active** phase is the live edge, and `P4 · Cyan means live` reserves cyan for exactly
  that (`docs/slate-design-language.md:10`). A pure-primitive stepper cannot express it.
- **Prior art confirms the pattern:** the open-points lifecycle track is itself a *bespoke
  React component*, not A2UI-authored, precisely because A2UI can't color-code a status track.
  A `Stepper` primitive is the generic, catalog-level version of that same proven visual.

**Tradeoff (no-free-lunch):** choosing `Stepper` primitive over pure-primitive convention.
*Gains* the full hue/cyan status vocabulary, a scalable N-phase rail, and one reusable
primitive any surface can use (not progress-specific). *Costs* ~40 lines in `catalog.tsx`
plus tests — but **zero** schema/plumbing change (see (c)). *Wrong if* the design language
later forbids new primitives, or a monochrome glyph checklist were judged acceptable — it
isn't, because it discards `done`/`active`/`skipped` color, the feature's core signal.

**Assumptions:** (1) A new leaf component is acceptable growth of the "closed" vocabulary —
justified because the catalog is explicitly the place new primitives are added, and the
design language already flags a real primitive as the right answer over faking visuals
(`docs/slate-design-language.md:66`, "flag for a real … primitive"). (2) A vertical rail
(not the horizontal 4-dot inline track) is right — it scales to N phases with labels and
reads as a "stepper"; the CE rider has 5 phases.

**Status vocabulary (fixed, 4 values):** `pending` | `active` | `done` | `skipped`.
Deliberately distinct from `PointStatus` (`open/discussing/waiting/resolved/dismissed`) —
a progress phase is not a point lifecycle. Mapping to existing tokens:

| status | node | label ink | token (literal class) |
|---|---|---|---|
| `done` | `✓` filled | mid | `bg-hue-resolved` / `text-hue-resolved` (emerald) |
| `active` | filled + cyan glow | high | `bg-primary` / `text-primary` + `shadow-[0_0_14px_rgba(0,240,255,0.10)]` (P4 live) |
| `pending` | hollow faint dot | low | `bg-primary/12` rail, `text-ink-low` |
| `skipped` | dimmed dot | low, strikethrough | `bg-hue-dismissed` / `text-hue-dismissed` (slate) |

Unknown/missing status coerces to `pending` (never throws — R16).

### (b) How a skill updates it → **overwrite `.tinstar/slate/<slug>.json`, same `id` each phase.**

Recommended single-object file shape (documented so any skill can copy it):

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

Rules the convention pins down:
- **Stable `id`** (the slug) reused across every write → merge-by-id amends the panel in
  place, preserving the store-owned thread (`SlateSurface.thread`) and freshness. A new `id`
  each write would spawn duplicate panels.
- **`author: 'agent'`** — matches the authoring-contract examples and keeps the surface off
  the self-prompting loop. `'process'` is defensible (its stall-sweep would mark a
  dead-mid-run tracker stalled), but the surface's own freshness stamp already ambers past
  15m when untended, so 'agent' is the simpler default. *(Assumption; documented as a note.)*
- **No `refresh` recipe.** A progress tracker is **session-derived** — it fails the
  authoring-contract *vacuum test* (`slate-surface-authoring-contract.md:205`): a context-free
  author can't reproduce "how far is this skill". The main skill owns rewriting it per phase;
  do **not** give it a self-contained recipe it can't honor. This is a deliberate application
  of the existing contract, called out in the doc.
- **Per-phase discipline:** on each phase transition the skill rewrites the whole file with
  updated `status` values (and clears/updates the `active` step's `detail`). One write per
  phase; the watcher (~3s poll backstop + inotify) reprojects it under the poll cadence.
- May be embedded in a larger surface (a `Column` whose children include the `Stepper` plus a
  `Text` intro) — `Stepper` is a normal leaf and composes anywhere in an A2UI body.

### (c) Anything server/render-side needed? → **Render-side only: one catalog entry. No plumbing, no schema.**

- **No schema change.** `A2uiComponentSchema` is web_core's `AnyComponent` (passthrough props),
  so `steps` validates without any edit to `src/a2ui/schema.ts`
  (`src/a2ui/schema.ts:26`, `src/domain/types.ts:462` `[key: string]: unknown`).
- **No renderer change.** Adding `Stepper` to `CATALOG` makes `isSupported('Stepper')` true
  automatically; the walker calls `CATALOG['Stepper'].render(node, children)`
  (`src/a2ui/A2uiRenderer.tsx:93,100`). It's a **leaf** — `childIdsOf` already returns `[]`
  for a node with no `children`/`child`, so no edit there
  (`src/a2ui/catalog.tsx:161`).
- **No surface-kind / routing change.** The tracker is a `diagram` surface; `DiagramSurface`
  renders any body, so the Stepper appears with zero change to `DiagramSurface.tsx`,
  `SlatePanel.tsx`, `projectRunToSlate`, or the watcher. The `'progress'` string in
  `SlateSurface.kind`'s JSDoc stays aspirational — we intentionally do **not** add a
  `'progress'` kind (that would be the server plumbing this note says we don't need).

So the feature is **mostly a documented convention + reference example**, plus **one thin
catalog component** to carry the status color the design language demands.

## Implementation Units

### Unit 1 — The `Stepper` A2UI catalog primitive

**Goal:** a leaf catalog component that renders a status-colored vertical stepper from a
passthrough `steps` array, host-themed, degrading gracefully (never throws).

**Files:**
- `src/a2ui/catalog.tsx` — *Modify.* Add a `Stepper` entry to `CATALOG` plus a small
  defensive `steps` parser and a per-status token map.
- `src/a2ui/__tests__/A2uiRenderer.test.tsx` — *Test.* Add a `Stepper` describe block
  (this is where catalog rendering is exercised end-to-end through `A2uiRenderer`).

**Approach:**
- Add `Stepper` to `CATALOG`. It ignores rendered `children` (leaf) and reads `node.steps`.
- **Defensive parse** (props are passthrough / `unknown`): coerce `node.steps` to an array of
  `{ label:string, status:'pending'|'active'|'done'|'skipped', detail?:string }`. Drop
  non-object entries; empty/missing `label` → skip that row; unknown/absent `status` →
  `pending`. If `steps` is absent or not a non-empty array, render a single inline
  `NodeFallback`-style marker (mirror the catalog's existing degrade tone) — **never throw**
  (R16, `src/a2ui/A2uiRenderer.tsx:71`).
- **Markup:** a vertical `flex flex-col` rail. Each row = a status node (dot/`✓`) + a
  connector segment + a label (+ optional `detail` as a caption). Use the per-status token
  map from decision (a). **Literal class strings only** — no interpolation — so Tailwind's
  JIT emits them (the same discipline OpenPointsSurface uses, `OpenPointsSurface.tsx:41,62`;
  and `npm run lint` catches phantom classes — see Risks).
- Add `data-status` / `data-testid` hooks per row (e.g. `data-testid="stepper-step"`,
  `data-status={status}`) so tests assert derived state without reading class strings.
- Update the header comment block in `catalog.tsx` to name `Stepper` alongside `Link`/`Code`
  as a host addition.

**Test scenarios:**
1. Renders one row per valid step, labels in order.
2. `done` row carries the emerald token (`hue-resolved`) and a `✓`.
3. `active` row carries the cyan/`primary` token + the live-glow shadow, high-ink label.
4. `pending` row is low-ink with the faint rail dot; `skipped` row is dimmed + strikethrough
   with the `hue-dismissed` token.
5. Unknown `status` (e.g. `"whatever"`) coerces to `pending` (no throw, `data-status="pending"`).
6. Missing/empty/non-array `steps` → a single inline marker, **no throw**, siblings unaffected
   (render a Column containing the Stepper + a sibling Text, assert the Text still renders).
7. A step with no `label` is skipped; a step with a `detail` renders the detail caption.
8. `Stepper` composes inside a `Column`/`Card` body (nested render path).

**Verification:** `env -u NODE_ENV npx tsc --noEmit -p tsconfig.app.json` and
`env -u NODE_ENV npx vitest run --exclude='e2e/**'` green; `npm run lint` clean (phantom-class
guard).

### Unit 2 — The authoring convention doc + reference example (primary deliverable)

**Goal:** one authoritative page any skill reads to author a progress tracker, plus a
committed reference example that can't rot because a test validates it.

**Files:**
- `docs/solutions/conventions/authoring-a-skill-progress-tracker-surface.md` — *Create.*
  Frontmatter matching the sibling solution docs (`module: slate`, `category: conventions`,
  `problem_type`, `tags`, `applies_when`). Body: the recommended file shape (decision (b)),
  the `Stepper` `steps` schema + 4-status vocabulary, the stable-`id` merge-by-id rule, the
  `author:'agent'` note, the **no-refresh / vacuum-test** rationale, the per-phase rewrite
  discipline, and the **CE pipeline as the first rider** (brainstorm→plan→work→review→compound).
  Cross-link the authoring-contract and the design-language docs.
- `docs/examples/slate/skill-progress-tracker.json` — *Create* (new `docs/examples/slate/`
  dir). The canonical CE-pipeline example file, valid to drop into `.tinstar/slate/`. This is
  the copy-me artifact the doc points at. (Committed here, **not** in the gitignored
  `.tinstar/` runtime dir.)
- `src/a2ui/__tests__/progressTrackerExample.test.ts` — *Test.* Reads the committed example
  JSON, runs it through the real gates, so the doc example stays honest.

**Approach:**
- Write the doc as a proper `docs/solutions/` reference (mirror the style/frontmatter of
  `slate-surface-authoring-contract.md`). Keep it terse and operational: a skill author should
  be able to copy the JSON and wire the per-phase rewrite in minutes.
- Author `skill-progress-tracker.json` as the exact shape from decision (b) with all 5 CE
  phases, `id:"ce-pipeline"`, `anchor:{kind:'surface'}`, one `Stepper` root, no `refresh`.
- The fixture test imports `parseA2uiContent` from `src/a2ui/schema` and asserts, on the
  committed file: (1) it parses as JSON; (2) `headline` is a non-empty string; (3)
  `anchor.kind === 'surface'`; (4) `content` passes `parseA2uiContent` (non-null); (5) `root`
  names a real component id; (6) the root component is a `Stepper` whose `steps` is a non-empty
  array and every `status` is one of the 4 allowed values. This is the "pre-ship validation
  one-liner" from the authoring contract, applied as a guard test.

**Test scenarios:**
1. The committed example parses and passes every gate above (fails loudly if someone edits the
   doc example into an invalid shape).
2. Every step's `status` ∈ {pending,active,done,skipped}.
3. Rendering the example content through `A2uiRenderer` produces the 5 phase rows (a light
   render assertion tying the doc example to Unit 1's component).

**Verification:** typecheck + vitest green; the doc renders as Markdown; `docs/examples/slate/`
path is committed and referenced from the doc.

### Unit 3 — Register `Stepper` in the two existing Slate docs

**Goal:** the new primitive is discoverable from the docs an author already reads, so it isn't
an orphan.

**Files:**
- `docs/solutions/documentation-gaps/slate-surface-authoring-contract.md` — *Modify.* Add a
  `Stepper` row to the component-vocabulary table (`:77`–`:90`): children `— (leaf)`, notable
  prop `steps: [{label,status,detail?}]`, renders as "status-colored vertical stepper", with
  a one-line pointer to the new convention doc.
- `docs/slate-design-language.md` — *Modify.* Add `Stepper` to the "A2UI primitives" list
  (`:58`–`:66`) as the status-track primitive, and note that a progress tracker is a `diagram`
  surface using it (the design language currently only flags the *need* for real primitives —
  this records that the stepper is one).

**Approach:** additive edits only; keep both docs' terse voice. No behavior change.

**Test scenarios:** none (docs). 

**Verification:** the vocabulary table and primitives list name `Stepper` consistently with
`catalog.tsx`; links resolve.

## Scope Boundaries

- **No new surface `kind`.** The tracker is a `diagram` surface. No `projectRunToSlate`,
  `SlatePanel` routing, or `SlateSurface.kind` change. (Leaves the JSDoc `'progress'` string
  as-is — a documented drift, not this PR's job.)
- **No schema change.** `steps` rides passthrough props; `src/a2ui/schema.ts` untouched.
- **No watcher / store / SSE change.** Authoring + freshness + threads already flow through the
  existing pipeline.
- **No interactivity.** `Stepper` is read-only display; no controls, no answer-back.
- **The CE skill is not wired here.** This PR ships the *mechanism* + docs + example. A rider
  skill (CE pipeline) adopts the convention in follow-up work — kept out so this stays one
  cohesive, mergeable PR.
- **No version bump.** Per conventions.

## Risks

- **Passthrough props are untyped (`unknown`).** A malformed `steps` (string, object, missing
  labels) must degrade, never throw — an uncaught throw would be caught by the per-notice error
  boundary but blank the *whole* surface. Mitigation: defensive parse + test scenario 6/5; treat
  the R16 "never throw, never blank" rule as the acceptance bar.
- **Tailwind JIT / phantom classes.** Interpolated class strings (`bg-hue-${x}`) are silently
  dropped. Mitigation: literal class strings only (as OpenPointsSurface does), and run
  `npm run lint` (catches phantom classes; palette single-sourced in `tailwind.theme.js`) —
  the hue/`primary` tokens are already defined there (`tailwind.theme.js:36,40,41`).
- **Doc example rot.** A hand-edited example could drift from what the component/gates accept.
  Mitigation: Unit 2's fixture test validates the *committed* example through the real
  `parseA2uiContent` gate + a render assertion — the example can't silently go invalid.
- **`author` choice is a judgment call, not a hard rule.** `'agent'` vs `'process'` changes
  stall-sweep behavior. Mitigation: recommend `'agent'`, document the `'process'` alternative
  and why the freshness stamp already covers stall visibility — so a skill author can choose
  deliberately.
- **Over-vocabulary creep.** Adding one primitive to a "closed" set invites more. Mitigation:
  scope this to exactly `Stepper`; the design language's own "flag for a real primitive" stance
  makes a status track a legitimate, bounded addition rather than a precedent for arbitrary
  components.
