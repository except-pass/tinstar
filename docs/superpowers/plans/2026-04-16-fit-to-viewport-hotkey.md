# Fit-to-Viewport Hotkey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Z` hotkey that, when a content widget (run-workspace, file-editor, browser-widget, image-viewer, nats-traffic) is focused, zooms canvas to 100%, resizes the widget's height to match the viewport, and pans the camera to center the widget. Also surfaces the existing `Alt+Z` (reset zoom) in the hotkeys sidebar and gives browser-widget / image-viewer / nats-traffic proper widget hotkey definitions.

**Architecture:** `Z` is registered as a normal widget-scope binding on each content widget type (same mechanism as `focus-next`, `tab-next`, etc.). A new module-level registry (`src/hotkeys/canvasActionsRegistry.ts`) — matching the existing `actionHandlerRegistry.ts` / `bindingFiredBus.ts` pattern — lets widget action handlers reach into `InfiniteCanvas`'s camera and layout state to perform the fit. `InfiniteCanvas` registers the fit implementation in a `useEffect`. Each content widget component's action handler adds one case that calls `fitWidgetToViewport(id)`.

**Tech Stack:** TypeScript, React 18, Vite, Vitest (unit), Playwright (e2e).

**Design spec:** [`docs/superpowers/specs/2026-04-16-fit-to-viewport-hotkey-design.md`](../specs/2026-04-16-fit-to-viewport-hotkey-design.md)

---

## Background: how widget hotkeys work in this codebase

Before starting tasks, an implementer unfamiliar with Tinstar should know these three things:

1. **Widget hotkey definitions** live in `src/hotkeys/widgets/*.ts`. Each file calls `registerWidget({ type, displayName, contexts, bindings })` at module load. Importing the file is enough to register — side-effect based.

2. **Widget action handlers** are registered from the widget component via `registerActionHandler(widgetId, fn)` (from `src/hotkeys/actionHandlerRegistry.ts`). When the focus-path tail is a widget of the matching type and a binding key fires, `useContextRouter` calls `dispatchAction(widgetId, action)` which invokes that handler. The handler is a `(action: string) => void` that switches on the action id.

3. **Camera + layouts** live in `src/components/InfiniteCanvas.tsx`. Camera is from `useCanvasCamera()` — exposes `camera`, `setCamera`. Layouts are from `useWidgetLayouts(tree, activeSpaceId)` — exposes `getLayout(id)`, `resizeNode(id, w, h)` (with cascade expansion), and `updateRunSize(id, w, h)` (the leaf-only variant). Both are needed to implement "fit to viewport."

We will not modify the hotkey dispatch plumbing. Only:
- Add `Z` to each content widget's `bindings` list.
- Add a tiny new registry module so widget handlers can imperatively reach `InfiniteCanvas`.
- Add one case to each content widget's existing action handler.

---

## File Structure

**New files:**

- `src/hotkeys/canvasActionsRegistry.ts` — module-level registry exposing `registerCanvasActions` / `fitWidgetToViewport`.
- `src/hotkeys/__tests__/canvasActionsRegistry.test.ts` — unit test for the registry.
- `src/hotkeys/widgets/browserWidget.ts` — `WidgetDefinition` for `browser-widget` (Z binding).
- `src/hotkeys/widgets/imageViewerWidget.ts` — `WidgetDefinition` for `image-viewer` (Z binding).
- `src/hotkeys/widgets/natsTrafficWidget.ts` — `WidgetDefinition` for `nats-traffic` (Z binding).

**Modified files:**

- `src/hotkeys/widgets/runWorkspaceWidget.ts` — add Z binding.
- `src/hotkeys/widgets/entityWidgets.ts` — add Z binding to `file-editor`.
- `src/hotkeys/widgets/index.ts` — import the three new widget-def files.
- `src/components/RunWorkspaceWidget/index.tsx` — action handler case for `'fit-viewport'`.
- `src/widgets/fileEditor/FileEditorWidget.tsx` — action handler case for `'fit-viewport'`.
- `src/widgets/browserWidget/BrowserWidget.tsx` — new `useEffect` that registers action handler with `'fit-viewport'` case.
- `src/widgets/imageViewer/ImageViewerWidget.tsx` — same pattern.
- `src/widgets/natsTraffic/NatsTrafficWidget.tsx` — same pattern.
- `src/components/InfiniteCanvas.tsx` — `useEffect` that calls `registerCanvasActions` with a fit implementation.
- `src/components/HotkeyBindingRow.tsx` — add `Alt+Z` to `CANVAS_KEYS`.

