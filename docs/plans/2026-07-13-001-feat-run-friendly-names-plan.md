---
date: 2026-07-13
type: feat
origin: docs/brainstorms/2026-07-13-run-friendly-names-requirements.md
---

# feat: Run friendly names

## Summary

Add an optional `name` field to a run — free text, display-only, falling back to the run id when unset. Every surface that renders a run id renders the name instead. Renaming happens through the sidebar's existing inline-edit (today explicitly guarded off for runs) and through the run card header title, both landing on `PATCH /api/runs/:id` with an optimistic update. The run id stays immutable.

---

## Problem Frame

The run id is load-bearing infrastructure: it is the tmux session name, the worktree directory, the git branch, the trailing token of the run's NATS subject, and the key under which widget layouts, pins, and constellations are stored. It is typed once at creation and can never be corrected, because correcting it would mean moving a worktree, renaming a branch, and re-keying a broker subject.

So ids rot. Typos are permanent. Hand-spawned runs are named by concatenating parent name, hand role, and a random suffix, so a hand of a hand inherits the whole chain. The fleet becomes a wall of near-identical slugs.

The fix is a parallel display field. It gets the whole benefit at none of the migration risk.

---

## Requirements Trace

All requirements are carried from the origin document (see origin: `docs/brainstorms/2026-07-13-run-friendly-names-requirements.md`).

| Requirement | Covered by |
|---|---|
| R1 free text, not id-sanitized | U1, U2 |
| R2 falls back to id | U1, U3 |
| R3 persists across restart | U1 |
| R4 never changes id/tmux/worktree/branch/subject | U2 (guard), all units |
| R5 all display surfaces | U3, U4 |
| R6 id reachable from card header | U4 |
| R7 id on sidebar hover | U3 |
| R8 tombstone carries the name | U6 |
| R9 sidebar inline rename | U3 |
| R10 rename from card header | U4 |
| R11 optimistic update | U1, U3, U4 |
| R12 clearing reverts to id | U1, U2, U3 |
| R13 hand named at spawn | U5 |
| R14 skill nudge | U5 |
| R15 agents use the same interface | U2, U5 |

---

## Key Technical Decisions

**The field is `name?: string` on `RunData`, and three places must learn about it — not one.** Adding a field to `RunData` looks like a one-line change and is not. The docstore short-circuits its change emit through `runShallowEqual` (`src/server/stores/document-store.ts:99`), a hand-written field-by-field comparison. A field absent from that function is a field whose mutation is judged "no change," so `upsertRun` never emits, no SSE delta goes out, and the rename never reaches any client. The optimistic update would paint it locally and hide the failure. Separately, the client's `mergeRun` (`src/hooks/useServerEvents.ts:306`) spread-merges the incoming run over the previous one — and `JSON.stringify` drops `undefined` keys from the SSE payload, so a *cleared* name has nothing to overwrite with and the stale name survives forever. This is the exact bug that bit `attention`, documented in `docs/solutions/integration-issues/sse-delta-drops-undefined-keys-stale-client-state.md`. The checklist is: `RunData` → `runShallowEqual` → `mergeRun`. All three, same commit.

**The run id remains the only identity.** No route, subject, socket path, or storage key learns about the friendly name. Names are not unique and nothing resolves one back to a run. This is what makes the field cheap: no collision suffixes, no uniqueness check, no rename-safety story.

**Clearing the name is a first-class operation, not an afterthought.** R12 says an empty name reverts to the id. That path is the one that breaks (see above), so it gets explicit test coverage at the delta layer rather than only at the unit level.

**The tombstone gets its own field; `sessionName` is not reused.** `Tombstone.sessionName` feeds `reviveName()` at `src/server/sessions/necro.ts:78` — it is the handle used to re-materialize a retired session. Overloading it with a display string would break revive. The friendly name is snapshotted into a separate optional field at retire time, or the graveyard shows bare ids forever.

**Hand naming is a skill nudge, not an API requirement.** The spawn endpoint accepts an optional friendly name. Making it required would break every existing caller and turn a cosmetic omission into a hard failure.

