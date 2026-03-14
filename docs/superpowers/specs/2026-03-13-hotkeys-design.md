# Hotkey System Design

## Overview

A StarCraft-inspired hotkey system for Tinstar with a centralized registry, scoped dispatch, command palette affordance, and a 10-slot hotgroup system for grouping and navigating runs.

---

## 1. Hotkey Registry Architecture

### Single Source of Truth

`src/hotkeys/registry.ts` exports a typed array of every hotkey definition in the app:

```ts
type HotkeyScope = 'global' | 'canvas' | 'widget'

type HotkeyDef = {
  id: string
  keys: string        // e.g. 'Ctrl+Shift+\\'
  scope: HotkeyScope
  category: string    // for palette grouping
  description: string
}
```

The `handler` field is intentionally absent from the registry — handler wiring happens inside each scope's hook via a string-keyed `Record<string, () => void>` map. This keeps the registry pure data (and readable as docs) while each hook owns its own action map. The handler ID string in the hook map must match `HotkeyDef.id`.

### Dispatch Hooks

Three hooks consume the registry — each handles one scope:

- **`useGlobalHotkeys()`** — mounted once in `WorkspaceShell`. Attaches a `keydown` listener to `window`. Handles `scope: 'global'`. Uses an `isEditable(target)` guard (same pattern as `useCanvasCamera`) to suppress all global hotkeys when focus is inside a text input, contenteditable, or textarea. Session cycling (`[`/`]`) is a deliberate exception: it fires even when a ttyd iframe is the active element (detected via `document.activeElement.tagName === 'IFRAME'`), and calls `.blur()` on the iframe then `.focus()` on the canvas root before executing. `Ctrl+Enter` is explicitly suppressed when an iframe is active (would be disruptive mid-terminal).
- **`useCanvasHotkeys()`** — mounted in `InfiniteCanvas`. Attaches to `window`. Handles `scope: 'canvas'`. Applies the same `isEditable` guard. Does not fire when focus is inside the ttyd iframe.
- **`useWidgetHotkeys(runId, rootRef)`** — mounted in `RunWorkspaceWidget`. Attaches a `keydown` listener to the **widget's root `div` element** (passed as `rootRef`, which must have `tabIndex={-1}` to be focusable). Does **not** attach to `window` — this prevents multiple mounted widgets from all receiving the same key events. Suspended (no-ops all handlers) when `terminalFocused` ref is `true`.

All three hooks share a single utility: `isEditable(el: Element): boolean` — returns true for `INPUT`, `TEXTAREA`, `SELECT`, and elements with `contenteditable="true"`.

### Active Scope Context

`WorkspaceShell` provides an `ActiveScopeContext` with shape `{ scope: HotkeyScope }`. Each scope hook writes to this context via a setter on `focus`/`blur` events on its attachment point. The command palette reads this context to grey out out-of-scope entries. Provider lives in `WorkspaceShell`; consumers are the palette and (optionally) any UI that wants to react to the current focus scope.

The `?` command palette renders `registry.ts` directly — no separate documentation to maintain.

---

## 2. Hotgroup System

### Data Model

Hotgroup assignments persist in localStorage, keyed per space. The `activeSpaceId` is read from the SSE snapshot state (already available in `useBackendState`) and passed as a prop/context wherever hotgroup state is needed.

```ts
// localStorage key: 'tinstar-hotgroups-v1-{spaceId}'
type HotgroupStore = {
  [slot: string]: string[]  // slot '1'–'9', '0' → runId[]
}
```

A run may belong to multiple slots simultaneously (StarCraft multi-group model).

**Space switching:** when `activeSpaceId` changes, the hotgroup store is re-read from localStorage for the new space. Assignments from the previous space are not carried over or cleared — each space has its own independent store.

**Stale run IDs:** when a run deletion SSE event arrives, prune its `runId` from all slots in the current space's hotgroup store. This keeps the store clean without requiring ghost-filtering at selection time.

### Key Bindings (`scope: 'canvas'`)

