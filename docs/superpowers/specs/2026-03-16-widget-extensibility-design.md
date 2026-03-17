# Widget Extensibility — Rendering Contract (Sub-project ③)

**Date**: 2026-03-16
**Status**: Approved

## Problem

`InfiniteCanvas.renderNode()` has two hardcoded branches: `node.type === 'run'` renders `CanvasWidget`/`RunWorkspaceWidget`, everything else renders `GroupContainer`. There is no way to add new widget types without editing `InfiniteCanvas`. Drag/resize/selection chrome is hardcoded in `CanvasWidget.tsx` with no per-widget customization. Widgets cannot respond to canvas zoom level. As new entity types (telemetry, custom agents, etc.) are added to the task hierarchy, the canvas needs a registration-based render path.

## Solution

Three pieces:

1. **Widget Component Registry** — a type-string → component mapping that `InfiniteCanvas` uses instead of hardcoded branches.
2. **CanvasWidgetShell** — a generic replacement for `CanvasWidget.tsx` that owns drag/resize/selection and delegates all visual personality to the widget.
3. **Widget contract** — what every widget component receives as props, and what it optionally declares in its registration.

This sub-project does NOT change the hotkey/context system (sub-project ①②), server entity models, or layout storage.

---

## Widget Component Registry

**File:** `src/widgets/widgetComponentRegistry.ts`

A singleton map of `type → WidgetRegistration`. Widgets self-register at module load via `registerWidgetComponent(reg)`.

```typescript
interface WidgetRegistration {
  type: string                    // e.g. 'run-workspace', 'task-group', 'telemetry'
  component: React.ComponentType<WidgetProps>
  defaultSize: { width: number; height: number }
  minSize: { width: number; height: number }
  dragHandleSelector?: string     // CSS selector within component DOM; default: '.widget-drag-handle'
  getFrameClass?: (state: WidgetFrameState) => string  // classes applied to shell's outer frame div
  supportsMinimize?: boolean      // opt-in; shell renders collapse chrome if true
}

interface WidgetFrameState {
  isDragging: boolean
  isSelected: boolean
  isHovered: boolean
}
```

Registration rules (throw on violation, never silently override):
- Duplicate `type` string throws.
- Registering a `type` that matches an existing hotkey registry entry with a conflicting display name throws (the two registries are independent but must agree on display names per type).

`getWidget(type)` returns the registration or `undefined`. Callers handle undefined gracefully — the canvas skips unknown node types with a `console.warn`.

---

## Widget Props Contract

Every registered component receives:

```typescript
interface WidgetProps {
  data: unknown          // entity data for this node (RunData, group config, telemetry config, etc.)
  zoom: number           // raw canvas zoom float — widget quantizes as needed
  isSelected: boolean
  isDragging: boolean
  isHovered: boolean
}
```

`data` is typed `unknown` at the contract level. Each widget casts it to its own data type internally. The canvas passes `run` for `'run-workspace'` nodes, the group record for group nodes, etc. — whatever the entity store provides for that node.

Widgets own all internal visual behavior. They receive `zoom` raw and quantize it themselves — different widget types have different zoom thresholds that matter to them. The terminal widget uses zoom to adjust ttyd font size; a telemetry widget might use it to show/hide axis labels.

---

## CanvasWidgetShell

**File:** `src/widgets/CanvasWidgetShell.tsx`

Replaces `CanvasWidget.tsx`. Works for any registered widget type.

**What the shell owns:**
- Absolute positioning (`x`, `y`, `width`, `height`) on the canvas
- Drag — pointer events on the element matching `dragHandleSelector` (default `.widget-drag-handle`)
- Resize — bottom-right corner handle
- Selection highlight
- Hover tracking
- Minimize chrome (title-bar collapse) when `supportsMinimize: true`
- Calling `getFrameClass(state)` and applying the result to its own outer frame `div`

**What the shell does not own:**
- Any visual effect inside the widget boundary
- Zoom quantization
- Widget-specific interaction logic

**Frame class pattern:**

When drag, selection, or hover state changes, the shell calls `registration.getFrameClass({ isDragging, isSelected, isHovered })` and sets the result as a class on its outer `div`. The widget registration defines this function alongside its component — it returns whatever Tailwind/CSS classes produce the desired frame effect. The run workspace uses this to apply a scale-up + downward beam-of-light shadow during drag. A task group uses it for a selection glow. The shell never knows what the classes look like.

Example (in `src/widgets/runWorkspace/index.ts`):
```typescript
getFrameClass: ({ isDragging, isSelected }) => {
  if (isDragging) return 'widget-run-dragging'
  if (isSelected) return 'widget-run-selected'
  return ''
}
```

CSS for `widget-run-dragging` lives in the run workspace's own stylesheet — scale, shadow, beam effect defined there.

---

## InfiniteCanvas Changes

`renderNode()` becomes a registry lookup:

```typescript
function renderNode(node: TreeNode, depth: number): React.ReactNode {
  const reg = getWidget(node.type === 'run' ? 'run-workspace' : node.type)
  if (!reg) {
    console.warn(`No widget registered for type: ${node.type}`)
    return null
  }
  const layout = layouts.get(node.id)
  if (!layout) return null
  return (
    <CanvasWidgetShell
      key={node.id}
      registration={reg}
      nodeId={node.id}
      data={getEntityData(node)}
      layout={layout}
      zoom={camera.zoom}
    />
  )
}
```

No hardcoded type branches remain. Group children still recurse — `CanvasWidgetShell` receives `children` for group-type widgets that need to render their children inside their boundary.

---

## TreeNode Type Expansion

`TreeNode.type` currently accepts `'run' | GroupingDimension`. It expands to `string` — the canvas no longer constrains what type values are valid, the registry does. The server introduces new entity kinds over time; the canvas renders them as soon as a component is registered for that type. Unknown types produce a `console.warn` and render nothing.

Existing type values (`'run'`, `'initiative'`, `'epic'`, `'task'`, `'worktree'`) continue to work unchanged. The mapping `'run'` → `'run-workspace'` and `GroupingDimension` → `'task-group'` is handled in `renderNode`.

---

## Existing Widget Registrations

Two widget components register immediately as part of this sub-project:

**run-workspace** (`src/widgets/runWorkspace/`):
- `defaultSize`: 880 × 820 (unchanged)
- `dragHandleSelector`: `.widget-drag-handle` (header bar)
- `getFrameClass`: drag → `widget-run-dragging` (scale 1.03 + beam shadow), selected → `widget-run-selected` (cyan glow)
- `supportsMinimize`: true

**task-group** (`src/widgets/taskGroup/`):
- Migrated from `GroupContainer.tsx`
- `dragHandleSelector`: `.widget-drag-handle` (header bar)
- `getFrameClass`: selected → `widget-group-selected` (depth-aware glow)
- `supportsMinimize`: false

---

## What This Does NOT Change

- Hotkey registry and `WidgetDefinition` system (sub-projects ①②)
- `useWidgetLayouts` — layout storage and default sizing logic unchanged
- `SelectionProvider` and `selectedIds`
- `FocusPathContext` and the context router
- Server-side entity models — new widget types add server entities in their own sub-projects
- `useWidgetLayouts` default sizes — `DEFAULT_RUN_WIDTH`/`DEFAULT_RUN_HEIGHT` stay, new types declare their own via `defaultSize`

---

## Future Directions (not in scope)

- **Widget docking** — widgets attach and move as a unit; co-located widgets gain a communication channel via the Tinstar agent API
- **New entity types** — telemetry panels, custom agent widgets; each gets its own sub-project with a server entity model and a registered component
