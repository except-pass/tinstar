---
title: "fix: Prevent hidden-runs ghosting when a session name is reused"
type: fix
date: 2026-07-14
status: planned
origin: none (solo bug report)
---

# fix: Prevent hidden-runs ghosting when a session name is reused

## Summary

A run's "hidden from canvas" state (the Figma-style eyeball) is stored per-run-id in
`localStorage` under `tinstar-hidden-runs`. Run ids are the human-chosen session **name**
(`run.id === sessionId === 'dj'`). Nothing ever removes an id from that set when the
session is deleted, so a hidden-then-closed session leaves its id behind forever. When a
new session reuses the name, it is **born hidden** — grayed in the hierarchy sidebar
(`opacity-50`) and filtered off the canvas — even though the session itself is perfectly
healthy (tmux attached, ttyd serving, `status: running`).

The fix prunes the hidden-set entry whenever a run is **removed**, using the SSE
`run-removed` delta as the universal removal signal. Because the server orders a removal
event before any later re-creation, a re-used name can never inherit the stale flag, in
any browser tab.

---

## Problem Frame

**Observed:** A freshly-spawned `dj` session appeared grayed in the hierarchy and absent
from the canvas. Backend was healthy in every respect; server state showed the run as
`running`, in the active space, `background: false`, `blocked: false`. The graying and
canvas-omission are driven entirely by the client-side `tinstar-hidden-runs` localStorage
set, which is invisible to server state — which is why the run looked fine on the server.

**Root cause:** `src/hooks/useHiddenRuns.ts` persists a `Set<string>` of hidden run ids to
localStorage. The only mutator is `toggleHidden` (the eyeball click). There is **no
pruning path** on session/run deletion — grep of every delete/stop/cleanup route confirms
nothing removes an id from the set. Run ids are name-derived and names are reused, so a
stale id silently poisons a future same-named run:

1. User hides session `dj` (id `dj` → `tinstar-hidden-runs`).
2. User closes session `dj`. Run is removed from state, but `dj` stays in the hidden set.
3. User later spawns a new session, names it `dj`. It gets id `dj`.
4. Canvas filter (`WorkspaceShell.tsx:421-437`) and hierarchy graying
   (`HierarchySidebar.tsx:357-359`) both see `dj` in the hidden set → new run is born
   hidden.

**Scope boundary:** This is a client-only localStorage lifecycle bug. No server, tmux,
NATS, or session-backend changes. The eyeball toggle behavior itself is unchanged — a run
the user actively hides stays hidden for its own lifetime.

---

## Key Technical Decisions

### KTD1 — Prune at run *removal*, not at run *registration*

Prune the hidden-set entry when a run is **removed** (the SSE `run-removed` delta,
`useServerEvents.ts:303`, `delta.data === null` branch), not when a run is registered.

**Rationale:** An id-only guard at *registration* time cannot distinguish two cases that
look identical by id: (a) a page reload re-hydrating a legitimately-hidden run, which must
stay hidden, versus (b) a new spawn reusing a dead session's name, which must not be
hidden. Distinguishing them at registration would require storing a hide-timestamp and
comparing against `run.createdAt` — a storage-schema change and migration, disproportionate
for this fix.

Removal time has no such ambiguity: when a run is removed, its hidden entry is
unconditionally stale (the session is gone). The server emits removal before any
re-creation, so by the time a same-named run is created the stale id is already pruned.
This is the "collision guard" done correctly — at the moment the collision source is
destroyed, not at the moment the victim appears.

**Wrong if:** the server ever emitted a run-created for a reused id *before* the
run-removed for the old one. It does not — deletes and creates are distinct, ordered bus
events.

### KTD2 — The SSE `run-removed` handler is the universal, cross-tab prune point

Every removal path — the user's own delete, a session dying, a delete from another
browser, a server-driven cleanup — converges on the `run-removed` SSE delta, which every
connected tab processes. Pruning there fixes all removal paths in all tabs with one hook,
rather than only the acting browser's `handleDelete` (localStorage is per-browser, so a
`handleDelete`-only prune would leave a second tab's stale entry intact — the original
cross-browser gap).

**Bridge:** `useServerEvents` is a state reducer and does not own the localStorage set. Add
a standalone storage helper `removeHiddenRunId(id)` exported from `useHiddenRuns.ts` that
does a localStorage read-modify-write and dispatches a same-tab
`tinstar-hidden-runs-changed` window event. The `useHiddenRuns` hook subscribes to that
event (alongside the existing cross-tab `storage` listener) so its in-memory `Set` stays
in sync when the reducer prunes.

### KTD3 — Optimistic prune in the acting browser's `handleDelete`

Also call the prune from `WorkspaceShell.handleDelete` (run branch) so the acting browser
drops the id immediately, without waiting for the SSE round-trip. Defense-in-depth and
snappier; the SSE handler (KTD2) remains the authoritative, universal path.

---

## Implementation Units

### U1. Add removal mutators + same-tab sync to `useHiddenRuns`

**Goal:** Give the hidden-runs store a way to remove a single id, both as a React callback
(for `handleDelete`) and as a standalone function (for the non-React SSE reducer), with
same-tab state sync.

**Files:**
- `src/hooks/useHiddenRuns.ts` (modify)
- `src/hooks/__tests__/useHiddenRuns.test.ts` (create)

**Approach:**
- Add a module-level `removeHiddenRunId(runId: string): void` that reads the set from
  storage, deletes the id, writes it back, and dispatches a
  `new CustomEvent('tinstar-hidden-runs-changed')` on `window`. Make it a no-op write when
  the id was not present (avoid needless writes/events).
