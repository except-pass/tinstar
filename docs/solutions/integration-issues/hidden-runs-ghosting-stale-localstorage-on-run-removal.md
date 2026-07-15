---
title: Hidden-runs ghosting — reused session name born hidden from a stale localStorage entry
date: 2026-07-14
category: integration-issues
module: src/hooks/useHiddenRuns.ts + src/hooks/useServerEvents.ts (client) + src/components/WorkspaceShell.tsx + src/lib/windowEvents.ts
problem_type: integration_issue
component: frontend_stimulus
symptoms:
  - "A brand-new run appears grayed (opacity-50) in the hierarchy sidebar and never renders on the canvas, while the backend is fully healthy (tmux attached, ttyd serving, status=running)."
  - "Server state looks completely normal — /api/state, the SSE snapshot, and the docstore all show the run present and running; only the browser misbehaves."
  - "Reproducible only in a browser tab that had previously hidden a since-deleted run with the same name; a clean-localStorage browser shows the same run normally."
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [hidden-runs, localstorage, sse-delta, run-lifecycle, canvas-visibility, state-sync, ui-prefs, reused-session-name]
---

# Hidden-runs ghosting — reused session name born hidden from a stale localStorage entry

## Problem

Tinstar's per-run "hide from canvas" eyeball stores hidden run ids in a `localStorage` set (`tinstar-hidden-runs`, via `useHiddenRuns.ts`). A hidden run is filtered off the canvas (`WorkspaceShell.tsx`) and dimmed in the hierarchy sidebar (`HierarchySidebar.tsx`, `opacity-50`). The trap: **a run id is the reusable tmux session name, not a unique per-lifetime handle.** Nothing pruned an id from the set when its run was deleted, so `hide run X → delete X → later spawn a new run reusing the name X` left the new, healthy run born hidden. Because the set is client-only, every server-side view looked normal — only the browser holding the poisoned `localStorage` misbehaved.

## Symptoms

- A new run renders grayed in the hierarchy sidebar and never appears on the canvas, despite a healthy backend (tmux/ttyd/status all fine).
- No server error, no missing entity, no bad SSE frame — the run object is present and correct in state; it is silently pruned client-side by the canvas visibility filter.
- Reproduces only in the browser tab(s) that previously hid a since-deleted same-named run.

## What Didn't Work

- **Pruning at run *registration*.** Tempting: when a run delta arrives with an id already in the hidden set, drop it. But an id-only guard at registration cannot distinguish *a legitimately-hidden run reloading* (snapshot on refresh — must stay hidden) from *a new spawn reusing a dead name* (must be shown). Telling them apart would require storing a hide-*timestamp* and comparing to the run's creation time — real added state and a new failure surface. Rejected.
- **App-only typecheck masked a broken test.** `npx tsc --noEmit -p tsconfig.app.json` passed clean, but CI's full `npm run typecheck` (three tsconfig projects: app + e2e + test) failed on a type error in the guard *test file* — the app config excludes the test project. The app-only check is a false "green."
- **`git checkout <file>` mid-verification silently reverted uncommitted work.** While guard-testing (backing the fix out to confirm the test fails), a `git checkout` to restore the file wiped *uncommitted* refactor work in that same file. Use `git stash` or a scratch branch for revert-and-confirm — never `git checkout` over live uncommitted changes.

## Solution

Prune the stale id at run **removal** — the one universal, cross-tab signal every browser receives via the SSE `run-removed` delta, and which the server emits *before* re-creating anything with a reused name.

Keep the SSE reducer `applyDelta` **pure** by hoisting the `localStorage` write to a discrete side-effect at the call site (`useServerEvents.ts`):

```ts
// in the SSE 'delta' handler
currentState = applyDelta(currentState, delta)
pruneHiddenForRemoval(delta)   // side-effect, OUTSIDE the pure reducer
pushState()

export function pruneHiddenForRemoval(delta: { entity: string; id: string; data: unknown }): void {
  if (delta.entity === 'run' && delta.data === null) {
    removeHiddenRunId(delta.id)  // no-op for a marshal delete or an absent id
  }
}
```

`removeHiddenRunId` mutates `localStorage` outside React and fires a **same-tab** custom window event — the native `storage` event only fires in *other* tabs (`useHiddenRuns.ts`). The event is registered in the typed `windowEvents.ts` registry per project convention:

```ts
export function removeHiddenRunId(runId: string): void {
  const ids = readFromStorage()
  if (!ids.delete(runId)) return                        // cheap no-op if absent
  writeToStorage(ids)
  dispatchWindowEvent(EV.hiddenRunsChanged, undefined)  // same-tab re-read signal
}

// the hook subscribes to BOTH signals:
window.addEventListener('storage', onStorage)                                // OTHER tabs
useWindowEvent(EV.hiddenRunsChanged, () => setHiddenIds(readFromStorage()))  // THIS tab
```

`WorkspaceShell.handleDelete` (run branch) also prunes optimistically (`removeRunHidden(entityId)`) before the `DELETE` fetch, so the acting browser doesn't wait for the SSE round-trip; the run-removed delta then prunes universally as an idempotent no-op.

The hidden-runs key stays a `familyKeys` entry read/written through `src/lib/uiPrefs.ts` (`readJSON`/`writeJSON`) — the pruning path respects that single-source pref layer rather than poking `localStorage` directly.

## Why This Works

Root cause: **run id == reusable session name.** The bug exists only because a name outlives the run instance that owned it. Removal is exactly the moment the old instance ceases to exist, and the server orders the removed-delta *before* it re-creates anything with that name — so there is no window in which a reused name can inherit the stale flag. It is cross-tab (every browser gets the delta), needs no extra stored state (no timestamps), and keeps the reducer pure (the storage write is a call-site side-effect, so `applyDelta` stays `state -> state`).

## Prevention

- **Any new per-run-id `localStorage` family must prune on `run-removed`.** The reusable-name hazard is structural, not specific to hidden-runs — hook a `pruneHiddenForRemoval`-style side-effect at the SSE delta call site for each new per-run family.
- **Keep SSE reducers pure.** `applyDelta` is `state -> state` only; `localStorage`/DOM side-effects live at the call site so the reducer stays testable.
- **Same-tab state mutated by a non-React writer needs a custom window event** registered in `windowEvents.ts` — the native `storage` event never fires in the writing tab.
- **Run the full `npm run typecheck`, not app-only `tsc -p tsconfig.app.json`** — the app config excludes the test project; CI's multi-tsconfig pass catches what the app-only check silently skips.
- **Never treat a run id as unique over time**, and never `git checkout <file>` to undo a guard-test revert (it discards uncommitted work — use `git stash`).
- **Ship guard tests that fail when the fix is reverted** — assert `pruneHiddenForRemoval` drops the id on a `run`/`null` delta and no-ops for a marshal delete or absent id; assert `applyDelta` does not touch `localStorage` (purity guard).

## Related Issues

- [SSE run-delta drops undefined keys, so client spread-merge inherits stale state forever](sse-delta-drops-undefined-keys-stale-client-state.md) — the sibling failure mode on the same `useServerEvents.ts` run-delta seam. That doc fixed `mergeRun` (a cleared field never clears); this one hooks the run-*removed* delta to prune persisted client state. Together they establish the contract: keep delta-merge pure, and reconcile client state to run-lifecycle deltas at the call site.
- Shipped in PR #113.
