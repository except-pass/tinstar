# S2 — The "Objective" Surface (implementation plan)

A user-authored statement of a run's goal, pinned at the top of that run's Slate.
Editing it re-nudges the run's agent so it stays aligned. One per run. Built as a
thin layer over the existing Slate point store, projection, and delivery plumbing.

Downstream: one `/lightsout` PR builds, tests, and merges this. No version bump.

---

## Problem & Scope

The Slate already carries per-run A2UI **surfaces** (open-points, diagrams) authored
by the agent via files (`.tinstar/slate/*.json`) or by the user over HTTP. There is
no first-class place for the **user** to state, keep visible, and revise *the goal of
the session* — and to have that revision actively reach the agent.

**In scope:** an Objective surface — a single, user-authored, pinned, editable goal
statement per run; every meaningful edit delivers a nudge to the run's agent; it
survives the agent's file re-projections; it renders as a distinct pinned card at the
top of the Slate column, styled per the Slate design language.

**Out of scope:** agent/file authoring of the objective (it is user-owned only —
see Decisions); multiple objectives per run; objective history/versioning; anchoring
the objective to a decision/surface; multiplayer edit conflict resolution.

### The `/goal` boundary (checked explicitly)

I searched the whole repo (`grep -rni "goal"` across `src/`, `.claude/commands/`,
`agent-skills/`, `docs/`). **There is no `/goal` slash command or `goal`/`objective`
field in the Tinstar codebase.** `/goal` is not a Tinstar construct — it is either an
agent-CLI (Claude Code) convention or an informal name for the run's **launch prompt**.

The closest existing mechanism is the session **launch prompt** (`prompt` →
`enriched.initialPrompt` → delivered once via tmux at spawn, `routes.ts` ~L646). Its
properties define the boundary the Objective must NOT duplicate:

