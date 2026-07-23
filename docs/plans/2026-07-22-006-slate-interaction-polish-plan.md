# Slate interaction & affordance polish (S6) — Implementation Plan

**Date:** 2026-07-22 · **Slug:** `2026-07-22-006-slate-interaction-polish` · **Delivery:** one squash-merged PR via `/lightsout`.

This is a bundle of **five decoupled UX units** for The Slate (the run-scoped column of small A2UI surfaces rendered by `src/components/RunWorkspaceWidget/SlatePanel.tsx`). Each unit lands in its own files/commit; partial completion is fine and leaves the Slate fully functional.

---

## Problem & Scope

The Slate works but the interaction surface is thin: it is mouse-only (no keyboard), open points can't be reordered, there is no lightweight "collapse but keep it" state distinct from hide, the in-flight refresh cue is nearly invisible, and an empty Slate greets the user with a dead one-line hint instead of an invitation to author.

**In scope:** the five units below, all client-side except Unit 2 which adds one server route + one store field for order persistence.
**Out of scope:** any change to surface authoring, the A2UI renderer, refresh delivery semantics, the multi-agent fast-path, or the design tokens themselves. No version bump (per conventions).

**Grounding read (done):** `SlatePanel.tsx`, `OpenPointsSurface.tsx`, `slateRefresh.tsx`, `SlateComposer.tsx`, `src/lib/uiPrefs.ts`, `RunWorkspaceWidget/index.tsx`, the hotkey stack (`actionHandlerRegistry.ts`, `contextRouter.ts`, `useGlobalHotkeys.ts`, `bindingFiredBus.ts`, `widgets/runWorkspaceWidget.ts`, `isEditable.ts`), the slate routes in `src/server/api/routes.ts` (points/answer/replies/resolve/refresh/compose block, lines ~3315–3606), the store `src/server/stores/slate.ts`, the projection `projectRunToSlate` in `src/server/stores/document-store.ts` (lines ~972–990), the types in `src/domain/types.ts` (`SlateSurface` ~489, `Point` ~546), `src/index.css` keyframes, and `docs/slate-design-language.md`.

---

## Decisions

### Unit 1 — Linear-style hotkeys

**Decision:** Route the Slate hotkeys through the **existing widget-binding architecture** (mirror `registerActionHandler` as instructed), not a bespoke listener. Add bindings to `src/hotkeys/widgets/runWorkspaceWidget.ts`; the existing `contextRouter` already does `dispatchAction(tail.id, action)` **and** `emitBindingFired(binding.key)` on a match (`contextRouter.ts:96–104`), and `HierarchySidebar` subscribes to `onBindingFired` — so the confirmation flash lands **on the sidebar row, not the widget**, exactly per the `feedback_flourish_on_sidebar` convention, for free. Bindings are keyed by `e.code` (the router normalizes via `e.code`, `contextRouter.ts:15`).

Key → `e.code` → action:
- `j` → `KeyJ` → `slate-focus-next`
- `k` → `KeyK` → `slate-focus-prev`
- `x` → `KeyX` → `slate-hide-focused`
- `r` → `KeyR` → `slate-refresh-focused`
- `c` → `KeyC` → `slate-compose`
- `/` → `Slash` → `slate-search`

The `index.tsx` action handler (`registerActionHandler`, `index.tsx:166–188`) gets new `case`s, **each gated on `focusZone === 'slate'`** so the keys only act when the Slate zone holds focus (the widget already tracks `focusZone`; Slate is a zone, `index.tsx:99`). `SlatePanel` exposes an imperative handle (`useImperativeHandle` via `forwardRef`) with `focusNext / focusPrev / hideFocused / refreshFocused / openComposer / focusSearch / toggleCheatsheet`; `index.tsx` holds a `slatePanelRef` and calls it from the handler. The router already suppresses bindings when `isEditable(active)` (`contextRouter.ts:98`), so typing in the composer / add-point / search inputs is safe automatically.

**The `?` conflict (assumption + resolution):** `?` is `Shift+Slash`. `useGlobalHotkeys` opens the command palette on `e.key === '?'` globally, guarded only by `isEditable` (`useGlobalHotkeys.ts:26–33`) — it does **not** know focus zones, so a registry binding for `Shift+Slash` would double-fire (palette + cheatsheet). Resolution: handle **only `?`** with a narrow **capture-phase** `keydown` listener inside `SlatePanel`, armed only while the Slate zone is focused, that calls `preventDefault()` + `stopImmediatePropagation()` so the global palette never sees the event. The other six keys stay on the clean registry path. This is the one deliberate hybrid, justified by the pre-existing global `?`.

