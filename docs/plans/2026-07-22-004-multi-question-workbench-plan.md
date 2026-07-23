# S4 — Multi-Question Workbench Surface (implementation plan)

Status: PLAN (no code). Downstream `/lightsout` builds, tests, and squash-merges this as ONE PR.
Date: 2026-07-22
Scope owner: The Slate (`src/components/RunWorkspaceWidget/`, `src/a2ui/`, `src/server/stores/`, `src/server/sessions/`)

## Problem & Scope

The agent often asks the user a **series of questions at once**. Today the Slate renders every
open-point (question) as one row in a single **vertical** grouped list (`OpenPointsSurface`,
`space-y-2`). When the agent has 3–5 questions, the user answers them serially — scrolling a tall
stack — instead of seeing them side by side and working each independently.

Goal: render a set of related questions as a **workbench** — one question **per column** — so the
user picks options / types an answer / submits each column on its own, right on the Slate. Answering
one column must not disturb the others; an answered column shows "answered" while its siblings stay
open.

In scope:
- A way for the agent to author "these N questions are one set" (a grouping signal on the file).
- A columnar workbench rendering of a grouped set, reusing the existing per-point answer form and
  the existing answer endpoint verbatim.
- Backward compatibility: an ungrouped open-point renders exactly as today.

Out of scope: a new answer route; a single-surface "one atomic answer" form; a composer/authoring UI
for workbenches; changing the answer-delivery prompt; mobile-specific chrome beyond horizontal
scroll.

## Decisions

### (a) Schema / authoring — reuse the per-POINT primitive, NOT a single multi-column A2UI surface

**Decision: each question is its own open-point (its own store point + `.tinstar/slate/*.json`
entry) whose `body` carries `Choice`/`TextInput`/`Submit`; a new file-owned `group` string ties a
set together. There is NO new A2UI component and NO new surface `kind`.** The workbench is a *layout*
over N existing open-points, not a new node type.

Why this inverts the brief's stated "one A2UI surface of Row/Cards" preference — grounded in the
code, not taste:

- The interactive form state is **surface-scoped, not column-scoped**. `NoticeFormState`
  (`src/a2ui/controlComponents.tsx:17`) holds **one** `text: string` and **one** `submit()` per
  surface. `OpenPointRow` (`OpenPointsSurface.tsx:207`) builds exactly one such form per point.
  A single A2UI surface with N `TextInput`s would bind them **all** to the same `form.text`
  (`TextInputControl` reads `form.text` at `controlComponents.tsx:114`), and N `Submit`s would all
  call the same `form.submit()` — pressing any one submits everything. `Choice` groups are the only
  per-id-independent control (keyed by `choiceId`, `controlComponents.tsx:79`); text and submit are
  not. So the "one surface, Row of Cards" path does **not** deliver per-question independence — it
  would require inventing per-column form state and a per-column submit, i.e. a *new component/kind*.
  That is **more** to build and fights the existing model.
- Per **point**, independence already exists and is proven: `OpenPointRow` owns its own `selected`
  map, `text`, `submitting`, `optimisticAnswered`, and a `submitAnswer` that POSTs to
  `/api/runs/:id/slate/points/:pid/answer` for **that point only** (`OpenPointsSurface.tsx:174-205`).
  N points = N independent forms, N submits, N answered-locks — exactly the feature — with **zero**
  backend change to routing.
- Authoring stays inside the existing file contract (`toPointInput`, `slate-watcher.ts:418`): N
  open-point entries, each with a `content` body of controls. The only addition is one optional
  string field.

**Tradeoff:** choosing *N-points-plus-layout* over *one-A2UI-surface*. Gains: per-question form
isolation, one-submit-per-question routing, answered-lock, and per-question threads all already exist
— near-zero backend build. Costs: a 3-place schema touch to add `group`, and the questions are
separate store points rather than one surface (each keeps its own thread/lifecycle — arguably a
feature). **Wrong if** the product actually needs the whole set submitted as **one atomic answer** to
the agent — but the feature explicitly wants *one submit per question*, so that condition does not
hold.

