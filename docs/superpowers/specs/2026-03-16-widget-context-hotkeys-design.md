# Widget Contract + Contextual Hotkeys + Sidebar Design Spec

**Date**: 2026-03-16
**Status**: Approved

## Problem

Tinstar currently has two hardcoded widget types (RunWorkspaceWidget, GroupContainer) with hotkeys wired directly into ad-hoc hooks. There is no shared contract for what a widget is, no way to add new widget types without touching InfiniteCanvas, and no visual system for discovering what keys do what. As the widget surface grows, this becomes unmanageable.

## Solution

Three tightly coupled pieces built as one sub-project:

1. **Widget Contract** — a `WidgetDefinition` interface that every widget type registers. Declares its navigable sub-contexts and direct key bindings. The registry validates against a reserved key set at registration time.
2. **Contextual Hotkeys** — selection IS context. The active focus path (canvas → widget → sub-element) determines which bindings are live. A chord state handles transient command contexts (e.g. arrange mode) without touching the focus path.
3. **Context Sidebar** — a right-side panel that always shows available hotkeys for the current context, updates instantly, is resizable and hideable.

This does NOT refactor how widgets are rendered on the canvas (that is sub-project ③ — widget extensibility). It adds the contract and hotkey layer on top of the existing two widget types.

---

## Widget Contract

### WidgetDefinition

```typescript
interface WidgetDefinition {
  type: string              // e.g. 'run-workspace' | 'group-container' | 'canvas'
  displayName: string       // shown in sidebar header
  contexts: WidgetContext[] // navigable sub-elements this widget exposes
  bindings: Binding[]       // direct actions when this widget is the active focus
}

interface WidgetContext {
  key: string               // key that navigates into this context
  label: string             // e.g. 'Terminal', 'Files'
  type: string              // sub-widget type that becomes active
  transient?: boolean       // if true: chord mode (don't push focus path)
}

interface Binding {
  key: string               // e.g. 'S', 'G'
  label: string             // e.g. 'New session', 'Grid arrange'
  action: string            // identifier dispatched to the widget instance
  chord?: boolean           // true if this binding is shown during chord state only
}
```

### Widget Registry

`src/hotkeys/widgetRegistry.ts` — a singleton map of `type → WidgetDefinition`. Widgets self-register at module load time via `registerWidget(def)`. Registration performs three validations, each throwing on failure (never silently overriding):

1. **Duplicate type** — registering the same `type` string twice throws.
2. **Reserved key conflict** — any binding or context key that exactly matches a tier-1 reserved key string throws. The reserved set is the exhaustive list in the Tier 1 table below (exact string equality, case-sensitive).
3. **Intra-definition conflict** — any key that appears in both `contexts` and `bindings` of the same definition throws. Tier 2 bindings MAY shadow tier 3 (canvas) bindings — the focus path disambiguates at runtime and this is intentional. Widget authors can freely reuse canvas-level keys for their own widget bindings.

### Key String Format

All `Binding.key` and `WidgetContext.key` values use `e.code`-based notation for layout independence (consistent with the existing `useGlobalHotkeys` and `useCanvasHotkeys` implementations):
- **Single key**: `e.code` value — e.g. `'KeyS'`, `'BracketLeft'`, `'BracketRight'`, `'Backquote'`, `'Slash'`
- **With modifiers**: `Modifier+code` — e.g. `'Ctrl+Enter'`, `'Shift+BracketLeft'`, `'Ctrl+KeyG'`
- **Modifier order**: `Ctrl` before `Shift` before `Alt`

The router normalizes each `KeyboardEvent` to this format before matching. `Binding.label` is the human-readable display string shown in the sidebar. The Tier 1 reserved set table below uses human-readable notation for readability; the actual reserved strings in the registry use this `e.code` format.

### Migration from ActiveScopeContext

The existing `ActiveScopeContext.tsx` (`HotkeyScope = 'global' | 'canvas' | 'widget'`), `registry.ts` (`HOTKEYS: HotkeyDef[]`), and `ActiveScopeProvider` are **superseded** by this system:
- `ActiveScopeProvider` is removed from the component tree.
- `HOTKEYS` entries in `registry.ts` are migrated into `WidgetDefinition` bindings on the appropriate widget types (canvas or run-workspace).
- `HotkeyPalette` is updated to read bindings from `widgetRegistry` instead of `HOTKEYS`.
- The old `registry.ts` is deleted once migration is complete.