**Rejected:** a single Slate-owned capture listener for *all* keys (fully decoupled, unit-test-friendly) — rejected because it forfeits the sidebar-row flash and the hotkeys-sidebar discoverability the prompt explicitly asks for; only `?` needs the shim.

> **Tradeoff:** choosing registry-integrated hotkeys over a self-contained listener. Gains the free sidebar-row flourish + discoverability in the hotkeys sidebar. Costs one `?`-only capture shim and a harmless no-op-with-flash if a bound key is pressed while the widget is focused but the Slate zone isn't. Wrong if the router's `emitBindingFired` path were ever removed.

**Cheatsheet overlay:** a `?`-toggled absolutely-positioned overlay inside `SlatePanel` listing the seven keys, styled per design language (mono labels, hairline, `#4f5e67` control ink, cyan reserved). Dismiss on `?`/`Esc`/outside-click.

**Focused-surface model (assumption):** "focus" is a **new client-only `focusedSurfaceId` state in `SlatePanel`**, visualized with a cyan focus ring on the focused surface/point card (cyan = live edge, P4). `j`/`k` walk the *visible, sorted* surface id list (open-points list counts as traversable rows too — see Unit-1 Files). Default focus = first visible surface once a hotkey is first pressed. This is orthogonal to the widget-level `focusZone`.

### Unit 2 — Reorder open points, persisted

**Decision:** Persist order **server-side** via a new route + a new **store-owned `order` field on `Point`** (the prompt says "persist via a route … + store"). Today `projectRunToSlate` sets `surface.order = p.createdAt` (`document-store.ts:977`) and `Point` has no `order` field — order is implicitly creation time. Add optional `Point.order?: number`; projection becomes `order: p.order ?? p.createdAt`. A new `PUT /api/runs/:id/slate/points/order` (mirroring the existing `PUT /api/projects/order`, `routes.ts:5279`) takes `{ order: string[] }` (point ids, desired order) and calls a new `SlateStore.reorderPoints(runId, ids)` that assigns `order = index` to listed points (unlisted points keep their prior `order`/createdAt), then re-projects.

**UI: thumb-pad + up/down, not native DnD.** Native HTML5 DnD is unreliable in the transformed canvas (memory `reference_canvas_iframe_drag_guard`). Each open-point row gets a **grip handle** (`⠿`, a thumb-pad glyph, low control ink) that reveals two chevrons (▲/▼) moving the point one slot among the open points. The move computes the new id array with a **pure `moveItem(ids, from, to)` helper** and `PUT`s it optimistically (reorder the local list immediately, reconcile on the SSE `run` delta; revert on failure — the established optimistic pattern in `OpenPointsSurface`).