The grouping signal is a file-owned `group: "<set-id>"` string (mirrors how `refresh` rides the
file→store→projection path). Points sharing a non-empty `group` render as a workbench; ungrouped
points render in the normal vertical list. Explicit and fully backward compatible (no `group` → today's
behavior). Rejected alternatives: overloading `anchor:{kind:'decision',ref}` (couples layout to
anchor semantics, subtle); auto-grouping "consecutive answerable points" (fragile — a lone open-point
with a choice would get swept in).

### (b) Answer routing — reuse `POST /api/runs/:id/slate/points/:pid/answer` unchanged, one submit per column

**Decision: each column's Submit hits the existing answer route for its own point id, exactly as
`OpenPointRow.submitAnswer` does today. No new route, no new store method.**

The route (`routes.ts:3381-3445`) already does everything a workbench column needs, per question:
validates submitted `choices[]` against **that point's** current content
(`collectChoiceOptionIds`, rejects a stale choice), length-caps `text` (`NOTICE_ANSWER_TEXT_MAX`),
persists the answer as a **user reply** on that point's thread (`appendSlateReply`), and best-effort
delivers **one** prompt (`deliverSlatePrompt`). That is precisely one-submit-per-question.

**Answered state, two layers (both already exist):**
- *Optimistic / immediate:* the column's own `optimisticAnswered` flips `NoticeFormState.answered`
  → the `Submit` control renders "✓ Answered" and locks (`SubmitControl`, `controlComponents.tsx:152`;
  `ChoiceControl`/`TextInputControl` disable when `form.answered`). Sibling columns each have their
  **own** form state, so they stay fully interactive — the isolation is structural, nothing to add.
- *Durable / reconciled:* the persisted user reply makes the point's status derive to `waiting`
  (`derivePointStatus`, `slate.ts:60`), which arrives on the next SSE `run` delta via
  `run.slate`. The column can show that status too, so an "answered" column survives a reload.

A new per-question route would duplicate the validation + reply-persist + deliver the route already
does. Rejected.

### (c) Layout — a dedicated horizontal scroller inside the full-width open-points slot, NOT the 1→2 grid

**Decision: render a grouped set as a horizontal band of fixed-min-width columns
(`flex flex-row`, each column `min-w-[240px]`, `overflow-x-auto`) inside the open-points slot, which
already spans `col-span-full`. Stacks to a single column on a very narrow panel.**

`SlatePanel`'s reflow is **1→2 columns only**, gated on measured width ≥ `SLATE_TWO_COL_MIN` (420px,
`SlatePanel.tsx:41,148`), and the open-points list already renders `col-span-full`
(`SlatePanel.tsx:248`). A "SERIES" implies 3+ questions, which a 2-column cap can't lay out as a
workbench. A horizontal scroller shows N columns at any panel width and degrades to scroll on narrow
panels — matching the repo convention that wide content scrolls inside its own `overflow-x-auto`
container. It must carry the same #126 layout guards the panel relies on (`min-w-0` per column,
`overflow-wrap:anywhere`, and its own `overflow-x-auto` so it never forces the panel body to scroll
horizontally — `SlatePanel.tsx:231-234`).

**Tradeoff:** horizontal scroller over the existing 2-col grid. Gains: N columns at any width,
mobile-friendly scroll, doesn't fight the 2-col cap. Costs: a nested horizontal scroller inside the
panel's vertical scroller needs the min-w-0/overflow guards or it regresses the "no horizontal
overflow" invariant. **Wrong if** question sets are almost always exactly 2 (then the grid suffices) —
but a "series" is 3+, so the scroller earns its place. Mark the band `data-scrollable` so the canvas
wheel handler yields to it (same reason the panel body is marked).

## Implementation Units

### U1 — File-owned `group` field: the 3-place schema passthrough (mirror `refresh`)

**Goal:** carry an optional `group` string from the authored file, through the store's merge-by-id, to
`run.slate`, without disturbing any existing field. This is the known "RunData/point field is a
3-place change, two of which fail SILENTLY" trap (memory: `reference_rundata_field_three_places`) —
add + guard-test all three.