| | Launch prompt (`/goal`-like) | **Objective surface (S2)** |
|---|---|---|
| Lifetime | Fire-once at spawn | Durable, persisted, visible on the card |
| Editable after spawn | No | Yes, in place |
| Re-delivered on change | No | **Yes — every edit nudges** |
| Owner | Whoever launched the run | The user, over HTTP |
| Rendered artifact | None (it's in scrollback) | A pinned Slate card |

So the Objective is distinct: it is a *standing, editable, re-nudging* artifact, not
a one-shot instruction. The plan does not touch the launch-prompt path.

---

## Decisions

### (a) A new surface KIND, realized as a store-backed user point — not a new store, not a file

**Decision:** The Objective is a **new Slate surface kind (`'objective'`)**, backed by
a **single reserved user-authored `Point`** with a fixed id `objective`, rendered as a
pinned standalone editable card. It is *both* answers to (a): a new kind, and a
standalone card the user authors/edits — in the Slate's model those are the same thing
(the kind is how a standalone card is rendered).

Currently `projectRunToSlate` (`document-store.ts` ~L972) derives kind purely from the
anchor: `anchor.kind==='surface' → 'diagram'`, else `'open-point'`. We add one branch
ahead of that: a `source:'user'` point whose id is the reserved `OBJECTIVE_ID` projects
as kind `'objective'` with `order` forced to a low sentinel so it sorts first.

**Rationale:** This reuses the most-tested plumbing — the point store's merge-by-id,
the `source:'user'` retraction-exemption, the config snapshot (`slatePoints`), the
`deleteRun`/`clearSpace` prune cascades, and the single `RunData.slate` render channel —
so the Objective needs **no new persistence format, no new store, and (critically) no
new `RunData` field** (avoiding the 3-place `type → runShallowEqual → mergeRun` change,
two legs of which fail silently; `RunData.slate` already flows through both — verified
at `document-store.ts` L136 and `useServerEvents.ts` L346).

**Tradeoff:** choosing *reserved-id user point* over a *dedicated `ObjectiveStore`*.
Gains: minimal new surface area, every persistence/prune path already exists and is
tested. Costs: a magic reserved id, and a theoretical collision if a `.tinstar/slate`
file authors a point with id `objective` (mitigated below). Wrong if: we later need
multiple objective-like pinned artifacts, or objective data with a shape points can't
hold — then a dedicated store earns its keep.

**Assumptions:** the objective is a short prose statement (a sentence or few), stored
in the point's `headline` field with an objective-specific cap (`OBJECTIVE_MAX = 600`);
one per run is sufficient; the user is the sole author.

### (b) The nudge reuses `deliverSlatePrompt` → `tmuxBackend.sendPrompt`

**Decision:** The edit route calls the existing `deliverSlatePrompt(ctx, runId, text)`
(`routes.ts` ~L1065) with a **new prompt builder** `slateObjectivePromptText(text, origin)`
added to `src/slate/slatePrompt.ts`, carrying the same `GUARDRAIL` line every Slate
injection carries ("a note, not a command to drop in-flight work"). Delivery is
best-effort; `delivered:false` on an unreachable run is a note, not an error (mirrors
compose/refresh). The nudge is delivered **on every real edit** (text actually changed)
and on first-set; a byte-identical PUT short-circuits (no store change → no nudge).

**Rationale:** `deliverSlatePrompt` is the one serialized-per-session delivery path all
user-authored Slate injections already use; the objective is a user-authored injection.

**Distinction from `POST /slate/points`:** that route deliberately does **not** deliver
("add a point = eventual", `routes.ts` L3368). The Objective is the opposite posture —
an edit is a deliberate re-alignment that *should* reach the agent now — so it gets its
**own route** rather than overloading the non-delivering points route.

**Assumption:** the injected nudge line collapses the objective's whitespace via the
existing `oneLine()` helper (directive-injection guard), consistent with every other
Slate prompt builder; the stored/rendered objective keeps its full text.

### (c) Persistence in the point store (not a file); edited via a dedicated route + inline card

**Decision:** Persist via the point store as a `source:'user'` point (rides the existing
`slatePoints` snapshot key — `document-store.ts` L301/L1052). **Not** a `.tinstar/slate`
file: the file-in path is the *agent/process* authoring channel; the objective is
*user*-owned and must survive the agent's file re-projections — which is exactly what
`source:'user'` guarantees (`slate.ts` `applyProjection` retracts only non-user points).

**Edit affordance:**
- Server: a new `PUT /api/runs/:id/slate/objective` (set/replace + nudge) and
  `DELETE /api/runs/:id/slate/objective` (clear, no nudge).
- Client: a new `ObjectiveSurface.tsx` — an inline-editable card (view mode shows the
  prose in `font-sans`; edit mode is a textarea with Save/Cancel), posting via `apiFetch`.

**Rationale:** the user needs an HTTP write path and an on-card editor; a file would
force the user to edit JSON on disk, which is the agent's channel, not a person's.

**Assumption:** no optimistic-vs-server-confirmed subtlety needed beyond the Slate's
existing pattern — the card reflects the server projection over SSE after save (with a
brief local "saving" state), same as the composer.

### (d) Exactly one per run — enforced structurally by the reserved id

**Decision:** Yes, exactly one. The reserved point id `objective`, scoped per run by the
store's composite `(runId, id)` key (`slate.ts` `k()`), makes a second objective
structurally impossible: a PUT always *amends* the same point. Editing = upsert-by-id.

**Assumption:** a `.tinstar/slate` file claiming id `objective` is defended against (the
watcher drops a file entry with the reserved id — see Risks / Unit 1), so a file cannot
hijack or clobber the user's objective.

---

## Implementation Units

Ordered so each is independently testable. A reserved-id constant is shared across
server and client.

### Unit 1 — Reserve the objective id; guard the file path

**Goal:** define the reserved id in one place and keep the agent's file-in path from
colliding with it.

**Files:**
- `src/domain/types.ts` — Modify: export `const OBJECTIVE_POINT_ID = 'objective'` (near
  the `Point`/`SlateSurface` types) so server + client share one literal.
- `src/server/sessions/slate-watcher.ts` — Modify: in `toPointInput`, drop a file entry
  whose `id === OBJECTIVE_POINT_ID` (return `null`, as it already does for schema-invalid
  entries) so a file cannot author/retract the user objective.
- `src/server/sessions/__tests__/slate-watcher.test.ts` — Test.

**Approach:** one exported constant; one early-return guard in the existing validator.

**Test scenarios:**
- A file entry with `id: "objective"` is dropped; sibling valid entries still project.
- A file with *only* an `objective` entry projects `[]` (treated as an unusable entry,
  consistent with the drop path) — it does not retain-forever or crash.

**Verification:** `env -u NODE_ENV npx vitest run src/server/sessions/__tests__/slate-watcher.test.ts --exclude='e2e/**'`.

### Unit 2 — Store: single-point delete mutator

**Goal:** allow clearing the objective without a file or a full prune.

**Files:**
- `src/server/stores/slate.ts` — Modify: add `deletePoint(runId, id)` — delete the
  composite key, emit a `{ data: null }` retract (reuse the `mutate`/prune emit shape);
  no-op if absent.
- `src/server/stores/document-store.ts` — Modify: add `deleteSlatePoint(runId, id)`
  wrapper that calls the store then `projectRunToSlate(runId)` (mirrors the other
  delegating mutators at L938–956).
- `src/server/stores/__tests__/slate.test.ts` — Test.

**Approach:** mirror `pruneRun`'s emit for a single id; mirror the thin delegating
wrappers already in `document-store.ts`.

**Test scenarios:**
- `deletePoint` removes only the targeted `(runId,id)`, emits one retract, leaves other
  runs' same-id points intact (cross-run key scoping).
- Deleting an absent point emits nothing.

**Verification:** `env -u NODE_ENV npx vitest run src/server/stores/__tests__/slate.test.ts --exclude='e2e/**'`.

### Unit 3 — Projection: derive the `objective` kind and pin it first

**Goal:** the reserved user point renders as kind `'objective'`, sorted to the top.

**Files:**
- `src/server/stores/document-store.ts` — Modify: in `projectRunToSlate`, compute
  `kind = (p.source === 'user' && p.id === OBJECTIVE_POINT_ID) ? 'objective'
  : p.anchor?.kind === 'surface' ? 'diagram' : 'open-point'`, and for the objective set
  `order = OBJECTIVE_ORDER` (a small finite sentinel, e.g. `-1`; **not** `-Infinity` —
  `JSON.stringify(-Infinity) === "null"` would corrupt the SSE payload).
- `src/domain/types.ts` — no change (`SlateSurface.kind` is already `string`).
- `src/server/stores/__tests__/document-store-slate-bridge.test.ts` — Test.

**Approach:** one branch in the existing `.map`; a finite order sentinel.

**Test scenarios:**
- A `source:'user'` point id `objective` projects with `kind:'objective'` and sorts
  before other surfaces regardless of createdAt.
- A `source:'file'` point that happens to have id `objective` (shouldn't occur post
  Unit 1, but assert defensively) does **not** get kind `objective`.

**Verification:** `env -u NODE_ENV npx vitest run src/server/stores/__tests__/document-store-slate-bridge.test.ts --exclude='e2e/**'`.

### Unit 4 — Prompt builder for the objective nudge

**Goal:** a delivered nudge that names the new objective and carries the guardrail.

**Files:**
- `src/slate/slatePrompt.ts` — Modify: add `slateObjectivePromptText(objective, origin)`
  — "The user set/updated this run's Objective: \"<oneLine(objective)>\". Keep your work
  aligned to it." + blank line + `GUARDRAIL`. `origin` kept for signature parity (no curl
  — the objective isn't a thread).
- `src/slate/__tests__/slatePrompt.test.ts` (or the existing slatePrompt test file if
  present) — Test.

**Approach:** mirror `slateExplainPromptText`/`slateRefreshPromptText`; reuse `oneLine`
and `GUARDRAIL`.

**Test scenarios:**
- Output contains the objective text collapsed to one line and the guardrail sentence.
- A multi-line/`SYSTEM:`-style objective is collapsed (no injected directive survives on
  its own line).

**Verification:** `env -u NODE_ENV npx vitest run --exclude='e2e/**'` (slatePrompt spec).

### Unit 5 — Routes: PUT/DELETE `/api/runs/:id/slate/objective`

**Goal:** set/replace (nudges) and clear (no nudge) the objective over HTTP.

**Files:**
- `src/server/api/routes.ts` — Modify: add two anchored-regex handlers placed **with the
  other `/slate/...` handlers, BEFORE the greedy `PATCH /api/runs/` handler** (the
  ordering invariant documented at L3286 and guarded by `routes.slate.test.ts`):
  - `PUT /api/runs/:id/slate/objective` — body `{ text: string }`; 404 if run absent;
    `INVALID_PARAMS` if `text` missing/blank; `413` if `> OBJECTIVE_MAX` (600). Calls
    `ctx.docStore.addUserSlatePoint(runId, { id: OBJECTIVE_POINT_ID, author: 'user',
    headline: text.trim() })`, then `const delivered = await deliverSlatePrompt(ctx,
    runId, slateObjectivePromptText(text.trim(), serverBase()))`. Returns
    `{ objective: point, delivered }`. (A byte-identical amend short-circuits in the
    store, returning the prior point; still deliver — an edit that changed nothing is
    rare and a re-nudge is harmless, OR skip delivery when `point === prior`; **decide:
    skip delivery on no-op** to match the store's no-emit posture.)
  - `DELETE /api/runs/:id/slate/objective` — 404 if run absent; calls
    `ctx.docStore.deleteSlatePoint(runId, OBJECTIVE_POINT_ID)`; returns `{ ok: true }`.
    No delivery (a clear is not an injection, mirroring the resolve/dismiss route).
- `src/server/api/__tests__/routes.slate.test.ts` — Test (pluginTest-style harness
  already in this file; `sendPrompt`/`getSession` are mocked so `delivered` is assertable).

**Approach:** copy the structure of the existing `/slate/points` + `/slate/points/:pid/
resolve|reopen|dismiss` handlers (regex on the query-stripped path, `readBody` for PUT,
`fail`/`ok` envelopes). `runId` IS the tmux session name for delivery.

**Test scenarios:**
- PUT with valid text: creates the objective point (`source:'user'`, id `objective`),
  `getSession` stubbed live → `sendPrompt` called once with the objective nudge →
  `delivered:true`.
- PUT again with **different** text: amends the same point (still one objective), nudges.
- PUT with **identical** text: no store change, `sendPrompt` **not** called (no-op skip).
- PUT blank / oversized: `INVALID_PARAMS` / `413`, nothing persisted, no nudge.
- PUT on unknown run: 404.
- `getSession` stubbed absent → `delivered:false`, still `200` (not an error).
- DELETE removes the objective from the run's projection; no `sendPrompt`.
- **Ordering guard:** assert the objective regex is registered ahead of the greedy PATCH
  (extend the existing ordering assertion pattern in this test file).

**Verification:** `env -u NODE_ENV npx vitest run src/server/api/__tests__/routes.slate.test.ts --exclude='e2e/**'`.

### Unit 6 — Client: the ObjectiveSurface card + panel dispatch

**Goal:** render the objective pinned at the top; let the user edit/clear it in place.

**Files:**
- `src/components/RunWorkspaceWidget/ObjectiveSurface.tsx` — Create: props `{ runId,
  surface }`. View mode: the prose (`surface.headline`) in `font-sans` (design: author
  prose never uses the display face), with a low-ink "Objective" mono label and an edit
  affordance. Edit mode: a textarea seeded from the current text, Save (PUT via
  `apiFetch`) / Cancel; a "clear" action issues DELETE. Show the unreachable note
  (`delivered:false`) as a quiet note, not an error (mirror the composer/SlatePanel).
- `src/components/RunWorkspaceWidget/SlatePanel.tsx` — Modify: extract
  `const objective = sorted.find(s => s.kind === 'objective')` and render it in a
  **dedicated pinned slot above the grid** (like the open-points extraction at
  `firstOpenPointIdx`); exclude it from the `.map`, from `openPoints`, and from the
  refresh/hide controls (it is user prose, not a refreshable authored surface). When the
  Slate is otherwise empty but an objective exists, the panel still renders (objective
  holds the column open — extend the `surfaces.length === 0 && !open` early return).
- `src/components/RunWorkspaceWidget/__tests__/SlatePanel.test.tsx` and a new
  `__tests__/ObjectiveSurface.test.tsx` — Test.

**Approach:** model the card on `DiagramSurface.tsx` (shell already provided by the panel
map for non-objective kinds; the objective gets its own pinned wrapper so it never scrolls
under other surfaces). Reuse the composer's `apiFetch` + submitting/error/unreachable
state shape. Design tokens per `docs/slate-design-language.md` (hairline border, card
`surface.raised`, cyan only on the live edge; a save-in-flight glow is optional and
minor).

**Test scenarios (jsdom/vitest, `apiFetch` mocked):**
- Given a `kind:'objective'` surface, the panel renders it above the grid, once, not in
  the open-points list.
- Edit → Save issues `PUT /api/runs/<id>/slate/objective` with the typed text.
- Clear issues `DELETE`.
- `delivered:false` response shows the quiet unreachable note.
- A panel with only an objective (no other surfaces) still renders (doesn't early-return
  to null).

**Verification:** `env -u NODE_ENV npx vitest run src/components/RunWorkspaceWidget --exclude='e2e/**'`.

### Unit 7 — Full typecheck + suite

**Goal:** the whole thing compiles and the Slate suite is green.

**Verification:**
- `env -u NODE_ENV npx tsc --noEmit -p tsconfig.app.json`
- `env -u NODE_ENV npx vitest run --exclude='e2e/**'`
- (CI parity note from repo memory: `npm run typecheck` compiles 3 tsconfigs; the
  app-only check above can miss broken *test* imports. If the environment allows, run
  the full `npm run typecheck` before finishing.)

---

## Scope Boundaries

- **Does not** add a `RunData` field — the objective rides the existing `RunData.slate`
  array. (This is the deliberate way around the 3-place / silent-failure trap.)
- **Does not** add agent/file authoring of the objective; the watcher actively *rejects*
  a file objective (Unit 1). If agent-seeded objectives are wanted later, that's a
  follow-up (relax the guard + a dedicated seed field).
- **Does not** version bump, touch the launch-prompt path, or alter `/slate/points`,
  `/compose`, `/refresh`, `/explain`, or the open-points/diagram renderers.
- **Does not** add multiplayer conflict handling; last write wins (single-user posture,
  same as every other Slate mutation today).
- **One PR, squash-merged.**

## Risks

- **Reserved-id collision (primary).** A `.tinstar/slate` file authoring id `objective`
  could, without a guard, merge into the user's objective and (as a file point) become
  retractable. *Mitigation:* Unit 1 drops file entries with the reserved id; Unit 3
  gates the `objective` kind on `source === 'user'`. Both are unit-tested. *Residual:* a
  client calling `POST /slate/points` with id `objective` would create a user point that
  renders as an objective but wouldn't nudge — harmless (same data), and not an exposed
  affordance.
- **`order` sentinel serialization.** Using `-Infinity` for pin-first ordering would
  serialize to `null` over SSE and mis-sort. *Mitigation:* a finite sentinel (`-1`) plus
  the client extracting the objective into a dedicated slot rather than relying on sort
  alone (Unit 3 + Unit 6).
- **No-op edit re-nudging.** A save that didn't change the text should not spam the agent.
  *Mitigation:* skip `deliverSlatePrompt` when the store amend returned the prior point
  unchanged (Unit 5), matching the store's zero-change short-circuit.
- **Route ordering regression.** A `/slate/objective` handler placed after the greedy
  `PATCH /api/runs/` would be shadowed and silently return 200. *Mitigation:* place it in
  the existing pre-PATCH `/slate/...` block and extend the ordering assertion in
  `routes.slate.test.ts` (Unit 5).
- **Injection via objective text.** A pasted `SYSTEM:`-style multi-line objective could
  try to inject directives into the delivered nudge. *Mitigation:* the prompt builder
  collapses via `oneLine()` and carries the `GUARDRAIL`, identical to every other Slate
  injection (Unit 4).
- **Empty-Slate rendering.** The panel currently returns `null` for zero surfaces; an
  objective must keep the column alive. *Mitigation:* Unit 6 extends the early-return
  condition and is covered by a panel test.
```
