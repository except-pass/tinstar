# Hotkey System

A StarCraft-inspired hotkey system with a centralized registry, three-tier scoped dispatch, 10-slot hotgroups, and session cycling.

---

## Architecture: Three-Tier Dispatch

Hotkeys are dispatched through three independent scopes, in priority order:

| Scope | Hook | Attachment point | Guard |
|-------|------|-----------------|-------|
| `global` | `useGlobalHotkeys()` | `window` | `isEditable()` |
| `canvas` | `useCanvasHotkeys()` | `window` | `isEditable()` |
| `widget` | `useWidgetHotkeys(runId, rootRef)` | widget root `div` | `terminalFocused` ref |

`isEditable(el)` returns `true` for `INPUT`, `TEXTAREA`, `SELECT`, and `contenteditable` elements. Global and canvas hotkeys are suppressed when an editable element is focused.

Widget hotkeys attach to the widget's root element (not `window`), so only the focused widget receives key events. The root `div` must have `tabIndex={-1}` to be focusable.

**Deliberate exceptions to `isEditable` suppression:**
- Session cycling (`[`/`]`) fires even from inside a ttyd iframe — it `.blur()`s the iframe and `.focus()`es the canvas root first
- `Ctrl+Enter` is explicitly suppressed when a ttyd iframe is active to avoid disrupting the terminal

## Registry

`src/hotkeys/registry.ts` exports a typed array of every hotkey definition:

```ts
type HotkeyDef = {
  id: string
  keys: string        // e.g. 'Ctrl+Shift+\\'
  scope: 'global' | 'canvas' | 'widget'
  category: string
  description: string
}
```

Handlers are **not** in the registry. Each scope hook maintains its own `Record<string, () => void>` keyed by `HotkeyDef.id`. This keeps the registry as pure readable data while each hook owns its action map.

The `?` command palette renders `registry.ts` directly — no separate reference doc to maintain.

---

## Hotgroups

Up to 10 named slots (`1`–`0`) for grouping runs, inspired by StarCraft control groups.

**Storage:** `localStorage` key `tinstar-hotgroups-v1-{spaceId}`. Each space has its own independent store.

```ts
type HotgroupStore = {
  [slot: string]: string[]  // slot '1'–'9', '0' → runId[]
}
```

A run may belong to multiple slots simultaneously. Stale run IDs are pruned when a run deletion SSE delta arrives.

**Key bindings (canvas scope):**

| Key | Action |
|-----|--------|
| `Ctrl+1`…`Ctrl+0` | Add selected run(s) to slot |
| `Ctrl+Shift+1`…`0` | Remove selected run(s) from slot |
| `1`…`0` | Select group + expand hierarchy |
| `1`…`0` (double-tap ≤300ms) | Zoom-to-fit all members |

Double-tap detection is per-slot: `1` → `2` within 300ms does not count as a double-tap on either slot.

**Visual indicator:** `⌨ 1 3` shown in widget title bar and sidebar row. If a run belongs to more than 3 slots, first 3 are shown with `+N` suffix. Omitted entirely when run belongs to no groups.

---

## Session Cycling + Ready-for-Input Queue

The server maintains an ordered `string[]` of session names currently ready for input. A session is "ready" when its status is `idle`, `creating`, or `needs_attention`.

**SSE transport:**
- Initial state: included as `ready_queue: string[]` in the snapshot
- Updates: `ready_queue_update` event with payload `{ queue: string[] }`

**Key bindings (global scope):**

| Key | Action |
|-----|--------|
| `]` | Next ready-for-input session |
| `[` | Previous ready-for-input session |
| `Shift+]` | Next session (all, regardless of status) |
| `Shift+[` | Previous session (all) |

Note: implemented via `e.code === 'BracketLeft'`/`'BracketRight'` + `e.shiftKey` (not `e.key`) because `Shift+[` produces `{` on standard keyboards.

"Select" behavior: highlight run widget on canvas, pan to bring it into view (60px margin), expand its sidebar hierarchy node.

---

## Terminal Focus Toggle

Terminal access uses a thin wrapper page at `/terminal-wrapper?session={name}` instead of embedding ttyd directly. The wrapper:

1. Embeds the ttyd URL in its own `<iframe>`
2. Listens for `Ctrl+Shift+\` and calls `window.parent.postMessage({ type: 'terminal-focus-toggle', sessionName }, '*')`

`RunSessionPanel` listens for this message, filtering by `sessionName` to prevent multiple widgets from toggling simultaneously.

**Why a wrapper:** injecting scripts via Caddy would require non-standard modules not available in `caddy:2`. The wrapper pattern requires no Caddy changes.

| Direction | Binding | Action |
|-----------|---------|--------|
| Dive in | `Ctrl+Shift+\` (widget focused) | `terminalFocused = true`, focus iframe |
| Escape out | `Ctrl+Shift+\` (terminal focused) | postMessage → `terminalFocused = false`, focus widget root |

---

## Tab Navigation Within a Run Widget

When a run widget has focus (`terminalFocused = false`), `Tab`/`Shift+Tab` cycle through zones:

`left-tab` → `file-list` (if left panel expanded) → `center-tabs` → `right-panel` → wrap

Active zone shows `ring-2 ring-indigo-500`. If left panel is collapsed, `left-tab` and `file-list` are skipped.

---

## Complete Hotkey Reference

| Key | Description | Scope |
|-----|-------------|-------|
| `?` | Open command palette | global |
| `Ctrl+Enter` | New session for selected entity | global |
| `]` | Next ready-for-input session | global |
| `[` | Previous ready-for-input session | global |
| `Shift+]` | Next session (all) | global |
| `Shift+[` | Previous session (all) | global |
| `Ctrl+Shift+\` | Toggle terminal / widget focus | widget+iframe |
| `Tab` / `Shift+Tab` | Next / previous panel zone | widget |
| `↑` / `↓` | Move between files | widget |
| `←` / `→` | Switch center tabs | widget |
| `Enter` | Open file / activate procedure | widget |
| `1`…`0` | Select hotgroup | canvas |
| `1`…`0` (×2) | Zoom-to-fit hotgroup | canvas |
| `Ctrl+1`…`0` | Add selection to hotgroup | canvas |
| `Ctrl+Shift+1`…`0` | Remove selection from hotgroup | canvas |
| `Ctrl+G` | Arrange grid | canvas |
| `Ctrl+Shift+G` | Reset layout | canvas |
| `Space` (hold) | Pan mode | canvas |
| `Alt+Z` | Reset zoom | canvas |