| Key | Action |
|-----|--------|
| `Ctrl+1`…`Ctrl+0` | Add selected run(s) to slot |
| `Ctrl+Shift+1`…`0` | Remove selected run(s) from slot (no-op if not a member) |
| `1`…`0` | Select group: set canvas selection + expand hierarchy for all members |
| `1`…`0` (double-tap ≤300ms) | Zoom-to-fit all members + expand hierarchy |

**Double-tap detection:** each slot maintains its own `lastTapTime` in a `Record<string, number>` ref. Tapping `1` then `2` within 300ms does not trigger a double-tap on either slot — only `1` → `1` within 300ms counts.

### Behavior

**On select (single tap):** Sets canvas selection to all `runId`s in the slot that have a widget in the current layout (stale IDs silently skipped). Expands every ancestor in `HierarchySidebar` for each member run.

**On double-tap:** Computes the bounding box of all member widgets on the canvas. Calls the existing zoom-to-fit logic (same code path as double-clicking a widget), with a 40px margin on each side. Expands hierarchy for all members.

**Empty slot:** single or double tap on an unassigned slot is a no-op (no error).

### Visual Indicator

`⌨ 1 3` shown in two places, both right-aligned and muted (`text-slate-400 text-xs`):

- **Widget title bar** — right side of the drag handle header, before the status dot
- **HierarchySidebar row** — right side of the run's row

Omitted entirely when the run belongs to no groups. If a run belongs to more than 3 slots, show the first 3 and append `+N` (e.g. `⌨ 1 3 5 +2`) to prevent header overflow.

---

## 3. Tab Navigation Within a Run Widget

### Scope

`scope: 'widget'` — only fires when a run widget has focus and `terminalFocused` is `false`.

### Focus Zones

A `focusZone` ref inside `RunWorkspaceWidget` holds one of: `'left-tab' | 'file-list' | 'center-tabs' | 'right-panel'`.

- **`left-tab`**: the left panel tab strip (Changed / Explorer toggle). If the left panel is collapsed, Tab skips this zone and advances directly to `center-tabs`.
- **`file-list`**: the file list inside the left panel. Only reachable when the left panel is expanded. Arrow keys move between files; Enter opens the focused file.
- **`center-tabs`**: the center panel tab strip. `RunSessionPanel` has exactly **two** tab slots: "Recap" and either "Terminal" (when the session has a live port) or "Logs" (when it does not). Arrow keys (`←`/`→`) switch between them.
- **`right-panel`**: the procedures panel toggle. If collapsed, Tab loops back to `left-tab` (or `center-tabs` if left is collapsed).

Tab order (forward): `left-tab` → `file-list` (if left expanded) → `center-tabs` → `right-panel` → wrap to `left-tab`.

### Key Bindings

| Key | Action |
|-----|--------|
| `Tab` | Advance to next zone |
| `Shift+Tab` | Reverse to previous zone |
| `↑` / `↓` | Move between files (when `file-list` focused) |
| `←` / `→` | Switch center tabs (when `center-tabs` focused) |
| `Enter` | Open focused file / activate focused procedure |

The active zone renders a `ring-2 ring-indigo-500` highlight on its container.

### Terminal Entry