**Rejected:** pointer-drag reorder (fragile pointer capture over sibling rows, hard to test) and a localStorage-only order (client-only, no server route — contradicts the explicit "via a route" instruction and wouldn't survive across browsers).

> **Tradeoff:** choosing server-persisted `Point.order` + up/down over a client-only or drag reorder. Gains durable, cross-browser order and a trivially unit-testable index helper. Costs a new store field, a projection tweak, and a new route (larger blast radius than the other units). Wrong if order were meant to be a per-browser view preference like `hiddenSlateSurfaces`.

**Assumption:** reorder targets the **open-points list only** (the hero grouped list); diagram/generic surfaces keep `order`-then-`createdAt` sort and are out of scope for the handle. `OpenPointsSurface` currently re-sorts by resolved-rank only (`OpenPointsSurface.tsx:446–451`) and JS `sort` is stable, so honoring incoming `order` needs no sort rewrite — the parent already feeds points in `order` order.

### Unit 3 — Minimize (distinct from hide)

**Decision:** A **per-browser UI preference**, `minimizedSlateSurfaces`, mirroring the `hiddenSlateSurfaces` family in `src/lib/uiPrefs.ts:213–230` exactly (new family key + `get/add/remove` helpers). Minimize collapses a surface to **just its title bar** (headline + a restore affordance + the freshness stamp), still occupying its grid slot; hide (`✕`) removes it from view entirely. Both are non-destructive view prefs; a surface can be neither, minimized, or hidden (hide wins if somehow both). A minimize control (a `–`/chevron glyph) sits in the card control cluster left of `✕` (`SlatePanel.tsx:272–278`); the collapsed header keeps a `+`/restore control.

**Assumption:** minimize applies to **generic + diagram surface cards** (the standalone shells). Per-open-point minimize is out of scope (open points already have a collapsed/thread-collapsed reading; adding a third state there is noise). Keeps Unit 3 to `SlatePanel.tsx` + `uiPrefs.ts`.

### Unit 4 — Reloading pulse

**Decision:** Add a **slow background pulse** keyframe to `src/index.css` (keyframes must be bundled there, not in tailwind config). The current cue is a static `shadow-[0_0_14px_rgba(0,240,255,0.10)]` glow set when `isRefreshing` (`SlatePanel.tsx:304–305`). Add `@keyframes slate-refresh-pulse` animating box-shadow between the resting `0 0 14px rgba(0,240,255,.10)` and a stronger `0 0 22px rgba(0,240,255,.28)` on a ~1.6s ease-in-out infinite loop, plus a faint border-color breathe. Apply via a `.slate-surface-refreshing` class swapped in when `isRefreshing`, replacing the static shadow utility. Respect `prefers-reduced-motion` (fall back to the static glow). Stays strictly cyan (P4 live edge) and tasteful.

**Assumption:** the pulse is applied to the **surface-card** refresh state and also to the **open-point row** refresh state (the row currently shows only a spinning `⟳`, no glow) so the two agree — small addition in `OpenPointsSurface.tsx`. If lightsout wants to stay minimal, the card-only change is a valid partial.

### Unit 5 — Inviting blank slate

**Decision:** When the Slate is open but empty, render `SlateComposer` **inline** on the blank slate in place of the `slate-empty-hint` block (`SlatePanel.tsx:236–241`). Reuse the existing component unchanged; give it an inline (non-popover) presentation so it reads as the invitation. Keep the header's `+ Add surface` popover path working for the non-empty case (don't double-open). The empty state still offers Explain via the header.

**Assumption:** `SlateComposer`'s outside-click/Esc self-close (`SlateComposer.tsx:47–62`) is fine inline — it closes to nothing when empty, so wrap it so "close" on the inline instance is a no-op (or omit the close affordance inline). Simplest: pass a no-op `onClose` for the inline instance and hide its Cancel button via a small `inline` prop, OR render it always-open with Cancel hidden when there are zero surfaces. Prefer a minimal `inline?: boolean` prop that suppresses the outside-click/Esc-close + Cancel when inline.

---

## Implementation Units

### Unit 1 — Linear-style hotkeys + cheatsheet

**Goal:** `j`/`k` move a cyan focus ring between visible surfaces, `x` hides the focused, `r` refreshes it, `c` opens the composer, `/` focuses search, `?` toggles a cheatsheet overlay — active only when the Slate zone is focused, safe while typing, with the confirmation flash on the sidebar row.

**Files:**
- **Modify** `src/hotkeys/widgets/runWorkspaceWidget.ts` — add six bindings (`KeyJ/KeyK/KeyX/KeyR/KeyC/Slash` → the `slate-*` actions) with labels.
- **Modify** `src/components/RunWorkspaceWidget/index.tsx` — add `case`s to the `registerActionHandler` switch, gated on `focusZone === 'slate'`; hold a `slatePanelRef` and forward each action to the panel's imperative handle.
- **Modify** `src/components/RunWorkspaceWidget/SlatePanel.tsx` — `forwardRef` + `useImperativeHandle` exposing `focusNext/focusPrev/hideFocused/refreshFocused/openComposer/focusSearch/toggleCheatsheet`; add `focusedSurfaceId` state + cyan focus ring; add the `?`-only capture-phase shim (armed on a new `slateFocused` prop) and the cheatsheet overlay.
- **Create** `src/components/RunWorkspaceWidget/slateHotkeys.ts` — a pure `keyToSlateAction(e): SlateHotkeyAction | null` mapper + the ordered key/label list the cheatsheet renders (single source of truth for both the shim and the overlay).
- **Test** `src/components/RunWorkspaceWidget/__tests__/slateHotkeys.test.ts` (pure mapper) and additions to `SlatePanel.test.tsx` (focus ring moves on `j`/`k`; `?` toggles overlay; keys inert while an input is focused).

**Approach:** SlatePanel builds the visible surface id list (open-points rows + non-hidden cards, in sorted order) and walks it for focus. The `index.tsx` handler only forwards when `focusZone === 'slate'`; the router's `isEditable` guard already blocks the six registry keys inside inputs, and the `?` shim checks `isEditable(document.activeElement)` before acting.