Both RunWorkspaceWidget and GroupContainer will receive concrete `WidgetDefinition` entries as part of this sub-project. `useWidgetHotkeys` (the per-element-ref keydown listener) is **retired** in this sub-project. Its bindings (`Tab`, `ArrowDown/Up/Right/Left`, `Enter`, `Ctrl+\`) are migrated into the `run-workspace` `WidgetDefinition.bindings`.

### Action Dispatch

`Binding.action` is a string identifier. When the router fires a tier-2 or tier-3 binding, it must reach the specific widget instance. This is done via a global `actionHandlerRegistry` (singleton `Map<widgetId: string, handler: (action: string) => void>`), exported from `src/hotkeys/actionHandlerRegistry.ts`:

- `registerActionHandler(id, fn)` / `deregisterActionHandler(id)` — called by widget instances in `useEffect` (cleanup deregisters)
- `dispatchAction(id, action)` — called by the router; no-op if no handler registered for that id

The `id` to dispatch to is the `id` of the current `FocusPath` tail node.

---

## Three-Tier Hotkey Priority

### Tier 1 — Reserved (global, always fire)

Keys that always fire regardless of focus state. Cannot be claimed by any widget. This is the exhaustive list — derived directly from the existing `useGlobalHotkeys` and `useCanvasHotkeys` hooks plus the new root key:

| Key combo | Action | Source |
|---|---|---|
| `` ` `` | Root — clear focus path, return to canvas | new |
| `[` (BracketLeft) | Cycle to previous ready session | useGlobalHotkeys |
| `]` (BracketRight) | Cycle to next ready session | useGlobalHotkeys |
| `Shift+[` (Shift+BracketLeft) | Cycle all sessions prev | useGlobalHotkeys |
| `Shift+]` (Shift+BracketRight) | Cycle all sessions next | useGlobalHotkeys |
| `?` | Open hotkey palette | useGlobalHotkeys |
| `Ctrl+Enter` | New session | useGlobalHotkeys |
| `S` / `s` | Quick session | useGlobalHotkeys |
| `Ctrl+G` | Arrange grid | useCanvasHotkeys |
| `Ctrl+Shift+G` | Arrange reset | useCanvasHotkeys |
| `Ctrl+1`–`Ctrl+0` | Assign to hotgroup slot | useCanvasHotkeys |
| `Ctrl+Shift+1`–`Ctrl+Shift+0` | Remove from hotgroup slot | useCanvasHotkeys |
| `0`–`9` (bare digit) | Hotgroup select/zoom (when not in editable) | useCanvasHotkeys |

Any `WidgetDefinition` whose `bindings` or `contexts` contain a tier-1 key throws at registration time.

### Tier 2 — Contextual (active when widget type is focused)

Bindings from the `WidgetDefinition` of the current focus path tail. Only live when that widget type is selected.

### Tier 3 — Canvas (active at root)

Bindings on the `canvas` WidgetDefinition. Active when focus path is empty or explicitly at canvas.

---

## Focus Path (Selection Depth)

The focus path lives in a **new, separate `FocusPathContext`** (`src/hotkeys/FocusPathContext.tsx`) — it does NOT modify `SelectionProvider`. `SelectionProvider` and its `selectedIds`/`selectedType` are left untouched. This is the lower-risk approach because `WorkspaceShell.tsx` and many other consumers read from `useSelection()` directly.

```typescript
type FocusNode = { id: string; type: string; label: string }

interface FocusPathState {
  path: FocusNode[]   // ordered canvas → widget → sub-element
  chordState: { contextId: string } | null
}
```

`FocusPathContext` provides:
- `pushFocus(node: FocusNode)` — navigate into a sub-context
- `clearFocus()` — root key: clear path entirely (backtick)
- `setChord(contextId: string)` — enter transient chord state
- `clearChord()` — resolve or cancel chord state

**Provider placement:** `FocusPathProvider` wraps the entire app at the same level as `SelectionProvider` (near the root in `App.tsx` or `main.tsx`), so all consumers can call `useFocusPath()`.

**Relationship to SelectionProvider:** When a user selects a widget (click or `[`), `SelectionProvider.selectedIds` is set (existing behavior, unchanged). Separately, the context router pushes that widget onto `FocusPathContext.path`. `WorkspaceShellInner` syncs them via a `useEffect` on `selectedRunId`:
- When `selectedRunId` becomes a non-null value: call `clearFocus()` then `pushFocus({ id: selectedRunId, type:'run-workspace', label: runName })`
- When `selectedRunId` becomes `null` (user deselects): call `clearFocus()`

Clicking a different widget on canvas resets both.

**Root key (`` ` ``):** clears `FocusPathContext.path` entirely. `SelectionProvider` selection (highlighting) is preserved — you can see what's selected, you just deactivated deep context.

**Transient chord state:** `chordState` in `FocusPathContext` — set when a `transient: true` context key is pressed. Does NOT modify `path`. Cleared when a chord binding fires or `` ` `` is pressed.

**Per-instance sub-element highlighting:** `WidgetDefinition` is a static type registration and cannot reference specific instances. When the router enters a sub-context, it pushes a new `FocusNode` onto `path`. Widget instances highlight their active sub-element by subscribing to path via a `useWidgetFocus(myId)` hook (provided by `src/hotkeys/useWidgetFocus.ts`). This hook returns `{ activeContextKey: string | null }` — the `key` of the sub-context that is active for that widget instance, or null if not focused. Widget renders use this to conditionally apply highlight classes.

---

## Context Router

`src/hotkeys/contextRouter.ts` — a pure function `resolveBindings(focusPath, chordState, registry) → ActiveBindings`.

On every keydown event (global listener):

```
0. isEditable guard:
     Tier-1 suppression: if e.target is input/textarea/contenteditable, skip these tier-1 keys
     (preserving existing hook behavior exactly):
       - KeyS / 's' / 'S'        → skip if editable OR iframe
       - '?' (Slash+Shift)        → skip if editable
       - BracketLeft / BracketRight / Shift+Bracket → skip if editable
       - Ctrl+Enter               → skip if editable OR iframe
       - Ctrl+KeyG / Ctrl+Shift+KeyG → skip if editable (canvas arrange)
       - Ctrl+Digit1–0 / Ctrl+Shift+Digit1–0 → skip if editable (hotgroup)
       - bare Digit0–9            → skip if editable (hotgroup select)
     Tier-2 and tier-3 bindings fire regardless of isEditable — widget bindings
     are scoped by the focus path (only fire when that widget type is active),
     and widget authors must not claim keys that conflict with text input
1. Check reserved tier 1 → fire immediately if match (with above suppressions applied), done
2. If chordState active:
     → match against chord context's bindings → fire action, clear chordState
     → ` → clear chordState (cancel chord)
     → no match → ignore (don't fall through)
3. Read focusPath.at(-1) → look up WidgetDefinition
4. Check contexts:
     → transient=false match → push FocusNode onto path
     → transient=true match  → set chordState
5. Check direct bindings → fire action
6. Else: ignore
```

The router never fires more than one action per keypress. Reserved keys take absolute priority.

---

## Visual Flourish

Two levels of activation feedback, keyed to action weight:

### Navigation / context change (Full Hollywood Hit)
Triggered when: focus path changes, widget selected via keyboard.

- Instant bloom: element scales to 102% with a hard cyan border + outer corona glow
- Scan line sweeps left-to-right across the element (diagonal, 350ms)
- Ripple ring emanates outward from border and fades
- Full duration: 500ms — snappy peak at ~8%, graceful decay

### Transient chord action (Scan Line only)
Triggered when: a chord binding fires (arrange, quick command).

- Scan line sweep only, 300ms
- No bloom, no ripple — the widget isn't changing context, just executing

Both effects implemented as CSS animations (no JS animation loop). Applied by toggling a class on the target element.

For the Full Hollywood Hit, three animations run simultaneously (`fullHit`, `fullHitScan`, `fullHitRipple`). Class removal is triggered by the `animationend` event on the **container element** for its `fullHit` animation (the longest, 500ms). A handler checks `e.animationName === 'fullHit'` before removing classes to avoid premature removal on shorter sub-animations. The listener is registered via `useEffect` with cleanup (removes the listener on unmount) to avoid leaks when widget components are removed from the DOM during animation.

Tailwind config already has `scan` and `pulse-glow` — new keyframes added for `ignite` (bloom) and `ripple-ring`.

---

## Hotkey Sidebar

`src/components/HotkeysSidebar.tsx` — fixed right-side panel.

### Layout

```
┌────────────────────┐
│ Canvas             │  ← focus path breadcrumb
│ › my-agent         │
│ › Terminal         │
├────────────────────┤
│  TERMINAL          │  ← current context label
│                    │
│  Ctrl+\  exit      │  ← context bindings
│  …                 │
├────────────────────┤
│  ALWAYS AVAILABLE  │  ← tier 1 reserved, always shown
│  `    canvas root  │
│  [    next session │
│  11   hotgroup 1   │
└────────────────────┘
```

During chord state: middle section dims current bindings and shows chord options with a cyan highlight until resolved.

### Resizable + Hideable

- Default width: 180px
- Drag handle on left edge — resize between 140px and 320px. Width persisted to localStorage (`tinstar-sidebar-hotkeys-width`).
- Collapse button (« ») in the sidebar header — collapses to a 24px vertical strip showing "KEYS" text, same pattern as the files/procs panels in RunWorkspaceWidget.
- Collapsed state persisted to localStorage (`tinstar-sidebar-hotkeys-collapsed`).

### Reactivity

Pure derivation from React state. No async. `useHotkeyContext()` is a convenience hook exported from `src/hotkeys/FocusPathContext.tsx` that composes `useFocusPath()` with a registry lookup and returns `{ focusPath, chordState, activeDefinition: WidgetDefinition | null }`. When `focusPath` is empty (canvas root), `activeDefinition` is the `canvas` WidgetDefinition (tier 3 bindings). When a widget is focused, `activeDefinition` is that widget's definition. Sidebar subscribes and re-renders synchronously. Updates feel instant because they are instant — all state is in-memory React.

---

## What This Does NOT Change

- Hotgroup key bindings (Ctrl+1 etc.) — untouched
- How widgets are rendered on the canvas (that is sub-project ③)
- The existing `useGlobalHotkeys`, `useCanvasHotkeys`, `useWidgetHotkeys` hooks — these are migrated/wired into the new router but their behavior is preserved
- Selection for multi-widget drag/arrange — transient chords never modify selection state