---

## Task 1: Create the `canvasActionsRegistry` module with tests

**Files:**
- Create: `src/hotkeys/canvasActionsRegistry.ts`
- Test: `src/hotkeys/__tests__/canvasActionsRegistry.test.ts`

- [ ] **Step 1: Create test file directory if it doesn't exist**

Run: `mkdir -p src/hotkeys/__tests__`

- [ ] **Step 2: Write the failing test**

Create `src/hotkeys/__tests__/canvasActionsRegistry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerCanvasActions,
  fitWidgetToViewport,
  _resetCanvasActionsRegistry,
} from '../canvasActionsRegistry'

describe('canvasActionsRegistry', () => {
  beforeEach(() => {
    _resetCanvasActionsRegistry()
  })

  it('fitWidgetToViewport is a no-op before any impl is registered', () => {
    // Should not throw
    expect(() => fitWidgetToViewport('widget-1')).not.toThrow()
  })

  it('dispatches fit to the registered impl', () => {
    const calls: string[] = []
    registerCanvasActions({ fit: (id) => calls.push(id) })

    fitWidgetToViewport('widget-1')
    fitWidgetToViewport('widget-2')

    expect(calls).toEqual(['widget-1', 'widget-2'])
  })

  it('deregister returned by registerCanvasActions clears the impl', () => {
    const calls: string[] = []
    const deregister = registerCanvasActions({ fit: (id) => calls.push(id) })

    fitWidgetToViewport('widget-1')
    deregister()
    fitWidgetToViewport('widget-2')

    expect(calls).toEqual(['widget-1'])
  })

  it('deregister only clears if the current impl matches (safe against late cleanup)', () => {
    const callsA: string[] = []
    const callsB: string[] = []
    const deregisterA = registerCanvasActions({ fit: (id) => callsA.push(id) })
    // Second register overwrites A's impl
    registerCanvasActions({ fit: (id) => callsB.push(id) })
    // A's cleanup runs late — should not wipe B
    deregisterA()

    fitWidgetToViewport('widget-1')

    expect(callsA).toEqual([])
    expect(callsB).toEqual(['widget-1'])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/hotkeys/__tests__/canvasActionsRegistry.test.ts`

Expected: FAIL — module `../canvasActionsRegistry` does not exist.

- [ ] **Step 4: Create the registry module**

Create `src/hotkeys/canvasActionsRegistry.ts`:

```ts
// src/hotkeys/canvasActionsRegistry.ts
//
// Module-level registry that lets widget action handlers reach canvas-level
// capabilities (camera + layout mutation) without prop-drilling or a React
// context. Matches the pattern used by actionHandlerRegistry.ts and
// bindingFiredBus.ts.
//
// InfiniteCanvas registers a `fit` impl in a useEffect; widget action
// handlers call fitWidgetToViewport(id) when their 'fit-viewport' action
// fires.

interface CanvasActions {
  fit: (nodeId: string) => void
}

let impl: CanvasActions | null = null

/**
 * Register the canvas actions implementation. Returns a cleanup function.
 * The cleanup only clears the impl if it's still the one we registered —
 * defensive against late cleanup after a later registration has overwritten.
 */
export function registerCanvasActions(fns: CanvasActions): () => void {
  impl = fns
  return () => {
    if (impl === fns) impl = null
  }
}

/** Fit the widget identified by nodeId to the viewport. No-op if no impl is registered. */
export function fitWidgetToViewport(nodeId: string): void {
  impl?.fit(nodeId)
}

/** Test-only: reset module state between tests. */
export function _resetCanvasActionsRegistry(): void {
  impl = null
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/hotkeys/__tests__/canvasActionsRegistry.test.ts`

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/hotkeys/canvasActionsRegistry.ts src/hotkeys/__tests__/canvasActionsRegistry.test.ts
git commit -m "feat: add canvasActionsRegistry for widget→canvas action plumbing #v3-7-0"
```

---

## Task 2: Register the fit implementation in `InfiniteCanvas`

**Files:**
- Modify: `src/components/InfiniteCanvas.tsx`

**Context for the implementer:** `InfiniteCanvas` already destructures `camera`, `setCamera` from `useCanvasCamera()` at line 171, and `resizeNode`, `updateRunSize`, `getLayout` from `useWidgetLayouts(...)` around lines 160-170. We'll use `getLayout` to read the current layout, `resizeNode` to grow it (this also cascades ancestor containers, which is what we want — same as any resize drag), and `setCamera` to zoom and pan in one atomic update.

`MIN_HEIGHT` from `useWidgetLayouts` is `150`; we duplicate that constant here rather than export it (the hook is the source of truth and already clamps — we're just being explicit for the clamp-to-min case).

- [ ] **Step 1: Add the import**

In `src/components/InfiniteCanvas.tsx`, add this import alongside the other `src/hotkeys/...` imports near the top of the file:

```ts
import { registerCanvasActions } from '../hotkeys/canvasActionsRegistry'
```

- [ ] **Step 2: Add the registration effect**

Locate the block inside `InfiniteCanvas` where `camera`, `setCamera`, `resizeNode`, and `getLayout` are all in scope (right after the `useCanvasHotkeys(...)` call is a reasonable home; use whatever the existing effect ordering prefers).

Add this effect:

```tsx
  // Register the canvas-level fit implementation so widget action handlers
  // can call fitWidgetToViewport(id) in response to the 'fit-viewport'
  // binding (Z key).
  useEffect(() => {
    const FIT_MIN_HEIGHT = 150 // mirrors MIN_HEIGHT in useWidgetLayouts.ts
    return registerCanvasActions({
      fit: (nodeId: string) => {
        const layout = getLayout(nodeId)
        if (!layout) return
        const vw = window.innerWidth
        const vh = window.innerHeight
        const newHeight = Math.min(vh, Math.max(FIT_MIN_HEIGHT, vh))
        // Grow/shrink the widget; cascade expansion updates ancestor containers.
        resizeNode(nodeId, layout.width, newHeight)
        // Center the (resized) widget in the viewport at zoom 1.
        const cx = vw / 2 - (layout.x + layout.width / 2)
        const cy = vh / 2 - (layout.y + newHeight / 2)
        setCamera({ x: Math.round(cx), y: Math.round(cy), zoom: 1 })
      },
    })
  }, [getLayout, resizeNode, setCamera])
```

**Notes for the implementer:**
- `resizeNode` already handles nested-container cascade expansion — no extra work needed.
- The `Math.min(vh, Math.max(FIT_MIN_HEIGHT, vh))` clamp reduces to just `vh` when viewport is ≥ 150, and to `FIT_MIN_HEIGHT` when viewport is absurdly small. Keep the explicit form — it documents the intent (height = viewport height, clamped).
- `Math.round` on camera x/y avoids sub-pixel rendering. The existing code rounds layout fields the same way.

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`