**Test scenarios:** mapper returns correct action per `e.code`/`shift`; `j` past the end wraps or clamps (decide clamp); `x` on focused calls `hide(id)`; `r` calls `refresh(surface)`; `c` sets `composerOpen`; overlay toggles and dismisses on `Esc`; no action fires when a composer/search/add-point input is focused.

**Verification:** `env -u NODE_ENV npx vitest run --exclude='e2e/**' src/components/RunWorkspaceWidget` green; typecheck clean; manual: focus the Slate zone, press each key.

### Unit 2 — Reorder open points (persisted)

**Goal:** an open point can be nudged up/down via a thumb-pad grip; the new order persists server-side and survives reload and file re-projection.

**Files:**
- **Modify** `src/domain/types.ts` — add `order?: number` to `Point` (store-owned; doc it as "sort order within the run's open points; falls back to `createdAt`").
- **Modify** `src/server/stores/slate.ts` — add `reorderPoints(runId, ids: string[], now?)` assigning `order = index` to listed points (via the existing `mutate`/emit plumbing); ensure `createPoint`/`mergeFileOwned` preserve `order` (file re-projection is order-neutral — `order` is store-owned, so `mergeFileOwned` already keeps it via `...prior`).
- **Modify** `src/server/stores/document-store.ts` — `projectRunToSlate` `order: p.order ?? p.createdAt` (line ~977); add a `reorderSlatePoints(runId, ids)` wrapper that calls the store then `projectRunToSlate`.
- **Modify** `src/server/api/routes.ts` — add `PUT /api/runs/:id/slate/points/order` in the slate block (near the other `/slate/points` routes ~3315), validating `{ order: string[] }` like `PUT /api/projects/order` (`routes.ts:5279`).
- **Create** `src/components/RunWorkspaceWidget/reorderUtil.ts` — pure `moveItem(ids, from, to): string[]`.
- **Modify** `src/components/RunWorkspaceWidget/OpenPointsSurface.tsx` — grip handle (`⠿`) + ▲/▼ per row; optimistic local reorder + `apiFetch` PUT; revert on failure.
- **Test** `src/components/RunWorkspaceWidget/__tests__/reorderUtil.test.ts` (index math), `slate.test.ts` additions (`reorderPoints` assigns order + emits + no-ops on identical), and `routes.slate.test.ts` additions (PUT validates body, reorders, rejects bad `order`).

**Approach:** the grip's ▲/▼ compute `moveItem(currentOpenIds, i, i±1)` and PUT the whole id array; optimistic state reorders the rendered list until the SSE `run` delta reconciles. Only open (non-resolved) points participate; resolved points keep sinking via the existing rank sort.

**Test scenarios:** `moveItem` up/down/at-bounds is a no-op at edges and correct in the middle; store assigns contiguous `order`, preserves unlisted points, short-circuits identical; route 400s on non-array/non-string `order`; a valid PUT re-projects with new order.

**Verification:** unit tests green (index math + store + route); manual: nudge a point, reload, order holds.

### Unit 3 — Minimize button

**Goal:** collapse a surface to just its title (still slotted), restore from the header; distinct from `✕` hide; per-browser.

**Files:**
- **Modify** `src/lib/uiPrefs.ts` — add `familyKeys.minimizedSlateSurfaces` + `getMinimizedSlateSurfaces / addMinimizedSlateSurface / removeMinimizedSlateSurface` mirroring the hidden-surfaces block (`uiPrefs.ts:206–230`).
- **Modify** `src/components/RunWorkspaceWidget/SlatePanel.tsx` — `minimized` Set state (seed from pref); a minimize (`–`) control in the card control cluster; when minimized, render only the title row + restore (`+`) control + freshness stamp, skipping the body/`A2uiRenderer`.
- **Test** `SlatePanel.test.tsx` additions (minimize collapses body but keeps the card + restore; restore re-renders body; minimize ≠ hide) and `uiPrefs` round-trip.

**Approach:** identical persistence pattern to hide; minimize gates whether the shell renders `A2uiRenderer`/`DiagramSurface`. A minimized-and-refreshing surface still gets the Unit-4 pulse on its title bar.

**Test scenarios:** minimize hides body, keeps `slate-surface-<id>` present with a `data-minimized`; restore reveals body; the pref persists; hide still works independently.

**Verification:** vitest green; manual: minimize/restore, reload persists.

