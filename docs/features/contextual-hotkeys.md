# Contextual Hotkeys + Hotkey Sidebar

A three-tier hotkey system where the active focus path (canvas → widget → sub-element) determines which key bindings are live. Every widget type self-registers its bindings and navigable sub-contexts via a `WidgetDefinition`. A right-side sidebar always shows the available keys for the current context.

---

## Architecture

Three tightly coupled pieces:

1. **Widget Contract** — `WidgetDefinition` interface; every widget type self-registers its bindings and navigable sub-contexts.
2. **Context Router** — global keydown listener that resolves bindings from the active focus path and dispatches actions.
3. **Hotkey Sidebar** — the `HotkeysSection` inside `src/components/HierarchySidebar.tsx`: a resizable panel at the bottom of the hierarchy sidebar that reactively shows the current context's bindings.

---

## Widget Contract

### `WidgetDefinition`

Defined in `src/hotkeys/widgetTypes.ts`. Registered at module load via `src/hotkeys/widgetRegistry.ts`.

```typescript
interface WidgetDefinition {
  type: string           // e.g. 'run-workspace', 'canvas'
  displayName: string    // shown in sidebar header
  contexts: WidgetContext[]   // navigable sub-elements
  bindings: Binding[]         // direct actions for this widget
}

interface WidgetContext {
  key: string          // key that navigates into this context (e.code format)
  label: string        // e.g. 'Terminal', 'Files'
  type: string         // sub-widget type that becomes active
  transient?: boolean  // true → chord mode (don't push focus path)
}

interface Binding {
  key: string     // e.code format, e.g. 'KeyS', 'Ctrl+Enter'
  label: string   // human-readable, shown in sidebar
  action: string  // identifier dispatched to widget instance
  chord?: boolean // true → only shown during chord state
}
```

### Key String Format

All `key` fields use `e.code`-based notation for keyboard layout independence:
- Single key: `'KeyS'`, `'BracketLeft'`, `'Backquote'`
- With modifiers: `'Ctrl+Enter'`, `'Ctrl+KeyG'`, `'Shift+BracketLeft'`
- Modifier order: `Ctrl` before `Shift` before `Alt`

### Widget Registry (`src/hotkeys/widgetRegistry.ts`)

A singleton `Map<type, WidgetDefinition>`. Throws at registration time for:
1. **Duplicate type** — same `type` string registered twice
2. **Reserved key conflict** — any binding/context key matching a Tier 1 reserved key
3. **Intra-definition conflict** — same key in both `contexts` and `bindings`

Tier 2 bindings may intentionally shadow Tier 3 (canvas) bindings — the focus path disambiguates at runtime.

### Action Dispatch (`src/hotkeys/actionHandlerRegistry.ts`)

Widget instances register handlers via `registerActionHandler(id, fn)` in a `useEffect` (cleanup deregisters). When the router fires a binding, it calls `dispatchAction(id, action)` on the `FocusPath` tail node's id. No-op if no handler is registered.

---

## Three-Tier Priority

| Tier | Scope | When active |
|------|-------|-------------|
| **1 — Reserved** | Global | Always; cannot be claimed by any widget |
| **2 — Contextual** | Widget | Only when that widget type is the focus path tail |
| **3 — Canvas** | Canvas root | When focus path is empty |

**Tier 1 reserved keys** (exhaustive list):

| Key | Action |
|-----|--------|
| `` ` `` | Clear focus path → canvas root |
| `[` / `]` | Previous / next ready session |
| `Shift+[` / `Shift+]` | Previous / next session (all) |
| `?` | Open hotkey palette |
| `Ctrl+Enter` | New session |
| `S` | Quick session dialog |
| `Ctrl+G` | Arrange grid |
| `Ctrl+Shift+G` | Reset layout |
| `Ctrl+1`–`0` | Assign to hotgroup slot |
| `Ctrl+Shift+1`–`0` | Remove from hotgroup slot |
| `0`–`9` | Hotgroup select/zoom |

Tier 1 keys respect the standard `isEditable` suppression (suppressed in input/textarea/contenteditable), except `[`/`]` which fire even from iframes (blur iframe first).

---

## Focus Path (`src/hotkeys/FocusPathContext.tsx`)

Separate from `SelectionProvider` — the existing `selectedIds`/`selectedType` selection state is untouched. `FocusPathContext` tracks the navigation depth independently.

```typescript
type FocusNode = { id: string; type: string; label: string }