Expected: PASS, no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/InfiniteCanvas.tsx
git commit -m "feat: register canvas fit-to-viewport impl in InfiniteCanvas #v3-7-0"
```

---

## Task 3: Add the `Z` binding to `run-workspace`

**Files:**
- Modify: `src/hotkeys/widgets/runWorkspaceWidget.ts`

- [ ] **Step 1: Add the binding**

Replace the `bindings` array in `src/hotkeys/widgets/runWorkspaceWidget.ts` with:

```ts
// src/hotkeys/widgets/runWorkspaceWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'run-workspace',
  displayName: 'Agent Session',
  contexts: [
    { key: 'Ctrl+Backslash', type: 'run-terminal', label: 'Terminal' },
  ],
  bindings: [
    { key: 'Tab',        label: 'Next panel',        action: 'focus-next' },
    { key: 'Shift+Tab',  label: 'Prev panel',        action: 'focus-prev' },
    { key: 'ArrowDown',  label: 'Down in file list', action: 'file-down' },
    { key: 'ArrowUp',    label: 'Up in file list',   action: 'file-up' },
    { key: 'ArrowRight', label: 'Next tab',          action: 'tab-next' },
    { key: 'ArrowLeft',  label: 'Prev tab',          action: 'tab-prev' },
    { key: 'Enter',      label: 'Activate',          action: 'activate' },
    { key: 'KeyP',       label: 'Prompt composer',   action: 'toggle-prompt' },
    { key: 'KeyZ',       label: 'Fit to viewport',   action: 'fit-viewport' },
  ],
})
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/hotkeys/widgets/runWorkspaceWidget.ts
git commit -m "feat: add Z fit-to-viewport binding to run-workspace #v3-7-0"
```

---

## Task 4: Handle `'fit-viewport'` in `RunWorkspaceWidget`

**Files:**
- Modify: `src/components/RunWorkspaceWidget/index.tsx`

**Context:** The existing action handler is a `switch` inside a `useEffect` at roughly line 154. We'll add one more case that calls `fitWidgetToViewport`.

- [ ] **Step 1: Add the import**

Find the existing import from `../../hotkeys/actionHandlerRegistry` (around line 10) and add this import below it:

```ts
import { fitWidgetToViewport } from '../../hotkeys/canvasActionsRegistry'
```

- [ ] **Step 2: Add the `'fit-viewport'` case**

Inside the `switch (action)` block in the `registerActionHandler(run.id, ...)` effect, add a `'fit-viewport'` case alongside the others. No special handling for `terminalFocused` is needed — when the terminal iframe has focus, the binding router already returns early (see `contextRouter.ts` iframe guard), so `fit-viewport` can't dispatch in that state.

Replace the switch block:

```tsx
      switch (action) {
        case 'focus-next':      onFocusNext();                                    break
        case 'focus-prev':      onFocusPrev();                                    break
        case 'file-down':       setFileSelectionIndex(i => i + 1);               break
        case 'file-up':         setFileSelectionIndex(i => Math.max(i - 1, 0));  break
        case 'tab-next':        setCenterTabIndex(i => (i + 1) % 2);             break
        case 'tab-prev':        setCenterTabIndex(i => (i - 1 + 2) % 2);        break
        case 'activate':        /* no-op for now */                               break
        case 'toggle-prompt':   setPromptComposerExpanded(e => !e);              break
        case 'fit-viewport':    fitWidgetToViewport(run.id);                     break
      }
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 4: Manual smoke test**

Run: `TINSTAR_FAST_SIM=1 npm run dev`

Open `http://localhost:5280`. Click a run workspace to select it. Press `Z`.

Expected:
- Canvas zoom indicator (bottom-right HUD) shows `100%`.
- The widget's height grows to roughly match the viewport height.
- The widget is horizontally centered (its left and right edges visually equidistant from the viewport edges).

If zoom was already 100% and the widget was at viewport size, Z is a visual no-op — this is expected.

- [ ] **Step 5: Commit**

```bash
git add src/components/RunWorkspaceWidget/index.tsx
git commit -m "feat: wire Z fit-to-viewport in RunWorkspaceWidget #v3-7-0"
```

---

## Task 5: Add `Z` binding and handler to `file-editor`

**Files:**
- Modify: `src/hotkeys/widgets/entityWidgets.ts`
- Modify: `src/widgets/fileEditor/FileEditorWidget.tsx`

- [ ] **Step 1: Add the Z binding to file-editor's WidgetDefinition**

In `src/hotkeys/widgets/entityWidgets.ts`, replace the `file-editor` registration:

```ts
registerWidget({
  type: 'file-editor',
  displayName: 'File',
  contexts: [],
  bindings: [
    { key: 'KeyE', label: 'Open in editor',     action: 'open-in-editor' },
    { key: 'KeyW', label: 'Toggle word wrap',   action: 'toggle-word-wrap' },
    { key: 'KeyZ', label: 'Fit to viewport',    action: 'fit-viewport' },
  ],
})
```

Leave the `task`, `epic`, `initiative` registrations in the same file untouched — containers don't get Z.

- [ ] **Step 2: Add the import to FileEditorWidget**

In `src/widgets/fileEditor/FileEditorWidget.tsx`, below the existing import from `../../hotkeys/actionHandlerRegistry`:

```ts
import { fitWidgetToViewport } from '../../hotkeys/canvasActionsRegistry'
```

- [ ] **Step 3: Add the `'fit-viewport'` case**

Update the existing `registerActionHandler` effect (around line 123) to include the new action:

```tsx
  // Register hotkey action handlers for when this widget is the focused context
  useEffect(() => {
    registerActionHandler(widget.id, (action) => {
      if (action === 'open-in-editor') handleOpenInEditor()
      if (action === 'toggle-word-wrap') toggleWordWrap()
      if (action === 'toggle-diff') toggleDiff()
      if (action === 'fit-viewport') fitWidgetToViewport(widget.id)
    })
    return () => deregisterActionHandler(widget.id)
  }, [widget.id, handleOpenInEditor, toggleWordWrap, toggleDiff])
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Manual smoke test**

With the dev server still running (from Task 4), click a file widget on the canvas to select it. Press `Z`.

Expected: canvas zooms to 100%, file widget height grows to viewport height, horizontally centered.

- [ ] **Step 6: Commit**

```bash
git add src/hotkeys/widgets/entityWidgets.ts src/widgets/fileEditor/FileEditorWidget.tsx
git commit -m "feat: add Z fit-to-viewport for file-editor #v3-7-0"
```

---

## Task 6: New widget hotkey definition for `browser-widget`

**Files:**
- Create: `src/hotkeys/widgets/browserWidget.ts`
- Modify: `src/hotkeys/widgets/index.ts`
- Modify: `src/widgets/browserWidget/BrowserWidget.tsx`

- [ ] **Step 1: Create the WidgetDefinition**

Create `src/hotkeys/widgets/browserWidget.ts`:

```ts
// src/hotkeys/widgets/browserWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'browser-widget',
  displayName: 'Browser',
  contexts: [],
  bindings: [
    { key: 'KeyZ', label: 'Fit to viewport', action: 'fit-viewport' },
  ],
})
```

- [ ] **Step 2: Import the new file in `src/hotkeys/widgets/index.ts`**

Update `src/hotkeys/widgets/index.ts` to include the browser-widget import (Tasks 7 and 8 will add `imageViewerWidget` and `natsTrafficWidget` to this same file):

```ts
// src/hotkeys/widgets/index.ts
// Import all widget definitions to trigger registration side-effects
import './canvasWidget'
import './groupContainerWidget'
import './runTerminalWidget'
import './entityWidgets'
import './browserWidget'
// runWorkspaceWidget is imported directly by RunWorkspaceWidget/index.tsx
```

- [ ] **Step 3: Register the action handler in BrowserWidget**

In `src/widgets/browserWidget/BrowserWidget.tsx`:

First, add the imports near the top of the file, below the existing `useHotgroupContext` import:

```ts
import { registerActionHandler, deregisterActionHandler } from '../../hotkeys/actionHandlerRegistry'
import { fitWidgetToViewport } from '../../hotkeys/canvasActionsRegistry'
```

Then inside the `BrowserWidget` component, after the other `useEffect` hooks and before the `return` statement, add:

```tsx
  // Register hotkey action handler for this widget
  useEffect(() => {
    registerActionHandler(widget.id, (action) => {
      if (action === 'fit-viewport') fitWidgetToViewport(widget.id)
    })
    return () => deregisterActionHandler(widget.id)
  }, [widget.id])
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Manual smoke test**

With dev server running, if a browser widget exists on the canvas (create one via the + menu if needed), select it and press `Z`. Expected: zoom → 100%, widget fills viewport vertically, centered.

- [ ] **Step 6: Commit**

```bash
git add src/hotkeys/widgets/browserWidget.ts src/hotkeys/widgets/index.ts src/widgets/browserWidget/BrowserWidget.tsx
git commit -m "feat: add browser-widget hotkey def with Z fit-to-viewport #v3-7-0"
```

---

## Task 7: New widget hotkey definition for `image-viewer`

**Files:**
- Create: `src/hotkeys/widgets/imageViewerWidget.ts`
- Modify: `src/hotkeys/widgets/index.ts`
- Modify: `src/widgets/imageViewer/ImageViewerWidget.tsx`

- [ ] **Step 1: Create the WidgetDefinition**

Create `src/hotkeys/widgets/imageViewerWidget.ts`:

```ts
// src/hotkeys/widgets/imageViewerWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'image-viewer',
  displayName: 'Image',
  contexts: [],
  bindings: [
    { key: 'KeyZ', label: 'Fit to viewport', action: 'fit-viewport' },
  ],
})
```

- [ ] **Step 2: Add the import to `src/hotkeys/widgets/index.ts`**

Update `src/hotkeys/widgets/index.ts` to include the new file:

```ts
// src/hotkeys/widgets/index.ts
// Import all widget definitions to trigger registration side-effects
import './canvasWidget'
import './groupContainerWidget'
import './runTerminalWidget'
import './entityWidgets'
import './browserWidget'
import './imageViewerWidget'
// runWorkspaceWidget is imported directly by RunWorkspaceWidget/index.tsx
```

