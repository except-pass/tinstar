# Canvas Widget UX Contract

Standard behaviors every canvas widget must implement. `FileEditorWidget` is the reference implementation.

---

## Selection

Handled entirely by `CanvasWidgetShell` — widgets don't need to implement this.

- **Single click** anywhere on a widget selects it and deselects all others.
- **Ctrl/Meta + click** toggles additive selection.
- **Click on empty canvas** deselects everything.
- **Escape** deselects all and returns focus to the canvas.
- Selected widgets gain `isSelected: true` via `WidgetProps` so they can style themselves accordingly. The standard pattern is a color-aware border + box-shadow using the widget's accent color:

```tsx
const borderStyle = isDragging
  ? { borderColor: hexToRgba(accent, 0.9), boxShadow: `0 20px 80px ${hexToRgba(accent, 0.4)}, 0 0 0 2px ${hexToRgba(accent, 0.8)}` }
  : isSelected
    ? { borderColor: hexToRgba(accent, 0.9), boxShadow: `0 0 0 1px ${hexToRgba(accent, 0.5)}, 0 0 16px ${hexToRgba(accent, 0.25)}` }
    : isHovered
      ? { borderColor: hexToRgba(accent, 0.5), boxShadow: `0 0 6px ${hexToRgba(accent, 0.15)}` }
      : { borderColor: hexToRgba(accent, 0.2), boxShadow: 'none' }
```

Use `resolveRunAccent(widget.color)` to get the accent color (falls back to the default cyan if no color is set). Apply `borderStyle` to the widget's root `div` with `className="... border"`.

The **hierarchy sidebar icon** should also reflect the widget type — `BrowserWidget` shows 🌐, `FileEditor` shows 📄. Icon is set in `HierarchySidebar` at the node type switch.

The shell applies z-index automatically: hovered → 10, selected → 20, dragging → 30. Container widgets (`isContainer: true`) are excluded from z-index management (they always sit behind their children).

---

## Drag

Handled by `CanvasWidgetShell`. Requires a drag handle element.

- Any element with the CSS class `.widget-drag-handle` (or a custom selector registered in `dragHandleSelector`) is the drag target.
- **Pointer capture is acquired immediately** at `pointerdown` so fast mouse movement never escapes the widget before the drag threshold is reached.
- A **5px movement threshold** separates a click from a drag — small movements don't accidentally reposition widgets.
- A **ghost outline** (dashed cyan border) shows the widget's origin position while dragging.
- **Escape** cancels an in-progress drag and releases pointer capture. The widget position snaps back because the server isn't updated until drag end.
- `onDragStart` / `onDragEnd` are called at threshold-crossing and pointer-up respectively; `InfiniteCanvas` uses these to display the ghost.

**Header sizing:** drag handles should be at least ~36px tall. Thin headers are frustrating to grab. Use `py-2.5` minimum on the header element.

---

## Resize

Handled by `CanvasWidgetShell`. No widget-level code needed.

- A 12×12px resize handle sits in the bottom-right corner (`cursor-se-resize`).
- Same 5px threshold as drag.
- **Escape** cancels an in-progress resize.
- `minSize` from `WidgetRegistration` is enforced — the widget cannot be shrunk below it.

---

## Close

Every non-container widget must have a close button in its header.

- The button calls `DELETE /api/<entity-type>/:id`.
- No confirmation dialog — deletion is immediate and reflected via SSE.
- The close button must stop pointer propagation so it doesn't trigger a canvas drag:
  ```tsx
  <button onPointerDown={e => e.stopPropagation()} onClick={handleClose}>
    <span className="material-symbols-outlined text-sm">close</span>
  </button>
  ```
- The `×` / `close` icon is standard. Use `material-symbols-outlined`.

---

## Spawn Animation

New widgets animate in with a color glow when first placed on the canvas.

- `CanvasWidgetShell` applies the `widget-spawning` class and CSS custom properties (`--spawn-glow-*`) when `isSpawning` is true.
- `InfiniteCanvas` tracks spawned node IDs and clears the flag after the animation completes.
- `spawnColor` should be the run's accent color (or `undefined` for the default cyan).
- Widgets don't implement this themselves — they just need to avoid overriding `opacity` or `transition` on their root element during spawn.

---

## Double-Click to Zoom

Double-clicking a widget centers the viewport on it.

- `CanvasWidgetShell` fires `onDoubleClickZoom(nodeId)` on double-click.
- `InfiniteCanvas.handleDoubleClickZoom` handles it: run nodes call `onFocusRun`; non-container widgets call `zoomToFitRuns([nodeId])`.
- Every non-container widget gets this for free as long as its `node.type` is wired in the `onDoubleClickZoom` conditional in `renderNode`:
  ```tsx
  onDoubleClickZoom={node.type === 'run' || node.type === 'file-editor' || node.type === 'browser-widget' ? handleDoubleClickZoom : undefined}
  ```
  Add new widget types to this list when registering them.

---

## Focus / Hotkeys

Selecting a widget pushes it onto `FocusPathContext`, which enables keyboard navigation and widget-specific hotkey actions.

- `CanvasWidgetShell` calls `onSelect(nodeId, additive)` on pointer-down.
- `WorkspaceShell` maps selected node → `FocusNode` and calls `pushFocus`.
- Widgets that expose keyboard actions call `registerActionHandler(widgetId, handler)` on mount and `deregisterActionHandler(widgetId)` on unmount.
- The context router dispatches `action` strings (e.g. `'close'`, `'open-in-editor'`) to the registered handler for the currently focused widget.

In-widget interactive elements (inputs, buttons, URL bars) must call `e.stopPropagation()` on `pointerDown` so they don't accidentally trigger canvas-level drag or deselection.

---

## Dim Effect

When one or more run widgets are selected, all *other* run widgets dim to 40% opacity.

- Controlled by `isDimmed` prop from `CanvasWidgetShell`.
- Non-run widgets are never dimmed (the shell only sets `isDimmed` when `selectionState.selectedType === 'run'`).
- Dimming uses `opacity-40` / `opacity-100` Tailwind classes with a 150ms transition.

---

## Header Conventions

All widgets use the same header pattern:

```tsx
<div className="widget-drag-handle flex items-center gap-2 px-3 py-2.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab">
  {/* icon + title (truncated) */}
  <span className="flex-1 text-2xs font-mono text-slate-400 truncate">…</span>
  {/* action buttons — each with onPointerDown={e => e.stopPropagation()} */}
  <button onPointerDown={e => e.stopPropagation()} onClick={handleClose}>
    <span className="material-symbols-outlined text-sm">close</span>
  </button>
</div>
```

- `widget-drag-handle` class on the header element makes it the drag target.
- `py-2.5` minimum for comfortable grabbing (~36px total height).
- All action buttons inside the header stop pointer propagation to avoid triggering canvas drag.
- Buttons that navigate away or affect external state should use `onPointerDown={e => e.stopPropagation()}`.

---

## Summary: What the Shell Owns vs. What Widgets Own

| Behavior | Owner |
|---|---|
| Absolute positioning on canvas | Shell |
| Click-to-select | Shell |
| Drag (pointer capture, threshold, ghost) | Shell |
| Resize handle | Shell |
| Z-index (hover / select / drag) | Shell |
| Spawn animation (`widget-spawning` class) | Shell |
| Double-click zoom | Shell |
| Escape to cancel drag/resize | Shell |
| Widget content rendering | Widget |
| Close button | Widget |
| Header drag handle element | Widget |
| Hotkey action handler | Widget |
| Interactive element pointer isolation | Widget |