**Files:**
- `src/server/stores/slate.ts` — **Modify.** Add `group?: string` to `PointInput` (near `refresh`,
  ~line 38). In `createPoint` (~line 98) spread `...(input.group ? { group: input.group } : {})`. In
  `mergeFileOwned` (~line 127) overwrite/clear it like `refresh` (`if (input.group) next.group = input.group; else delete next.group`). In `fileOwnedChanged` (~line 89) add
  `(prior.group ?? undefined) !== (input.group ?? undefined)` — **load-bearing:** omit this and an
  amend that only changes `group` short-circuits silently (never re-projects).
- `src/domain/types.ts` — **Modify.** Add `group?: string` to `Point` (~line 565, near `refresh`) and
  to `SlateSurface` (~line 505, near `refresh`), each with a docstring noting it is file-owned and
  ties a workbench set together.
- `src/server/stores/document-store.ts` — **Modify.** In `projectRunToSlate` (~line 979) add
  `...(p.group ? { group: p.group } : {})` — **load-bearing:** omit this and `group` never reaches the
  client (`setRunSlate`'s `JSON.stringify` compare at line ~738 does pick up the new field once it's
  in the projected object, so no equality change is needed — but the field must be *in* the object).
- `src/server/sessions/slate-watcher.ts` — **Modify.** In `toPointInput` (~line 418) parse it like
  `refresh`: `if (typeof r.group === 'string' && r.group.length > 0) out.group = r.group`.
- `src/server/sessions/surfaceAuthor.ts` — **Modify.** Extend `SLATE_AUTHOR_CONTRACT` (~line 40) with
  one line: an OPTIONAL `"group": "<set-id>"` field — "give the same group id to a set of related
  questions and they render side-by-side as a workbench (one question per column); omit it for a
  normal row." Keep it terminal-safe (single line, no example bloat — the author is context-free).

**Test files:**
- `src/server/stores/__tests__/slate.test.ts` — **Modify/add.** Guard: a projection carrying `group`
  creates a point with `group`; re-projecting the SAME file is byte-equal (short-circuit, no emit);
  changing ONLY `group` bumps `amendedAt` and re-emits (fails if `fileOwnedChanged` omits the
  comparison); omitting `group` on a later projection clears it.
- `src/server/stores/__tests__/document-store-slate-bridge.test.ts` — **Modify/add.** Guard: a stored
  point with `group` projects onto `run.slate` with `group` present (fails if `projectRunToSlate`
  drops it).
- `src/server/sessions/__tests__/slate-watcher.test.ts` — **Modify/add.** Guard: a file entry with a
  string `group` yields a `PointInput.group`; a non-string/empty `group` is ignored (not an error).

**Approach:** copy the exact shape of the `refresh` field everywhere it appears — it is the proven
template for a file-owned passthrough with clear/overwrite-on-projection semantics.

**Verification:** `env -u NODE_ENV npx tsc --noEmit -p tsconfig.app.json`;
`env -u NODE_ENV npx vitest run --exclude='e2e/**' src/server/stores src/server/sessions`. Then a
back-out check: temporarily delete the `fileOwnedChanged` line and confirm a group-only-change test
FAILS (proves the guard is real), then restore.

### U2 — Extract the shared per-point answer form hook

**Goal:** factor the answer-form logic out of `OpenPointRow` so both the existing row and the new
workbench column drive answers through ONE code path (identical routing, optimistic answered,
choice/text validation). Prevents a second, drifting copy of `submitAnswer`.

**Files:**
- `src/components/RunWorkspaceWidget/usePointAnswerForm.ts` — **Create.** A hook
  `usePointAnswerForm(runId, pointId): { form: NoticeFormState; error: string | null; answered: boolean }`
  holding `selected`/`text`/`submitting`/`optimisticAnswered` and the `toggleOption`/`selectedFor`/
  `submitAnswer` callbacks lifted verbatim from `OpenPointsSurface.tsx:104-216` (the POST body and
  the `/answer` URL are unchanged). Uses `apiFetch` from `src/apiClient`.
- `src/components/RunWorkspaceWidget/OpenPointsSurface.tsx` — **Modify.** Replace the inline answer
  form state in `OpenPointRow` with `usePointAnswerForm`, leaving the resolve/thread/hide/freshness
  logic untouched. Pure refactor — same behavior.

**Test files:**
- `src/components/RunWorkspaceWidget/__tests__/OpenPointsSurface.test.tsx` — **Modify.** The existing
  answer-submit assertions must still pass unchanged (proves the extraction is behavior-preserving).