- [ ] **Step 3: Register the action handler in ImageViewerWidget**

In `src/widgets/imageViewer/ImageViewerWidget.tsx`:

Add these imports near the top, below the existing `useHotgroupContext` import:

```ts
import { registerActionHandler, deregisterActionHandler } from '../../hotkeys/actionHandlerRegistry'
import { fitWidgetToViewport } from '../../hotkeys/canvasActionsRegistry'
```

Inside the `ImageViewerWidget` component, after the other `useEffect` hooks and before the `return`, add:

```tsx
  // Register hotkey action handler for this widget
  useEffect(() => {
    registerActionHandler(widget.id, (action) => {
      if (action === 'fit-viewport') fitWidgetToViewport(widget.id)
    })
    return () => deregisterActionHandler(widget.id)
  }, [widget.id])
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Manual smoke test**

With dev server running, select an image widget and press Z. Expected: zoom → 100%, widget fills viewport vertically, centered.

- [ ] **Step 6: Commit**

```bash
git add src/hotkeys/widgets/imageViewerWidget.ts src/hotkeys/widgets/index.ts src/widgets/imageViewer/ImageViewerWidget.tsx
git commit -m "feat: add image-viewer hotkey def with Z fit-to-viewport #v3-7-0"
```

---

## Task 8: New widget hotkey definition for `nats-traffic`

**Files:**
- Create: `src/hotkeys/widgets/natsTrafficWidget.ts`
- Modify: `src/hotkeys/widgets/index.ts`
- Modify: `src/widgets/natsTraffic/NatsTrafficWidget.tsx`

- [ ] **Step 1: Create the WidgetDefinition**

Create `src/hotkeys/widgets/natsTrafficWidget.ts`:

```ts
// src/hotkeys/widgets/natsTrafficWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'nats-traffic',
  displayName: 'NATS Traffic',
  contexts: [],
  bindings: [
    { key: 'KeyZ', label: 'Fit to viewport', action: 'fit-viewport' },
  ],
})
```

- [ ] **Step 2: Add the import to `src/hotkeys/widgets/index.ts`**

Update `src/hotkeys/widgets/index.ts`:

```ts
// src/hotkeys/widgets/index.ts
// Import all widget definitions to trigger registration side-effects
import './canvasWidget'
import './groupContainerWidget'
import './runTerminalWidget'
import './entityWidgets'
import './browserWidget'
import './imageViewerWidget'
import './natsTrafficWidget'
// runWorkspaceWidget is imported directly by RunWorkspaceWidget/index.tsx
```

- [ ] **Step 3: Register the action handler in NatsTrafficWidget**

In `src/widgets/natsTraffic/NatsTrafficWidget.tsx`:

Add these imports near the top:

```ts
import { registerActionHandler, deregisterActionHandler } from '../../hotkeys/actionHandlerRegistry'
import { fitWidgetToViewport } from '../../hotkeys/canvasActionsRegistry'
```

Inside the `NatsTrafficWidget` component, after the other `useEffect` hooks and before the `return`, add:

```tsx
  // Register hotkey action handler for this widget
  useEffect(() => {
    registerActionHandler(widget.id, (action) => {
      if (action === 'fit-viewport') fitWidgetToViewport(widget.id)
    })
    return () => deregisterActionHandler(widget.id)
  }, [widget.id])
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Manual smoke test**

With dev server running, select a nats-traffic widget (create one if needed) and press Z. Expected: zoom → 100%, widget fills viewport vertically, centered.

- [ ] **Step 6: Commit**

```bash
git add src/hotkeys/widgets/natsTrafficWidget.ts src/hotkeys/widgets/index.ts src/widgets/natsTraffic/NatsTrafficWidget.tsx
git commit -m "feat: add nats-traffic hotkey def with Z fit-to-viewport #v3-7-0"
```

---

## Task 9: Surface `Alt+Z` in the hotkeys sidebar

**Files:**
- Modify: `src/components/HotkeyBindingRow.tsx`

**Context:** `Alt+Z` is handled inline in `src/hooks/useCanvasCamera.ts:47-63` and is not routed through the widget binding system. It needs to appear in the Canvas section of the hotkeys sidebar for discoverability.

- [ ] **Step 1: Add Alt+Z to CANVAS_KEYS**

In `src/components/HotkeyBindingRow.tsx`, replace the `CANVAS_KEYS` export:

```ts
export const CANVAS_KEYS: Array<{ key: string; label: string }> = [
  { key: 'Ctrl+G',    label: 'Arrange grid' },
  { key: 'Ctrl+L',    label: 'Swim lanes' },
  { key: 'Alt+KeyZ',  label: 'Reset zoom' },
]
```

**Note on key format:** `formatKey` (in `src/hotkeys/widgetTypes.ts:43-55`) renders `KeyZ` → `Z` and preserves the `Alt+` prefix, so the badge displays as `Alt+Z`. Verify by reading the function body if unsure.

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 3: Manual smoke test**

Reload the dev server page. Click empty canvas (to drop focus back to canvas context). Open the hotkeys sidebar.

Expected: the "Canvas" section lists three entries: `Ctrl+G Arrange grid`, `Ctrl+L Swim lanes`, `Alt+Z Reset zoom`.

Press `Alt+Z`. Expected: zoom resets to 100% (preexisting behavior); no flourish animation on the sidebar row (the existing Alt+Z handler in `useCanvasCamera.ts` doesn't call `emitBindingFired` — a pre-existing cosmetic gap, not a regression from this change; do not fix here).

- [ ] **Step 4: Commit**

```bash
git add src/components/HotkeyBindingRow.tsx
git commit -m "feat: surface Alt+Z (reset zoom) in hotkeys sidebar #v3-7-0"
```

---

## Task 10: End-to-end test

**Files:**
- Create: `e2e/fit-to-viewport.spec.ts`

**Context:** The repo's existing e2e tests live under `e2e/` and are run with `TINSTAR_FAST_SIM=1 npx playwright test`. `TINSTAR_FAST_SIM=1` populates the canvas with a mock run workspace we can key off.

Look at `e2e/run-visibility.spec.ts` (already present in the working tree) for a reference pattern — selecting a run, keyboard input, and how tests locate widget DOM nodes via `data-testid="canvas-widget-<id>"`.

- [ ] **Step 1: Examine the existing reference test to match conventions**

Run: `cat e2e/run-visibility.spec.ts | head -50`

Note the imports, baseURL/config expectations, and selector patterns used.

- [ ] **Step 2: Write the e2e test**

Create `e2e/fit-to-viewport.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

test.describe('Z hotkey — fit widget to viewport', () => {
  test('Z on a focused run workspace zooms to 100% and grows widget to viewport height', async ({ page }) => {
    await page.goto('/')

    // Wait for at least one run-workspace widget to render on the canvas.
    const widget = page.locator('[data-testid^="canvas-widget-"][data-widget-type="run-workspace"]').first()
    await expect(widget).toBeVisible({ timeout: 10_000 })

    // Click to select the widget. Click the header (drag handle) to avoid triggering
    // any interactive sub-control.
    const header = widget.locator('.widget-drag-handle').first()
    await header.click()

    // Confirm selection (the shell sets data-selected="true" on select).
    await expect(widget).toHaveAttribute('data-selected', 'true')

    // Read viewport height for comparison.
    const viewportHeight = await page.evaluate(() => window.innerHeight)

    // Press Z — bare key, no modifiers.
    await page.keyboard.press('KeyZ')

    // Zoom should be 100% — the canvas HUD renders "100%" somewhere visible.
    await expect(page.locator('text=100%').first()).toBeVisible({ timeout: 2_000 })

    // Widget height in screen pixels should be very close to viewport height
    // (allow small tolerance for borders/rounding).
    const box = await widget.boundingBox()
    expect(box).not.toBeNull()
    expect(Math.abs((box!.height) - viewportHeight)).toBeLessThan(8)

    // Widget should be roughly horizontally centered.
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    const widgetCenter = box!.x + box!.width / 2
    expect(Math.abs(widgetCenter - viewportWidth / 2)).toBeLessThan(8)
  })

  test('Z with no widget focused does nothing', async ({ page }) => {
    await page.goto('/')

    // Wait for canvas to be ready.
    await page.waitForSelector('[data-testid^="canvas-widget-"]', { timeout: 10_000 })

    // Click empty canvas to drop any selection.
    // The canvas container is the parent of widget shells; click well away from widgets.
    await page.mouse.click(20, 20)

    // Read a widget's initial size for comparison.
    const widget = page.locator('[data-testid^="canvas-widget-"][data-widget-type="run-workspace"]').first()
    const before = await widget.boundingBox()
    expect(before).not.toBeNull()

    // Press Z — should be a no-op (no widget is focused).
    await page.keyboard.press('KeyZ')

    // Same size after — no resize happened.
    const after = await widget.boundingBox()
    expect(after).not.toBeNull()
    expect(Math.abs(after!.height - before!.height)).toBeLessThan(2)
  })
})
```

- [ ] **Step 3: Run the test**

Run: `TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5280 npx playwright test fit-to-viewport.spec.ts`

Note: the dev server must be running (`TINSTAR_FAST_SIM=1 npm run dev` in another terminal). If the test harness expects the server to be started differently in this repo, check `playwright.config.ts` first.

Expected: both tests PASS.

- [ ] **Step 4: If tests fail, debug before proceeding**

Common issues:
- `text=100%` may match multiple elements — narrow to the HUD locator if so (`page.locator('[data-testid="canvas-hud"]')` or similar, depending on what's in `CanvasHud.tsx`).
- The mock simulator may not produce a run-workspace widget at the path expected — inspect with `await page.pause()` during development.
- The click-at-(20,20) might not actually be empty canvas depending on layout — check visually.

Fix inline, re-run.

- [ ] **Step 5: Commit**

```bash
git add e2e/fit-to-viewport.spec.ts
git commit -m "test: e2e for Z fit-to-viewport hotkey #v3-7-0"
```

---

## Task 11: Full-suite regression check and final commit

- [ ] **Step 1: Run the full unit test suite**

Run: `npx vitest run`

Expected: all tests PASS, including our new `canvasActionsRegistry.test.ts`.

- [ ] **Step 2: Full type check**

Run: `npx tsc --noEmit`

Expected: PASS, no errors.

- [ ] **Step 3: Run all e2e tests**

Run: `TINSTAR_FAST_SIM=1 npx playwright test`

Expected: all tests PASS, no regressions from the widget registrations / action handler additions.

- [ ] **Step 4: Visual sanity review**

With dev server running (`TINSTAR_FAST_SIM=1 npm run dev`), visit `http://localhost:5280` and verify:

- Select a run workspace → hotkeys sidebar shows `Z Fit to viewport` in the run-workspace bindings section.
- Select a file widget → sidebar shows `Z Fit to viewport`.
- Click empty canvas → sidebar's Canvas section shows `Alt+Z Reset zoom`.
- Press Z with a run focused → zoom = 100%, widget = viewport height, centered.
- Press Alt+Z from canvas context → zoom = 100%, no widget resize.
- Press Z then Alt+Z → idempotent no-op (already at 100%).
- Press Z with a task container selected → nothing happens (expected, containers don't have the binding).

- [ ] **Step 5: Nothing to commit if all checks pass**

If all checks pass, there should be no remaining uncommitted changes from this plan. Verify with:

Run: `git status`

Expected: no modified files (all changes from tasks 1-10 already committed).

---

## Self-review notes

Coverage against spec:

- ✅ Hotkey `KeyZ` registered on all five content widget types (Tasks 3, 5, 6, 7, 8).
- ✅ Resize to viewport height with MIN_HEIGHT clamp (Task 2).
- ✅ Zoom to 100% in same camera update (Task 2).
- ✅ Pan to center widget (Task 2).
- ✅ Cascade expansion preserved via `resizeNode` (Task 2, uses existing hook method).
- ✅ `browser-widget` / `image-viewer` / `nats-traffic` get first-class hotkey defs (Tasks 6-8).
- ✅ `Alt+Z` surfaced in sidebar (Task 9).
- ✅ `canvasActionsRegistry` pattern matches existing `actionHandlerRegistry` / `bindingFiredBus` (Task 1).
- ✅ Test coverage: unit for the registry (Task 1), e2e for the whole flow (Task 10).

Placeholder/consistency check:

- Action id is `'fit-viewport'` in every task. ✓
- Action registry function name is `fitWidgetToViewport` in every task. ✓
- Registration function is `registerCanvasActions({ fit })` in both producer (Task 2) and the test (Task 1). ✓
- Widget type strings (`'run-workspace'`, `'file-editor'`, `'browser-widget'`, `'image-viewer'`, `'nats-traffic'`) match the `WidgetRegistration.type` strings in the widget component registry. ✓
- No "TBD"/"TODO"/"handle edge cases" placeholders. ✓