### Unit 4 — Reloading pulse

**Goal:** the in-flight refresh cue is obviously animated (slow cyan pulse), not a static faint glow.

**Files:**
- **Modify** `src/index.css` — add `@keyframes slate-refresh-pulse` + a `.slate-surface-refreshing` class (box-shadow + border breathe, ~1.6s infinite ease-in-out) and a `prefers-reduced-motion` fallback to the static glow.
- **Modify** `src/components/RunWorkspaceWidget/SlatePanel.tsx` — swap the static refreshing shadow utility (`SlatePanel.tsx:304–305`) for the class.
- **Modify** `src/components/RunWorkspaceWidget/OpenPointsSurface.tsx` — add the pulse class to a refreshing open-point row (optional partial).
- **Test** `SlatePanel.test.tsx` — a refreshing surface carries `slate-surface-refreshing` (already has `data-refreshing`, easy to assert alongside).

**Approach:** pure CSS; the class is applied off the existing `isRefreshing` boolean, so no logic change. Cyan-only, tasteful amplitude.

**Test scenarios:** refreshing surface has the class + `data-refreshing`; non-refreshing does not.

**Verification:** vitest green; manual: trigger a refresh, confirm the slow pulse; check reduced-motion falls back.

### Unit 5 — Inviting blank slate

**Goal:** an open, empty Slate shows the fuzzy-search composer inline, inviting authoring, instead of the dead one-line hint.

**Files:**
- **Modify** `src/components/RunWorkspaceWidget/SlateComposer.tsx` — add `inline?: boolean` suppressing outside-click/Esc-close + Cancel when inline.
- **Modify** `src/components/RunWorkspaceWidget/SlatePanel.tsx` — replace the `slate-empty-hint` block (`:236–241`) with an inline `SlateComposer` (keep a one-line "Nothing yet — describe a surface" label above it); leave the header `+ Add` popover for the non-empty case.
- **Test** `SlatePanel.test.tsx` — empty+open renders `slate-composer` inline (not the hint); non-empty does not render the inline composer.

**Approach:** reuse the composer wholesale; the only new surface area is the `inline` presentation flag.

**Test scenarios:** `surfaces=[] open` → `slate-composer` present, `slate-empty-hint` absent; with surfaces → inline composer absent, header `+ Add` still opens the popover.

**Verification:** vitest green; manual: open a blank Slate, compose a surface inline.

---

## Scope Boundaries

- No change to refresh delivery, compose/explain prompts, the A2UI renderer, or the multi-agent fast path.
- Unit 2 is the only server-touching unit (one route, one `Point` field, one projection line, one store method) — all others are client + CSS + uiPrefs.
- Minimize (U3) and reorder (U2) target the surfaces/open-points list respectively; no cross-unit coupling — each is independently landable.
- No design-token edits; cyan stays reserved for the live edge (P4). No version bump. One squash-merged PR.
- Hotkeys are Slate-zone-scoped; global palette `?`, session cycling, and other global keys keep working when the Slate isn't focused.

## Risks

- **U1 `?` conflict** with the global command palette — mitigated by the capture-phase, focus-gated shim; verify the palette still opens when the Slate zone is *not* focused (regression check).
- **U1 imperative-handle wiring** across `index.tsx` ↔ `SlatePanel` — a stale ref or missing `forwardRef` silently breaks the keys; assert via a `SlatePanel` test that a ref method moves focus.
- **U2 3-place order flow** — `Point.order` must be threaded through `createPoint`/`mergeFileOwned` (preserve on re-projection) **and** `projectRunToSlate` (`p.order ?? p.createdAt`); a missed spot fails silently (order ignored). Write a store test that reorders, then re-projects a file update, and asserts order survives (mirrors the `reference_rundata_field_three_places` hazard, one level down at the Point/projection layer).
- **U2 optimistic reorder vs SSE echo** — reconcile on the `run` delta, not by watching a raw field, to avoid a stuck optimistic list (same class of bug the resolve/refresh code guards against).
- **U4 pulse taste** — too-strong amplitude reads as an error, not "live"; keep it slow and cyan, honor `prefers-reduced-motion`.
- **U5 inline composer close semantics** — the popover self-closes on Esc/outside-click; inline must not vanish on the empty slate — the `inline` flag must fully suppress those effects.
- **Bundle staleness** (memory `project_frontend_rebuild_required`): client changes need a `vite build` + hard reload on :5273 for manual verification — don't infer "broken" from a stale bundle.
