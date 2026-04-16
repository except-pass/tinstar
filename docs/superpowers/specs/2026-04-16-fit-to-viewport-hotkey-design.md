# Fit-to-Viewport Hotkey (Z) — Design

## Problem

When a user wants to focus on a single widget — a run workspace, a file, a browser — they currently have to manually zoom the canvas to 100% and drag the widget's resize handle to fill the vertical space. This is fiddly and breaks flow. They also can't tell that `Alt+Z` (already wired to reset zoom) exists because it doesn't appear in the hotkeys sidebar.

## Goal

One hotkey that:

1. Sets canvas zoom to 100%
2. Resizes the focused content widget so its height equals the viewport height
3. Pans the camera so the widget is centered horizontally (and vertically, for the clamp-to-min case)

So pressing `Z` on a focused run workspace "maximizes" it into the viewport — zoom restored, widget fills the vertical space, centered horizontally. Width is untouched.

As a secondary fix: surface the existing `Alt+Z` (zoom reset) in the hotkeys sidebar.

## Hotkey

- **Key:** `KeyZ` (bare, no modifiers)
- **Label:** `Fit to viewport`
- **Action id:** `fit-viewport`
- **Scope:** per-widget binding, registered on every content-widget type

Content widgets (non-container, leaf-rendered widgets): `run-workspace`, `file-editor`, `browser-widget`, `image-viewer`, `nats-traffic`.

Containers (`task`, `epic`, `initiative`, `group-container`) do **not** receive this binding — fitting a container to viewport interacts awkwardly with child-layout constraints and the use case isn't clear.

## Behavior

When `Z` fires on a focused content widget with layout `{ x, y, width, height }`:

1. **Compute new height:** `newHeight = clamp(window.innerHeight, MIN_HEIGHT, window.innerHeight)` — effectively `window.innerHeight`, bounded below by the existing `MIN_HEIGHT = 150` in `useWidgetLayouts.ts`.
2. **Resize widget:** call `resizeNode(id, width, newHeight)`. Width is preserved. Existing cascade-expansion behavior applies — if the widget lives inside a container, the container grows to contain it, exactly as it would for a drag-resize.
3. **Zoom to 100%:** set `camera.zoom = 1`.
4. **Pan to center:** compute `camera.x` and `camera.y` such that at zoom 1, the widget's center lands at `(viewportW/2, viewportH/2)`:
   - `camera.x = viewportW/2 - (x + width/2)`
   - `camera.y = viewportH/2 - (y + newHeight/2)`

The zoom and camera change happens in a single `setCamera` call so it commits in one frame.

Behavior is idempotent — pressing Z a second time on a widget already at viewport height and zoom 1 and centered is a no-op.

## Scope: other widgets get hotkey defs too

`browser-widget`, `image-viewer`, `nats-traffic` currently have `registerWidgetComponent` (for canvas rendering) but no `registerWidget` (for hotkeys) — so they show "no bindings" in the sidebar when focused.

We register a minimal widget hotkey definition for each (just the `Z` binding, for now). Per our convention, every widget should have a widget hotkey definition even if it starts with a single binding — it gives the widget a place in the hotkey sidebar and a natural home for future bindings.

## Implementation

### The binding system (no new concepts)

`Z` goes into each content widget's `WidgetDefinition` bindings list alongside the existing ones. When Z is pressed and the focus-path tail is one of those widget types, the existing `useContextRouter` dispatches `action: 'fit-viewport'` to the widget's registered action handler via `dispatchAction(widgetId, 'fit-viewport')`. Same path as `focus-next`, `tab-next`, etc.

### Plumbing: reach camera and layout from a widget's action handler

The widget's action handler lives in the widget component (`RunWorkspaceWidget`, `FileEditorWidget`, etc.). To handle `fit-viewport`, it needs to call `resizeNode` and `setCamera`, both of which live at the `InfiniteCanvas` level.

We add a small module-level registry that mirrors the existing `actionHandlerRegistry` / `bindingFiredBus` pattern:

**`src/hotkeys/canvasActionsRegistry.ts`**
```ts
let fitImpl: ((nodeId: string) => void) | null = null

export function registerCanvasActions(fns: { fit: (nodeId: string) => void }): () => void {
  fitImpl = fns.fit
  return () => { if (fitImpl === fns.fit) fitImpl = null }
}

export function fitWidgetToViewport(nodeId: string): void {
  fitImpl?.(nodeId)
}
```