interface FocusPathState {
  path: FocusNode[]                      // canvas → widget → sub-element
  chordState: { contextId: string } | null
}
```

API:
- `pushFocus(node)` — navigate into a sub-context
- `clearFocus()` — `` ` `` key: clear path entirely, return to canvas root
- `setChord(contextId)` — enter transient chord state (doesn't modify `path`)
- `clearChord()` — resolve or cancel chord state

`FocusPathProvider` wraps the app at the same level as `SelectionProvider`. `WorkspaceShell` syncs `selectedRunId` → focus path: on selection, clears then pushes the selected run widget; on deselection, clears.

**Chord state:** set when a `transient: true` context key is pressed. The sidebar dims regular bindings and shows chord options. Pressing a chord binding fires the action and clears chord state. `` ` `` cancels.

---

## Context Router (`src/hotkeys/contextRouter.ts`)

Pure function `resolveBindings(focusPath, chordState, registry) → ActiveBindings`. Global keydown listener applies this logic per event:

```
1. Tier 1 match (with isEditable suppressions) → fire immediately, done
2. Chord state active:
     → match chord binding → fire action, clear chord
     → ` → clear chord (cancel)
     → no match → ignore (don't fall through to tier 2/3)
3. Read focusPath.at(-1) → look up WidgetDefinition
4. Check contexts:
     → transient=false match → pushFocus()
     → transient=true match  → setChord()
5. Check bindings → fire action
6. No match → ignore
```

One action per keypress maximum. Reserved keys take absolute priority.

---

## Visual Flourish

Two levels of activation feedback (CSS animations, no JS loop):

**Full Hollywood Hit** — on focus path change or keyboard widget selection:
- Bloom: element scales to 102% with cyan border + outer corona glow
- Scan line sweeps left-to-right (diagonal, 350ms)
- Ripple ring emanates from border
- Total duration: 500ms. Class removed on `animationend` of the `fullHit` animation.

**Scan Line only** — on chord binding fire:
- Scan line only, 300ms. No bloom, no ripple.

Implemented in `src/hooks/useFlourish.ts`. Keyframes: `ignite` (bloom), `ripple-ring`, `scan`.

---

## Hotkey Sidebar (HotkeysSection in `src/components/HierarchySidebar.tsx`)

Resizable panel at the bottom of the hierarchy sidebar showing all available bindings for the current context.

**Layout:**
```
┌────────────────────┐
│ Canvas             │  ← focus path breadcrumb
│ › my-agent         │
│ › Terminal         │
├────────────────────┤
│  TERMINAL          │  ← current context label
│  Ctrl+\  exit      │  ← context bindings
├────────────────────┤
│  ALWAYS AVAILABLE  │  ← tier 1 reserved keys (always shown)
│  `    canvas root  │
│  [    next session │
└────────────────────┘
```

During chord state: middle section dims and shows chord options in cyan.

**Resizable:** drag handle on left edge, 140px–320px range. Width persisted to `tinstar-sidebar-hotkeys-width` in localStorage.

**Collapsible:** collapses to a 24px vertical strip showing "KEYS". Collapsed state persisted to `tinstar-sidebar-hotkeys-collapsed`.

**Reactivity:** pure derivation from `FocusPathContext` state. `useHotkeyContext()` hook (from `FocusPathContext.tsx`) returns `{ focusPath, chordState, activeDefinition }`. Updates are synchronous — no async, no delay.

---

## Adding a New Widget Type

1. Define a `WidgetDefinition` in `src/hotkeys/widgets/<name>.ts`
2. Call `registerWidget(def)` at module load (side effect)
3. Import the file in `main.tsx`/`App.tsx` before `FocusPathProvider`
4. Register an action handler in the component: `registerActionHandler(id, fn)` in `useEffect` with `deregisterActionHandler(id)` as cleanup
5. Apply `useWidgetFocus(id)` to highlight sub-elements when they become the active context