**Approach:** mechanical lift-and-shift; do not change the POST shape or URL. Keep `NoticeFormState`
as the return type so `A2uiRenderer form={...}` wiring is identical.

**Verification:** `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/components/RunWorkspaceWidget`
— the pre-existing OpenPointsSurface tests are the regression gate.

### U3 — The workbench surface (columnar layout + per-column form)

**Goal:** render a grouped set of open-points as a horizontal band of columns, each an independent
question with controls + submit + answered-lock, reusing the shared form hook and the shared
`A2uiRenderer`.

**Files:**
- `src/components/RunWorkspaceWidget/WorkbenchSurface.tsx` — **Create.** Props:
  `{ runId, group, points: SlateSurface[] }`. Renders a labelled band (mono caps header per the
  design language, e.g. the set's header or "Questions · N", plus an "M of N answered" progress
  count) whose body is `flex flex-row gap-2 overflow-x-auto` with `data-scrollable`. Each point →
  one `WorkbenchColumn` (`min-w-[240px] max-w-[320px] min-w-0`, card shell:
  `rounded border border-hairline bg-surface-raised p-[14px]`). A `WorkbenchColumn` shows the
  point's `headline` (Chakra display, `font-display`), renders `surface.body` via
  `<A2uiRenderer content={surface.body} form={interactive ? form : undefined} />` where `form` comes
  from `usePointAnswerForm(runId, surface.id)` and `interactive = isAnswerable(surface.body)`, and
  surfaces the hook's `error`. An answered column keeps the design-language answered posture: the
  shared `SubmitControl` already renders "✓ Answered" and disables the controls via
  `form.answered` — no extra state. On a very narrow panel the band still scrolls (no stacking logic
  needed for MVP; columns keep their min-width and overflow).