- In the hook, add a same-tab listener for `tinstar-hidden-runs-changed` that re-reads from
  storage into state (mirrors the existing cross-tab `storage` listener at lines 28-35).
- Expose a `removeHidden(runId)` callback from the hook that calls `removeHiddenRunId` (so
  React consumers and the standalone reducer share one code path and one event).
- Leave `toggleHidden` semantics unchanged.

**Patterns to follow:** existing `readFromStorage` / `writeToStorage` / `toggleHidden`
structure in the same file; the cross-tab `storage` effect for the listener shape.

**Test scenarios** (`useHiddenRuns.test.ts`):
- `toggleHidden` still adds then removes an id (regression guard on unchanged behavior).
- `removeHiddenRunId('dj')` on a stored set containing `dj` removes it from
  `localStorage` — **guard test: fails if the stale id survives** (this is the core
  regression the whole fix exists to prevent).
- `removeHiddenRunId` on an id **not** present leaves storage unchanged and does not throw.
- Dispatching `tinstar-hidden-runs-changed` causes a mounted hook to re-read and reflect
  the removal in `hiddenIds` (same-tab sync).
- `removeHidden` callback from the hook removes the id and updates `hiddenIds`.

**Verification:** New unit test file passes; the guard test fails if U1's removal logic is
reverted.

### U2. Prune the hidden entry on the SSE `run-removed` delta

**Goal:** Every run removal (any source, any tab) prunes that run's hidden-set entry.

**Dependencies:** U1.

**Files:**
- `src/hooks/useServerEvents.ts` (modify — the `delta.entity === 'run' && delta.data === null`
  branch around line 303)
- `src/hooks/__tests__/useServerEvents.*.test.ts` or a focused new test targeting the run-removed reducer (create/modify — match the existing test location convention for this hook)

**Approach:** In the regular-run-delete branch (the `return { ...prev, runs: prev.runs.filter(...) }`
line), call `removeHiddenRunId(delta.id)` as a side-effect before/around returning the new
state. Do **not** prune in the marshal-delete branch (marshal is never a user-hideable run).
Keep the reducer's returned state pure; the localStorage mutation is an intentional,
idempotent side-effect on delete only.

**Patterns to follow:** the existing run-removed branch; import the standalone helper from
`useHiddenRuns`.

**Test scenarios:**
- Feeding a `run-removed` delta (`entity: 'run', data: null, id: 'dj'`) when `dj` is in the
  hidden set prunes `dj` from storage — **guard test: fails if a stale id survives a
  delete** (the acceptance test named in the request).
- A `run-removed` for the **marshal** id does not attempt to prune / does not throw.
- A `run-removed` for an id **not** in the hidden set is a safe no-op.

**Verification:** Simulated delete removes the id from `tinstar-hidden-runs`; a subsequent
same-name run created via a run-added delta is not in the hidden set → renders visible.

### U3. Optimistic prune in `WorkspaceShell.handleDelete`

**Goal:** The acting browser drops the id immediately on delete, before the SSE round-trip.

**Dependencies:** U1.

**Files:**
- `src/components/WorkspaceShell.tsx` (modify — `handleDelete`, `src/components/WorkspaceShell.tsx:554`)

**Approach:** In `handleDelete`, when the deleted entity `type` is a run, call the
`removeHidden(entityId)` callback from `useHiddenRuns` (already destructured at
`src/components/WorkspaceShell.tsx:202`) alongside the existing
`apiFetch('/api/runs/${entityId}', { method: 'DELETE' })`. Idempotent with U2 — the SSE
delta prune that follows is a harmless no-op once already removed.

**Patterns to follow:** the existing `handleDelete` run branch and its `apiFetch` call.

**Test scenarios:** `Test expectation: none — thin optimistic wiring; behavior is covered
by U1 (removeHidden) and U2 (universal prune) tests.` Verify by inspection that the run
branch calls `removeHidden`.

**Verification:** Deleting a hidden run in the UI removes it from the sidebar with no
lingering grayed ghost, and re-creating a same-named session renders it visible on the
canvas immediately.

---

## Risks & Dependencies

- **R1 — Same-tab event sync:** DOM `storage` events do not fire in the tab that wrote the
  change, so the standalone `removeHiddenRunId` must dispatch the custom
  `tinstar-hidden-runs-changed` event for the hook to update in the same tab. Covered by a
  U1 test. If omitted, the acting tab's in-memory set would lag until reload (the run would
  still be correctly un-hidden after any re-render that re-reads, but the immediate update
  would be missed).
- **R2 — Reducer purity:** U2 adds a localStorage side-effect inside a state reducer.
  Acceptable because it is idempotent and scoped to the delete branch, but keep the
  returned state object pure (no reliance on the side-effect for state correctness).
- **Dependency:** U2 and U3 both depend on U1's exported helper/callback. Land U1 first.

---

## Test / Verification Strategy

Run type-check and unit tests per `docs/testing.md`:
- Type check: `npx tsc --noEmit -p tsconfig.app.json` (root tsconfig is a no-op — see CLAUDE.md).
- Unit: vitest with `--exclude='e2e/**'`, prefixed with `env -u NODE_ENV` if `NODE_ENV=production` is set in the shell.

The two named guard tests (U1 `removeHiddenRunId` prune, U2 `run-removed` delta prune) are
the acceptance criteria — each must fail when its production change is reverted.

Manual runtime check (optional, per test-before-done discipline): hide a run, delete it,
re-create a same-named session, confirm it renders visible on the canvas and un-grayed in
the hierarchy.
