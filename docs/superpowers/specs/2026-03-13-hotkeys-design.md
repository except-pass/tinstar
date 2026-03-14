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
  handler: string     // reference name, resolved at runtime by each scope's hook
}
```

### Dispatch Hooks

Three hooks consume the registry — each handles one scope:

- **`useGlobalHotkeys()`** — mounted once in `WorkspaceShell`. Handles `scope: 'global'`. Suppresses canvas/widget shortcuts when focus is inside the ttyd iframe (checks `document.activeElement`). Session cycling fires even when iframe is focused.
- **`useCanvasHotkeys()`** — mounted in `InfiniteCanvas`. Handles `scope: 'canvas'`.
- **`useWidgetHotkeys(runId)`** — mounted in `RunWorkspaceWidget`. Handles `scope: 'widget'`. Suspended when terminal has focus.

The `?` command palette renders `registry.ts` directly — no separate documentation to maintain.

---

## 2. Hotgroup System

### Data Model

Hotgroup assignments persist in localStorage, keyed per space:

```ts
// localStorage key: 'tinstar-hotgroups-v1-{spaceId}'
type HotgroupStore = {
  [slot: string]: string[]  // slot '1'–'9', '0' → runId[]
}
```

A run may belong to multiple slots simultaneously (StarCraft multi-group model).

### Key Bindings (`scope: 'canvas'`)

| Key | Action |
|-----|--------|
| `Ctrl+1`…`Ctrl+0` | Add selected run(s) to slot |
| `Ctrl+Shift+1`…`0` | Remove selected run(s) from slot |
| `1`…`0` | Select group: set canvas selection + expand hierarchy for all members |
| `1`…`0` (double-tap ≤300ms) | Zoom-to-fit all members + expand hierarchy |

Double-tap detection uses a ref tracking the last keydown time per slot number.

### Behavior

**On select (single tap):** Sets canvas selection to all `runId`s in the slot. Expands every ancestor in `HierarchySidebar` for each member run.

**On double-tap:** Computes the bounding box of all member widgets on the canvas. Calls the existing zoom-to-fit logic (same code path as double-clicking a widget). Expands hierarchy for all members.

### Visual Indicator

`⌨ 1 3` shown in two places, both right-aligned and muted (`text-slate-400`):

- **Widget title bar** — right side of the drag handle header
- **HierarchySidebar row** — right side of the run's row

Omitted entirely when the run belongs to no groups. No color coding per slot — the keyboard emoji + numbers is sufficient and avoids clutter.

---

## 3. Tab Navigation Within a Run Widget

### Scope

`scope: 'widget'` — only fires when a run widget has focus and the terminal iframe does not.

### Focus Order

Tab advances forward; Shift+Tab reverses:

```
Left panel tab toggle → file list → center panel tab toggle → right (procedures) panel toggle
```

### Key Bindings

| Key | Action |
|-----|--------|
| `Tab` | Advance focus to next zone |
| `Shift+Tab` | Reverse focus |
| `↑` / `↓` | Move between files (when file list is focused) |
| `←` / `→` | Switch center tabs: Recap ↔ Logs ↔ Terminal |
| `Enter` | Open focused file / activate focused procedure |

### Focus Tracking

A ref inside `RunWorkspaceWidget` holds the current focused zone as an enum: `'left-tab' | 'file-list' | 'center-tabs' | 'right-panel'`. The active zone receives a visible `ring-2 ring-indigo-500` highlight.

### Terminal Entry

When center-tabs focus is on the Terminal tab, `Ctrl+Shift+\` dives into the iframe (see Section 5). Tab navigation suspends until the user escapes back.

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

The server maintains an ordered array of session names that are currently ready-for-input, updated on every status change via the event bus. Exposed via SSE as a `ready_queue` field in state snapshots and delta events. The frontend mirrors it in React state for future UI surfaces.

### Key Bindings (`scope: 'global'`)

| Key | Action |
|-----|--------|
| `]` | Select next ready-for-input session |
| `[` | Select previous ready-for-input session |
| `Shift+]` | Select next session (all, wraps around) |
| `Shift+[` | Select previous session (all, wraps around) |

"Select" means: highlight the run widget on canvas, pan to ensure it's visible (not full zoom-to-fit), expand its hierarchy node. Session cycling fires globally, including when the ttyd iframe has focus — it naturally steals focus back to the canvas.

---

## 5. Terminal Focus Toggle

### Mechanism

Caddy injects a `<script>` tag into ttyd HTML responses that listens for `Ctrl+Shift+\` and fires:

```js
window.parent.postMessage({ type: 'terminal-focus-toggle' }, '*')
```

`RunSessionPanel` listens for this message and toggles a `terminalFocused` ref. When toggling out, it calls `.focus()` on the widget's root element to return keyboard control.

### Key Bindings

| Key | Action |
|-----|--------|
| `Ctrl+Shift+\` | Toggle focus between ttyd iframe and run widget |

### Visual Feedback

- **Terminal focused:** iframe gets `ring-2 ring-indigo-400`
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
| `Ctrl+Enter` | Open CreateSessionDialog scoped to the currently selected entity (run's task, or whichever taxonomy node is selected in the sidebar) |

### Existing Canvas Hotkeys (register in registry)

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

---

## 7. Command Palette

A modal overlay (similar to VS Code's keyboard shortcut reference) opened by pressing `?`. Renders `registry.ts` grouped by `category`. Supports text search filtering hotkey descriptions. Shows scope context (greyed-out entries for hotkeys unavailable in the current focus state). Dismissed with `Escape` or clicking outside.

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
| `Ctrl+Shift+\` | Toggle terminal / widget focus | widget | Terminal |
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