- `src/components/RunWorkspaceWidget/OpenPointsSurface.tsx` — **Modify.** Partition the incoming
  `points` (after the existing hide/order filtering, `OpenPointsSurface.tsx:446-451`) into
  `grouped` (non-empty `surface.group`) keyed by group id, and `ungrouped`. Render one
  `<WorkbenchSurface>` per group (ordered by the group's min `createdAt` for stable placement) ABOVE
  the normal vertical list, then the existing `OpenPointRow` list for ungrouped points, then
  `<AddPoint>`. Grouped points do NOT also appear in the vertical list. Keep `SlatePanel`'s dispatch
  unchanged — the whole feature lives inside the open-points slot.

**Approach & design-language conformance** (`docs/slate-design-language.md`):
- Read-only controls sit at 55% until answerable; the chosen/focused accent is live cyan. (The
  shared controls follow the notice-form `interactive`/`answered`/`submitting` states; pass
  `form={undefined}` for a non-answerable body so it renders static.)
- One card shell per column, hairline border, 14px padding, sharp 4px radius — no per-column accent
  border (differentiation is the headline's job, P2/P3).
- Full-width band inside `col-span-full`; the horizontal scroller carries `min-w-0` per column and
  its own `overflow-x-auto` so `columnsOverlapPx === 0` / no panel-level horizontal overflow (#126).

**Test files:**
- `src/components/RunWorkspaceWidget/__tests__/WorkbenchSurface.test.tsx` — **Create.** Mock
  `apiFetch` (same pattern as `OpenPointsSurface.test.tsx:8-14`). Scenarios below.
- `src/components/RunWorkspaceWidget/__tests__/OpenPointsSurface.test.tsx` — **Modify.** Add: grouped
  points are pulled OUT of the vertical `point-<id>` list and into a workbench; ungrouped points still
  render as rows.

**Test scenarios:**
1. N grouped points render N columns (one per point id) inside a single workbench band.
2. Submitting column A POSTs to `/api/runs/:id/slate/points/<A>/answer` with A's choices/text; column
   B is untouched (no POST for B) and its controls remain enabled.
3. After a successful submit, column A shows "✓ Answered" and its controls are disabled; column B
   stays open/interactive (per-column isolation).
4. Submit with neither a choice nor text shows the "Pick an option or add a note" error and does NOT
   POST (reuses the hook's guard).
5. Progress count reads "M of N answered" and increments after a column is answered.
6. A grouped point does NOT also appear as a standalone `point-<id>` row.
7. A workbench point with a non-answerable body renders its prose read-only (no submit).

**Verification:** `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/components/RunWorkspaceWidget`;
`env -u NODE_ENV npx tsc --noEmit -p tsconfig.app.json`. Manual/visual check deferred to the user per
repo convention (frontend rebuild + hard reload on :5273).

### U4 — Author-contract + docs closeout

**Goal:** the file-authoring contract and the surface-authoring solution doc describe the `group`
field so a context-free code-spawned author (and the main agent) can produce a workbench.

**Files:**
- `src/server/sessions/surfaceAuthor.ts` — **Modify** (the one line added in U1; verify wording).
- `docs/solutions/documentation-gaps/slate-surface-authoring-contract.md` — **Modify** (the canonical
  contract the inline copy is condensed from): document `group` and the workbench behavior so the two
  stay in sync.

**Approach:** keep both edits to a couple of lines; `group` is optional and additive, so existing
author prompts keep working.

**Test scenarios:** none (docs); covered indirectly by U1's `slate-watcher` parse test.

**Verification:** re-read both to confirm the inline contract line and the solution doc agree.

## Scope Boundaries

- **No new answer route and no new store method** — the workbench routes through the existing
  `/answer` endpoint per point (Decision b).
- **No single-surface "atomic set answer"** — each question submits independently; there is no
  combined submit.
- **No composer/authoring UI** for building a workbench in-app — the agent authors grouped
  open-point files (a Slate composer for workbenches is a possible follow-up, explicitly out here).
- **No change to answer-delivery prompt text** (`slateAnswerPromptText`) — each column delivers the
  same per-point prompt today's rows do.
- **No mobile-specific layout** beyond horizontal scroll; a stacked/mobile mode is tracked separately
  (`docs/brainstorms/2026-07-21-mobile-mode-requirements.md`), not this PR.
- **No change to `SlatePanel`'s dispatch or the 1→2 grid** — the feature is contained to the
  open-points slot + the new components + the `group` field.
- **User-added points (`AddPoint`) stay ungrouped** — the workbench is an agent-authoring affordance.

## Risks

- **Silent-drop schema trap (highest).** Adding `group` touches merge-equality
  (`fileOwnedChanged`) and the projection (`projectRunToSlate`); the memory note
  `reference_rundata_field_three_places` records that two of the three fail *silently* (a dropped
  emit; an undefined-drop inheriting a stale value). Mitigation: U1 mirrors `refresh` exactly and
  adds a guard test per place, including a back-out check that a group-only change re-emits.
- **Horizontal-overflow regression (#126).** A nested horizontal scroller inside the panel's vertical
  scroller can reintroduce panel-level horizontal overflow if a column lacks `min-w-0`/overflow-wrap.
  Mitigation: apply the same guards the panel uses and keep the scroll inside the band's own
  `overflow-x-auto`; the existing `RunWorkspaceWidget.slateResize` guard (`columnsOverlapPx === 0`)
  is the backstop — extend/assert it if it exercises the open-points slot.
- **Refactor regression (U2).** Extracting the answer form from `OpenPointRow` could subtly change
  submit behavior. Mitigation: the extraction is behavior-preserving and the pre-existing
  `OpenPointsSurface.test.tsx` answer assertions are the regression gate — they must pass unchanged.
- **Grouped-point leakage.** If the partition in `OpenPointsSurface` is wrong, a grouped point could
  render both in a workbench and in the vertical list (double answer affordance). Mitigation: scenario
  6 asserts a grouped point is absent from the `point-<id>` row list.
- **Answered reconciliation race.** The optimistic "✓ Answered" is per-column local state; the durable
  status arrives on the next `run.slate` delta. This matches `OpenPointRow`'s existing model
  (`optimisticStatus`/`optimisticAnswered`), so no new race is introduced — but keep the answered
  posture driven by `form.answered` (local) rather than second-guessing the reconciled status
  mid-flight.
- **Author compliance.** A context-free code-spawned author may ignore `group`. Low-severity: an
  omitted `group` simply renders the questions as today's rows (graceful degradation), and the
  contract line nudges compliance.