---

## High-Level Technical Design

The write path, and the two short-circuits that silently eat the change if the field isn't registered with them:

```mermaid
flowchart TD
    A[Sidebar inline-edit / Card header title] -->|PATCH /api/runs/:id {name}| B[routes.ts run PATCH]
    A -.->|addOptimistic 'run'| F[Client state]
    B --> C[docStore.upsertRun]
    C --> D{runShallowEqual}
    D -->|equal: no emit| X[DEAD END — rename never broadcasts]
    D -->|differs| E[change event → SSE]
    E --> G{mergeRun spread}
    G -->|name absent from payload| Y[DEAD END — cleared name never clears]
    G -->|name read explicitly| F
    C --> H[snapshotAll → disk]

    style X fill:#7f1d1d,color:#fff
    style Y fill:#7f1d1d,color:#fff
```

Both dead ends are live today for any new `RunData` field. U1 exists to close them.

---

## Implementation Units

### U1. Add the `name` field and register it with the two short-circuits

**Goal:** A run can carry an optional friendly name that persists, broadcasts on change, and clears correctly.

**Requirements:** R1, R2, R3, R11, R12.

**Dependencies:** none.

**Files:**
- `src/domain/types.ts` — add `name?: string` to `RunData`.
- `src/server/stores/document-store.ts` — add the `name` comparison to `runShallowEqual`.
- `src/hooks/useServerEvents.ts` — read `name` explicitly in `mergeRun`.
- `src/server/stores/__tests__/document-store.test.ts` — emit-on-rename coverage.
- `src/hooks/__tests__/useServerEvents.test.ts` — delta set→clear coverage.

**Approach:** The field is optional and free-form; no sanitization. `runShallowEqual` gets `if (a.name !== b.name) return false` alongside the existing RunData field comparisons. `mergeRun` gets `name: next.name` alongside the existing `attention: next.attention` line — absent key means cleared, same semantics, same reason. Persistence and boot rehydrate need no change: the docstore serializes the run wholesale, and the boot path spreads the existing run record rather than rebuilding it.

**Patterns to follow:** The `attention` field is the exact precedent in both files — it is the field that taught this codebase the lesson. Mirror its treatment line-for-line.

**Test scenarios:**
- Setting a name on a run emits a change event. (Guards the `runShallowEqual` short-circuit; this test fails without the added comparison.)
- Changing a name from one value to another emits a change event.
- Re-upserting a run with an unchanged name emits nothing.
- Covers AE4. A run delta whose payload omits `name` clears a previously-set name on the client, rather than inheriting it. (Guards the `mergeRun` undefined-drop; assert at the `applyDelta` layer with a real serialized payload, not a hand-built object with the key present.)
- A run delta carrying a name applies it to the client run.
- A name survives a docstore snapshot/hydrate round-trip.

---

### U2. Accept and validate `name` on the run PATCH route

**Goal:** `PATCH /api/runs/:id` accepts a friendly name, from a human or an agent, and refuses to touch the id.

**Requirements:** R1, R4, R12, R15.

**Dependencies:** U1.

**Files:**
- `src/server/api/routes.ts` — the run PATCH handler.
- `src/server/api/openapi.ts` — document `name` in the run PATCH schema.
- `src/server/api/__tests__/runs-route.test.ts` — route coverage.

**Approach:** The handler is already a catch-all merge, so a `name` key lands and persists without a new endpoint — but it is undocumented in the OpenAPI schema, which today lists only `taskId`, `attention`, and `background`. Add it. Read the body through the shared `readBody` helper (`src/server/api/readBody.ts`), which decodes once via `Buffer.concat` — this matters here specifically, because a friendly name is exactly the user-typed field that carries multibyte UTF-8, and a chunk-wise `data += chunk` reader corrupts characters that straddle a chunk boundary. An empty string or explicit null clears the name. Nothing in this handler may write to `run.id`.