When `center-tabs` is focused and the **Terminal tab is active** (not Logs), `Ctrl+Shift+\` dives into the terminal (see Section 5). Tab navigation suspends (`terminalFocused = true`) until the user toggles back. When the center tab shows "Logs" (no live terminal), `Ctrl+Shift+\` is a no-op.

---

## 4. Session Cycling + Ready-for-Input Queue

### Status Mapping

| Status | Ready for input |
|--------|----------------|
| `idle` | ✅ |
| `creating` | ✅ |
| `needs_attention` | ✅ |
| `running` | ❌ |
| `stopped` | ❌ |
| `terminated` | ❌ |

### Backend Queue

The server maintains an ordered `string[]` of session names that are currently ready-for-input. It lives in `sessions/index.ts` as an in-memory structure (not in `DocumentStore`), updated synchronously on every status change. Order is insertion-order — newly-ready sessions append to the end.

**SSE transport:**
- **Snapshot:** `ready_queue: string[]` added as a top-level field on the existing snapshot object (alongside `runs`, `spaces`, etc.).
- **Delta:** a new SSE event type `ready_queue_update` with payload `{ queue: string[] }` is emitted whenever the queue changes.
- **Frontend:** `useServerEvents` is extended to handle `ready_queue_update` and store it in a new `readyQueue: string[]` field on the state returned by `useBackendState`.

### Key Bindings (`scope: 'global'`)

Note: on a standard keyboard `Shift+[` produces `{` and `Shift+]` produces `}`. Implement using `e.code === 'BracketLeft'` / `e.code === 'BracketRight'` plus `e.shiftKey`, not `e.key === '['`.

| Key | Action |
|-----|--------|
| `]` (`BracketRight`, no shift) | Select next ready-for-input session |
| `[` (`BracketLeft`, no shift) | Select previous ready-for-input session |
| `Shift+]` (`BracketRight` + shiftKey) | Select next session (all, wraps around) |
| `Shift+[` (`BracketLeft` + shiftKey) | Select previous session (all, wraps around) |

**"Select" behavior:** highlight the run widget on canvas, pan to bring it into view with a 60px margin on each side (not full zoom-to-fit), expand its hierarchy node. If the widget is larger than the viewport at current zoom, pan to center it. If a run has no canvas widget (no layout entry), skip it in the cycle.

**Iframe escape:** when `]`/`[`/`Shift+]`/`Shift+[` fires and `document.activeElement` is an `IFRAME`, call `.blur()` on the iframe and `.focus()` on the canvas root element before executing the cycle action. This naturally returns focus to the canvas.

---

## 5. Terminal Focus Toggle

### Mechanism

Rather than injecting scripts via Caddy (which would require non-standard Caddy modules not available in the `caddy:2` Docker image), the terminal is loaded via a **thin wrapper page** served by the Vite backend. Instead of loading the ttyd URL directly in the `<iframe>` src, `RunSessionPanel` loads `/terminal-wrapper?session={sessionName}`. The Vite backend serves a minimal HTML page that:

1. Embeds the ttyd URL in its own `<iframe>`
2. Listens for `Ctrl+Shift+\` on `keydown`
3. On match, calls `window.parent.postMessage({ type: 'terminal-focus-toggle' }, '*')`

`RunSessionPanel` listens for this `message` event on `window`, filtering by `event.data.sessionName` matching its own session — this prevents multiple mounted widgets from all toggling when any one terminal fires the chord. The wrapper page includes the `sessionName` in the payload: `{ type: 'terminal-focus-toggle', sessionName: '...' }`. This requires no Caddy changes.

### Key Bindings

| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+Shift+\` | Widget focused | Dive into terminal: set `terminalFocused = true`, focus the wrapper iframe |
| `Ctrl+Shift+\` | Terminal wrapper focused | Escape to widget: postMessage → `terminalFocused = false`, focus widget root |

Note: this binding does not appear in `useWidgetHotkeys` keydown handling. The "dive in" direction is handled by `useWidgetHotkeys` as a `keydown` listener. The "escape out" direction is handled by the wrapper page's own `keydown` listener via `postMessage`. The `?` palette documents it as a single toggle entry.

### Visual Feedback

- **Terminal focused:** wrapper iframe gets `ring-2 ring-indigo-400` CSS class applied by `RunSessionPanel`
- **Widget focused:** normal tab-nav ring is active on the current zone

---

## 6. Remaining Hotkeys

### Window Arrangements (`scope: 'canvas'`)

| Key | Action |
|-----|--------|
| `Ctrl+G` | Arrange grid |
| `Ctrl+Shift+G` | Reset layout |

### New Session (`scope: 'global'`)

| Key | Action |
|-----|--------|
| `Ctrl+Enter` | Open CreateSessionDialog |

The dialog is scoped to the currently selected entity: the selected sidebar node if one exists, or the selected canvas widget's task if a run is selected. If nothing is selected, the dialog opens with no pre-selection (user picks manually). Suppressed by the `isEditable` guard.

### Existing Canvas Hotkeys (register in registry)

These already work; they just need entries added to `registry.ts`:

| Key | Action | Scope |
|-----|--------|-------|
| `Space` (hold) | Pan mode | canvas |
| `Alt+Z` | Reset zoom | canvas |
| `Ctrl+Scroll` | Zoom to cursor | canvas |

### Command Palette (`scope: 'global'`)

| Key | Action |
|-----|--------|
| `?` | Open searchable hotkey palette, grouped by category |
| `Escape` | Close palette |

Suppressed by `isEditable` guard.

---

## 7. Command Palette

A modal overlay opened by pressing `?`. Renders `registry.ts` grouped by `category`. Supports text search filtering across `description` and `keys` fields.

**Availability display:** the palette reads the current focus scope (global/canvas/widget) from a context value set by the active scope hook. Hotkeys whose scope does not match the current scope are shown greyed-out with a tooltip: "Available when [canvas / a run widget] is focused." Hotkeys that are always available are not greyed.

Dismissed with `Escape` or clicking the backdrop.

---

## 8. Complete Hotkey Reference

| Key | Description | Scope | Category |
|-----|-------------|-------|----------|
| `?` | Open command palette | global | General |
| `Ctrl+Enter` | New session for selected entity | global | Sessions |
| `]` | Next ready-for-input session | global | Sessions |
| `[` | Previous ready-for-input session | global | Sessions |
| `Shift+]` | Next session (all) | global | Sessions |
| `Shift+[` | Previous session (all) | global | Sessions |
| `Ctrl+Shift+\` | Toggle terminal / widget focus | widget+iframe | Terminal |
| `Tab` | Next panel zone | widget | Navigation |
| `Shift+Tab` | Previous panel zone | widget | Navigation |
| `↑` / `↓` | Move between files | widget | Navigation |
| `←` / `→` | Switch center tabs | widget | Navigation |
| `Enter` | Open file / activate procedure | widget | Navigation |
| `1`…`0` | Select hotgroup | canvas | Hotgroups |
| `1`…`0` (×2) | Zoom-to-fit hotgroup | canvas | Hotgroups |
| `Ctrl+1`…`0` | Add selection to hotgroup slot | canvas | Hotgroups |
| `Ctrl+Shift+1`…`0` | Remove selection from hotgroup slot | canvas | Hotgroups |
| `Ctrl+G` | Arrange grid | canvas | Layout |
| `Ctrl+Shift+G` | Reset layout | canvas | Layout |
| `Space` (hold) | Pan mode | canvas | Navigation |
| `Alt+Z` | Reset zoom | canvas | Navigation |
| `Ctrl+Scroll` | Zoom to cursor | canvas | Navigation |

---

## 9. Playwright Test Plan

All tests run with `TINSTAR_FAST_SIM=1` and use `resetAndWaitForData()` in `beforeEach`. Tests live in `e2e/hotkeys.spec.ts` except where noted.

**Note on terminal focus toggle:** `Ctrl+Shift+\` requires a live ttyd session and cannot be tested with the simulator. Those behaviors are covered by the wrapper page's own unit-level tests (the wrapper HTML is simple enough to test in isolation). The Playwright suite tests everything else.

---

### Command Palette

| Test | What to assert |
|------|---------------|
| Press `?` on canvas | `[data-testid="hotkey-palette"]` becomes visible |
| Palette renders all categories | Each category heading from `registry.ts` is present |
| Type "session" in search | Only hotkeys with "session" in description or keys remain visible |
| Clear search | All hotkeys reappear |
| Press `Escape` | Palette closes |
| Click backdrop | Palette closes |
| Focus a text input, press `?` | Palette does **not** open (isEditable guard) |
| Open palette while canvas focused | Widget-scope hotkeys shown greyed-out |

---

### Hotgroups

| Test | What to assert |
|------|---------------|
| Click run widget, press `Ctrl+1` | `[data-testid="hotgroup-badge-R-241"]` shows `⌨ 1`; sidebar row also shows `⌨ 1` |
| Press `Ctrl+2` on same run | Badge updates to `⌨ 1 2` |
| Press `Ctrl+Shift+1` | Badge updates to `⌨ 2` (slot 1 removed) |
| Press `Ctrl+Shift+2` | Badge disappears entirely |
| Press `1` (slot assigned) | Run is selected; sidebar ancestor nodes are expanded and visible |
| Press `1` again within 300ms | Camera transform changes (read via `page.evaluate(() => getComputedStyle(...).transform)` on canvas layer); run is visible in viewport |
| Press `1` with unassigned slot | No crash, no selection change |
| Assign two runs to slot 1 (multi-select via Ctrl+click, then Ctrl+1) | Both runs show `⌨ 1`; pressing `1` selects both |
| Press `1` (double-tap, 2 runs) | Viewport zooms to fit both runs (zoom % changes and both `[data-testid]` widgets are within viewport bounds) |
| Slot `0` (10th group) | Same as slot 1 — `Ctrl+0` assigns, `0` selects, `0`+`0` zooms |
| Run deleted (simulate via SSE) | Badge disappears; pressing its former slot is a no-op |
| `1`-`9` not firing inside text input | Renaming a sidebar node — digit keys don't trigger hotgroup |

---

### Tab Navigation

| Test | What to assert |
|------|---------------|
| Click run widget, press `Tab` | Element with `[data-testid="focus-zone-left-tab"]` has `ring-2` class |
| Tab again (left panel expanded) | `[data-testid="focus-zone-file-list"]` has `ring-2` |
| Press `↓` in file list | Second file item gets highlighted |
| Press `↑` | First file item highlighted again |
| Press `Tab` → center tabs | `[data-testid="focus-zone-center-tabs"]` has `ring-2` |
| Press `→` in center tabs | Switches from Recap to second tab (Terminal or Logs) |
| Press `←` | Switches back to Recap |
| Press `Tab` → right panel | `[data-testid="focus-zone-right-panel"]` has `ring-2` |
| Press `Tab` → wraps to left | `focus-zone-left-tab` has `ring-2` again |
| Press `Shift+Tab` from left | Jumps to right panel (reverse wrap) |
| Left panel collapsed | Tab skips `left-tab` and `file-list`, goes directly to `center-tabs` |
| `Tab` key on empty canvas (no widget focused) | No focus zone rings appear anywhere |

---

### Session Cycling

| Test | What to assert |
|------|---------------|
| Press `]` | A run widget gets canvas selection class; its sidebar node is visible/expanded |
| Press `]` again | A **different** run is selected |
| Press `[` | Previous run in cycle is selected |
| Press `]` repeatedly until wrap | Cycles back to first ready-for-input run (no crash at boundary) |
| Press `Shift+]` | Selects a session regardless of status (assert total count cycles through more sessions than `]` alone) |
| Press `Shift+[` | Reverse all-session cycle |
| Selected run scrolled into view | After cycling, `page.evaluate(() => el.getBoundingClientRect())` shows widget within viewport bounds |
| Hierarchy expanded after cycle | The selected run's sidebar ancestor rows are visible |

---

### Window Arrangements

| Test | What to assert |
|------|---------------|
| Drag a container, press `Ctrl+G` | Container returns to near-original grid position (within 30px) |
| Drag a container, press `Ctrl+Shift+G` | Layout resets; container position matches fresh-load position |
| `Ctrl+G` does not change zoom | `[data-testid="zoom-indicator"]` text unchanged before/after |
| `Ctrl+Shift+G` while nothing dragged | No crash; layout unchanged |

---

### New Session (`Ctrl+Enter`)

| Test | What to assert |
|------|---------------|
| Select sidebar node, press `Ctrl+Enter` | `CreateSessionDialog` visible; pre-selected entity matches selected node |
| Select canvas run widget, press `Ctrl+Enter` | Dialog opens pre-scoped to that run's task |
| Press `Ctrl+Enter` with nothing selected | Dialog opens with no pre-selection |
| Focus a text input, press `Ctrl+Enter` | Dialog does **not** open |
| Press `Escape` in dialog | Dialog closes |