- `InfiniteCanvas` calls `registerCanvasActions({ fit })` in a `useEffect` after `camera`, `layouts`, and `resizeNode` are in scope. The returned cleanup deregisters.
- Each content widget's action handler adds one case: `if (action === 'fit-viewport') fitWidgetToViewport(id)`.

This matches the codebase's existing approach for hotkey plumbing (imperative module-level registries, not React context), keeps the binding contract intact, and avoids prop-drilling `onFitViewport` through `CanvasWidgetShell`.

### Files touched

**New:**
- `src/hotkeys/canvasActionsRegistry.ts` — tiny module described above.
- `src/hotkeys/widgets/browserWidget.ts` — `registerWidget({ type: 'browser-widget', ... })`.
- `src/hotkeys/widgets/imageViewerWidget.ts` — `registerWidget({ type: 'image-viewer', ... })`.
- `src/hotkeys/widgets/natsTrafficWidget.ts` — `registerWidget({ type: 'nats-traffic', ... })`.

**Modified:**
- `src/hotkeys/widgets/runWorkspaceWidget.ts` — add `Z` binding.
- `src/hotkeys/widgets/entityWidgets.ts` — add `Z` binding to the `file-editor` definition.
- `src/hotkeys/widgets/index.ts` — import the three new widget-definition files for side-effect registration (pattern matches the other widget defs).
- `src/components/RunWorkspaceWidget/index.tsx` — action handler handles `'fit-viewport'`.
- `src/widgets/fileEditor/FileEditorWidget.tsx` — action handler handles `'fit-viewport'`.
- `src/widgets/browserWidget/BrowserWidget.tsx` — register an action handler that handles `'fit-viewport'` (no prior handler existed).
- `src/widgets/imageViewer/ImageViewerWidget.tsx` — same.
- `src/widgets/natsTraffic/NatsTrafficWidget.tsx` — same.
- `src/components/InfiniteCanvas.tsx` — register `fit` impl that performs zoom/resize/pan.
- `src/components/HotkeyBindingRow.tsx` — add `{ key: 'Alt+Z', label: 'Reset zoom' }` to `CANVAS_KEYS`.

### Selection / focus preconditions

Z fires only when a content widget is the focus-path tail. The existing selection→focus sync in `WorkspaceShellInner` (the `useLayoutEffect` at `WorkspaceShell.tsx:580`) pushes the selected widget onto the focus path, so selecting via sidebar or canvas click is sufficient. No new selection behavior needed.

## Edge cases

- **No widget focused:** Z doesn't fire — the binding is widget-scoped.
- **Viewport smaller than `MIN_HEIGHT`:** clamp prevents widget from becoming unusably small; it stays at `MIN_HEIGHT = 150`.
- **Nested in a container:** the container cascades open exactly as it would for a manual resize; no special handling.
- **Multi-select:** focus-path tail is the first selected node (per existing `selectedFocusNode` logic). Z acts on that one. Consistent with how other widget-scope bindings work today.
- **Already at target state:** zoom = 1, height = viewport, x centered → `setCamera` and `resizeNode` are both called but produce the same state. Idempotent, no visible change.
- **Widget with a `textarea` focused:** the binding system already checks `isEditable(active)` and blocks non-chord bindings when an editable element is focused (`contextRouter.ts:98`). So typing "z" in the prompt composer won't trigger the hotkey. Good.

## Testing

- **Unit:** smoke test the `canvasActionsRegistry` — register / call / deregister. Low-value but trivial.
- **Manual / E2E:**
  - Focus a run workspace at zoom 0.5, press Z → zoom = 1, widget height ≈ viewport, widget horizontally centered.
  - Focus a file widget, same.
  - Press Z with no widget focused → nothing happens.
  - Press Z with a task container focused → nothing happens (no binding on containers).
  - Press Z while typing in the prompt composer → letter "z" inserted, no zoom/resize.
  - Open hotkeys sidebar with a run workspace focused → "Fit to viewport — Z" visible.
  - Open hotkeys sidebar with no focus (canvas context) → "Reset zoom — Alt+Z" visible under Canvas section.

## Out of scope

- Horizontal-fit variant (e.g. `Shift+Z` to fit width). Easy to add later if wanted.
- Restoring pre-fit size/zoom (e.g. double-tap Z). The existing "reset layout" / manual drag covers this well enough for v1.
- Containers (`task`, `epic`, `initiative`) getting Z. Revisit if the use case surfaces.