**Patterns to follow:** `PATCH /api/projects/:name` (shipped in PR #107) is the same shape — read it before writing this. Body reading follows the convention in `docs/solutions/conventions/reuse-readbody-for-request-bodies.md`.

**Test scenarios:**
- Covers AE7. A PATCH with `name: "PM: Vpp project (Q3)"` persists the string verbatim — colon, spaces, and parentheses intact, no sanitization.
- A name containing multibyte UTF-8 (emoji, accents) round-trips without corruption.
- Covers AE3. After a rename, the run's `id`, `sessionId`, and `worktree` are byte-identical to their pre-rename values.
- Covers AE4. A PATCH with an empty-string name clears the field, and the run reads back with no name.
- A PATCH that omits `name` entirely leaves an existing name untouched (partial-merge semantics preserved).
- A malformed JSON body fails with a `BAD_REQUEST` rather than throwing.

---

### U3. Render the name in the sidebar and unlock inline rename

**Goal:** The hierarchy sidebar shows friendly names, keeps the id on hover, and lets a run be renamed in place.

**Requirements:** R2, R5, R7, R9, R11, R12.

**Dependencies:** U1, U2.

**Files:**
- `src/domain/grouping.ts` — run label falls back from name to id, in all three tree-build paths.
- `src/components/HierarchySidebar.tsx` — drop the run guard in `commitRename`; expose the run id on hover; allow the kebab/pencil affordances for runs.
- `src/components/WorkspaceShell.tsx` — extend `handleRename` to route runs to the run PATCH with an optimistic update.
- `src/widgets/taskGroup/TaskGroupWidget.tsx` — consumes the same node label; verify no change needed.
- `src/domain/__tests__/grouping.test.ts` — label fallback coverage.
- `src/components/__tests__/HierarchySidebar.test.tsx` — rename interaction coverage.

**Approach:** `grouping.ts` sets `label: run.id` in three separate tree-build paths — all three become `run.name || run.id`. Prefer `||` over `??` so an empty-string name falls back to the id rather than rendering blank; this is what makes R12 work at the display layer. `HierarchySidebar.commitRename` currently returns early for `node.type === 'run'`; removing that guard reuses the inline-edit the taxonomy entities already have (Enter commits, Escape cancels, blur commits). `handleRename` in `WorkspaceShell` dispatches PATCH by entity type — runs get a branch to the run route, and unlike the taxonomy entities it calls `addOptimistic('run', …)` so the rename paints on keypress rather than waiting for the SSE echo. The optimistic hook already maps the run entity; this is wiring, not new machinery.

**Patterns to follow:** The existing taxonomy rename in `HierarchySidebar` and `handleRename` in `WorkspaceShell`. The optimistic path follows `addOptimistic` as already used for widgets.

**Test scenarios:**
- Covers AE1. A run with no name produces a sidebar label equal to its id.
- Covers AE2. A run with a name produces a sidebar label equal to the name.
- A run whose name is the empty string falls back to the id, not a blank label.
- Covers AE2. Committing a rename on a run node fires the run PATCH with the typed name. (This test fails today because of the guard — it is the direct regression test for removing it.)
- Escape during an inline rename leaves the run's name unchanged and fires no request.
- Covers AE2. A committed rename updates the displayed label before the server responds.
- Covers AE1. Renaming a taxonomy entity still routes to its own endpoint, not the run route.

---

### U4. Show the name in the run card header, demote the id

**Goal:** The run card header leads with the friendly name and keeps the id reachable.

**Requirements:** R5, R6, R10, R11.

**Dependencies:** U1, U2.

**Files:**
- `src/components/RunWorkspaceWidget/RunWorkspaceHeader.tsx`
- `src/components/RunWorkspaceWidget/__tests__/RunWorkspaceHeader.test.tsx`

**Approach:** The header renders `Run_{run.id}` as its title today. The title becomes the friendly name (falling back to the id), editable by clicking it. Beneath it sits the raw id in a muted line that copies to the clipboard on click — this is the affordance that keeps `tmux attach` and `cd` into the worktree possible once the id stops being the headline. The rename submits through the same PATCH the sidebar uses.

**Patterns to follow:** The color-picker in this same component already does an in-place `PATCH /api/runs/:id` — it is the nearest precedent for editing a run field from the header. The UI philosophy in `CLAUDE.md` applies: the rename paints immediately, no spinner.

**Test scenarios:**
- Covers AE1. A run with no name renders its id as the header title.
- Covers AE2. A run with a name renders the name as the header title.
- Covers AE3. The raw id is present in the header regardless of whether a name is set.
- Clicking the id line writes the id — not the friendly name — to the clipboard.
- Covers AE2, AE3. Committing a header rename fires the run PATCH and leaves the id line unchanged.
- Covers AE4. Submitting an empty name reverts the title to the id.

---

### U5. Name hands at spawn, and tell the spawning agent to do it

**Goal:** A hand is born with a decent name, because the agent that spawned it knew what it was for.

**Requirements:** R13, R14, R15.

**Dependencies:** U1, U2.

**Files:**
- `src/server/api/routes.ts` — the hand spawn handler accepts an optional friendly name.
- `src/server/api/openapi.ts` — document it on the spawn schema.
- `agent-skills/tinstar-hand/SKILL.md` — the naming nudge.
- `src/server/api/__tests__/spawn-route.test.ts` — spawn-with-name coverage.

**Approach:** The spawn handler generates the session name by concatenation (parent, role, random suffix) — that stays exactly as it is, because it produces the id. An optional friendly name in the spawn body is written onto the new run at creation, so the hand never renders its generated id. Omitting it is not an error; the hand falls back to the id like any other run. The `tinstar-hand` skill gains a short instruction telling the spawning agent to pass a name describing the hand's job. If the skill text includes a request snippet, it must derive the backend URL from `TINSTAR_DASHBOARD_URL` — that is the only URL variable injected into a managed session's environment, per `docs/solutions/conventions/agent-skill-backend-url-env-var.md`. Do not build it from a port.

**Patterns to follow:** The existing spawn handler's optional-field handling. Skill-file conventions in `agent-skills/`.

**Test scenarios:**
- Covers AE5. Spawning a hand with a friendly name creates a run carrying that name, while the session id keeps its generated concatenated form.
- Covers AE6. Spawning a hand without a friendly name succeeds, and the run has no name.
- Covers AE3, AE5. A spawned hand's tmux session name and worktree derive from the generated id, never from the friendly name.

---

### U6. Carry the name onto the tombstone

**Goal:** A retired run stays recognizable in the graveyard.

**Requirements:** R8.

**Dependencies:** U1.

**Files:**
- `src/domain/types.ts` — add an optional friendly-name field to `Tombstone`.
- `src/server/api/routes.ts` (or the retire path that builds the tombstone) — snapshot the run's name at retire time.
- `src/plugins/graveyard/src/GraveyardWidget.tsx` — render the name, falling back to `sessionName`.
- `src/server/api/__tests__/graveyard-route.test.ts` — retire-path coverage.

**Approach:** `Tombstone.sessionName` is the identity handle — `reviveName()` at `src/server/sessions/necro.ts:78` uses it to re-materialize the session. It must not be overloaded with a display string. Add a separate optional field and snapshot the run's name into it at retire time; a tombstone built before this change simply has no name and falls back, as everywhere else. The graveyard is a plugin, so render through the existing generic endpoint rather than adding a bespoke graveyard route.

**Patterns to follow:** Existing tombstone construction in the retire path. The `name || sessionName` fallback mirrors the `name || id` fallback used everywhere else.

**Test scenarios:**
- Covers AE1. Retiring a run with a friendly name produces a tombstone carrying that name.
- Retiring a run with no friendly name produces a tombstone with no name, and the graveyard renders `sessionName`.
- Covers AE3. Reviving a tombstone still resolves through `sessionName`, unaffected by the presence of a friendly name.

---

## Remaining Display Surfaces

R5 names surfaces beyond the sidebar and card header. Each is a one-line fallback change and does not warrant its own unit; fold them into U3 and verify each renders the name:

- `src/hooks/useInbox.ts` — `sourceLabel` currently `run.id`.
- `src/plugins/roborev/src/FleetView.tsx` — row label.
- `src/plugins/nats-traffic/src/Saloon.tsx` — bound-session header.
- `src/components/CanvasHud/AgentAvatar.tsx` — tooltip. **Do not change the avatar seed** — it is seeded from `run.id`, and reseeding from the name would make every agent's face change when it is renamed.

---

## Scope Boundaries

**Not in scope**

- Deriving names automatically — from the task name, from the opening prompt, or from a model call. Rejected in the brainstorm.
- Uniqueness enforcement, collision suffixes, or "name already taken" errors.
- Looking a run up by friendly name. Routes, subjects, and session commands stay id-keyed.
- Changes to id generation or the New Session dialog's single-name field.
- Telemetry. The Prometheus `tinstar_session` label and OTEL resource attributes stay keyed by the id so historical series stay continuous.

**Deferred to follow-up work**

- Search or filter across runs by friendly name. Nothing today lists runs by name, so there is no surface to add it to.

---

## Risks

**The silent-emit trap.** The single highest risk in this plan is shipping the `RunData` field without registering it in `runShallowEqual` and `mergeRun`. The failure is invisible in local testing because the optimistic update paints the rename correctly — the break only shows on a second client, or after a reload. U1's first and fourth test scenarios exist specifically to fail loudly if either registration is missed.

**Empty-string vs undefined.** Two clearing representations exist (empty string from the input, `undefined` on the server). Display fallbacks use `||` rather than `??` so both fall back to the id. A `??` anywhere in the display path renders a blank label for an empty-string name.

**Avatar reseeding.** `agentIcon` / the procedural avatar is seeded from `run.id`. Any well-meaning "use the display name" change there silently rerolls every agent's face on rename.

---

## Verification

- Type check with `npx tsc --noEmit -p tsconfig.app.json`. The root tsconfig is a no-op — see `CLAUDE.md`.
- Unit tests with vitest, excluding `e2e/**`.
- This machine exports `NODE_ENV=production`, which prunes devDependencies on install and produces spurious React `act(...)` failures. Prefix toolchain commands with `env -u NODE_ENV` (see `docs/solutions/developer-experience/node-env-production-prunes-devdependencies.md`).
- Any e2e touching the rename endpoint must use the `pluginTest` fixture, not the default `test` — the default sets `TINSTAR_NO_SESSIONS=1` and session-scoped `/api` routes return SPA HTML under it (see `docs/solutions/test-failures/e2e-session-scoped-api-routes-return-spa-html.md`).
- The `PATCH /api/runs/:id` name field will not be live on the running standalone at :5273 until the bundle is rebuilt and the process restarted. Do not restart the user's server; defer live route smoke to them.

---

## Sources & Research

- Origin: `docs/brainstorms/2026-07-13-run-friendly-names-requirements.md`.
- `docs/solutions/integration-issues/sse-delta-drops-undefined-keys-stale-client-state.md` — the `attention` bug this feature would otherwise repeat verbatim.
- `docs/solutions/conventions/reuse-readbody-for-request-bodies.md` — body-reading convention; the multibyte-UTF-8 argument applies directly to a user-typed name.
- `docs/solutions/conventions/agent-skill-backend-url-env-var.md` — `TINSTAR_DASHBOARD_URL` is the only URL var reaching a managed session.
- `docs/solutions/test-failures/e2e-session-scoped-api-routes-return-spa-html.md` — the `pluginTest` fixture requirement; also the precedent PR (#107) for `PATCH /api/projects/:name`.
- `docs/solutions/developer-experience/node-env-production-prunes-devdependencies.md` — `env -u NODE_ENV`.
- `docs/conventions.md` — docstore mutator rules, including the `runShallowEqual` equality short-circuit and the preserve-array-references rule for `upsertRun` callers.
- `src/server/sessions/necro.ts` — `reviveName()`, which establishes `Tombstone.sessionName` as an identity handle rather than a display string.
