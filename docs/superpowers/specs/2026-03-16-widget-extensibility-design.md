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

This sub-project does NOT change the hotkey/context system (sub-project ①②), server entity models, or `FocusPathContext`.

---

## Widget Component Registry

**File:** `src/widgets/widgetComponentRegistry.ts`

A singleton map of `type → WidgetRegistration`. Widgets self-register at module load via `registerWidgetComponent(reg)`. The lookup export is named `getWidgetComponent(type)` to avoid collision with `getWidget` exported from `src/hotkeys/widgetRegistry.ts`.

```typescript
interface WidgetRegistration {
  type: string                    // e.g. 'run-workspace', 'task-group', 'telemetry'
  component: React.ComponentType<WidgetProps>
  isContainer: boolean            // true for group-like widgets whose children are rendered as canvas siblings
  defaultSize?: { width: number; height: number }  // omit for container types (sized by content)
  minSize: { width: number; height: number }
  dragHandleSelector?: string     // CSS selector within component DOM; default: '.widget-drag-handle'
  getFrameClass?: (state: WidgetFrameState) => string
  supportsMinimize?: boolean
}

interface WidgetFrameState {
  isDragging: boolean
  isSelected: boolean
  isHovered: boolean
  isDropTarget: boolean           // for container widgets: drop-target reassign highlight
}
```

Registration rules: duplicate `type` string throws. `registerWidgetComponent` uses `reg.type` as the map key — it is the canonical identifier in both the map and the registration object.

`getWidgetComponent(type)` returns the registration or `undefined`. Unknown types produce a `console.warn` at render time and render nothing.

### Node type → widget type mapping

`TreeNode.type` values do not always equal the widget type strings used in the registry (e.g. `'run'` → `'run-workspace'`). A shared helper `toWidgetType(nodeType: string): string` in `widgetComponentRegistry.ts` centralizes this mapping:

```typescript
export function toWidgetType(nodeType: string): string {
  if (nodeType === 'run') return 'run-workspace'
  return nodeType  // group types map to themselves (e.g. 'task' → 'task-group' once registered)
}
```

All callers — `renderNode`, `collectGroupNodes`, `collectRunNodeIds`, `collectRunsUnderSelected`, `collectRenderOrder`, and `useWidgetLayouts` — call `toWidgetType(node.type)` before calling `getWidgetComponent`.

### Module initialization order

Widget registrations happen as side effects at module load (`registerWidgetComponent` calls in each widget's index file). These modules must be imported before any component that calls `getWidgetComponent`. The entry point (`main.tsx` or `App.tsx`) imports all widget index files at the top, before `InfiniteCanvas` or `useWidgetLayouts` are instantiated.

---

## Widget Props Contract

Every registered component receives:

```typescript
interface WidgetProps {
  data: unknown          // entity data — see "Entity Data by Type" below
  zoom: number           // raw canvas zoom float — widget quantizes as needed
  isSelected: boolean
  isDragging: boolean
  isHovered: boolean
  isDropTarget: boolean  // container widgets use this for reassign highlight
}
```

Widgets own all internal visual behavior. They receive `zoom` raw and quantize it themselves.

### Entity Data by Type

| Widget type | `data` shape |
|---|---|
| `'run-workspace'` | `RunData` — `runMap.get(node.entityId)` |
| `'task-group'` | `GroupWidgetData` — see below |

```typescript
interface GroupWidgetData {
  node: TreeNode                          // label, nodeType, color, etc.
  depth: number                           // from InfiniteCanvas depthMap — drives border/bg opacity tiers
  onShrinkToFit?: (id: string) => void
  onDelete?: (id: string) => void
  onMenuOpen?: (nodeId: string, anchorRect: DOMRect) => void
}
```

Container action callbacks (`onShrinkToFit`, `onDelete`, `onMenuOpen`) are threaded into the widget via `data` rather than as generic shell props, keeping the shell interface clean. `InfiniteCanvas` constructs `GroupWidgetData` when calling `getEntityData` for group nodes.

Future widget types define their own data shape and document it in their own sub-project spec.

---

## CanvasWidgetShell

**File:** `src/widgets/CanvasWidgetShell.tsx`

Replaces `CanvasWidget.tsx`. Works for any registered widget type.

**Props:**

```typescript
interface CanvasWidgetShellProps {
  registration: WidgetRegistration
  nodeId: string
  data: unknown
  layout: WidgetLayout                            // { x, y, width, height }
  zoom: number
  isSelected: boolean                             // from InfiniteCanvas's isSelected(node.id)
  isDropTarget?: boolean                          // set by InfiniteCanvas during drag-over
  spaceHeldRef: React.RefObject<boolean>          // guards drag initiation vs canvas pan
  onSelect: (id: string, additive: boolean) => void  // shell extracts additive from e.metaKey||e.shiftKey
  onDoubleClickZoom?: (id: string) => void
  onMove: (id: string, x: number, y: number) => void     // absolute canvas coords; id = nodeId
  onResize: (id: string, w: number, h: number) => void
  onDragStart?: (id: string) => void                     // id = nodeId (e.g. 'run-R-241')
  onDragMove?: (id: string, clientX: number, clientY: number) => void
  onDragEnd?: (id: string) => void
}
```

**`onMove` clarification:** the shell passes its own `nodeId` as the `id` and the new absolute canvas `(x, y)` — not deltas. `InfiniteCanvas.handleMultiMove(nodeId, newX, newY)` uses this to move all co-selected nodes.

**`onDragStart` / `onDragMove` / `onDragEnd` contract change:** today's `CanvasWidget` passes the raw run entity ID (e.g. `'R-241'`) to `onDragStart`, and `handleWidgetDragStart` reconstructs `'run-R-241'` for layout lookup. The shell passes `nodeId` directly (already `'run-R-241'`), so `handleWidgetDragStart` drops the `run-` prepend. `onDragMove` gains a leading `id` parameter; `handleWidgetDragMove` currently identifies the dragging node via local closure/state — the `id` param makes this explicit and removes the implicit coupling. Both handlers must be updated.

**Container resize:** `CanvasWidgetShell` renders a resize handle for all widget types including containers. `isContainer` does not affect resize behavior — group widgets remain freely resizable as today.

**`draggingRunRef` migration:** `InfiniteCanvas` currently stores the raw run entity ID in `draggingRunRef` (e.g. `'R-241'`) and composes `run-${draggingRunRef.current}` for layout lookups and `{ runId }` for the reassign dialog and API calls. After this change the shell passes `nodeId` (e.g. `'run-R-241'`) to all drag callbacks. `draggingRunRef` is updated to store `nodeId`. Downstream uses are updated accordingly:
- Layout lookup: `layouts.get(draggingRunRef.current)` (no prefix composition needed)
- Reassign dialog: `setReassign({ runId: draggingRunRef.current.replace(/^run-/, ''), target })`
- API call in `handleReassignConfirm`: extract raw ID with the same `.replace(/^run-/, '')` helper

**`arrangeGrid` scope:** `arrangeGrid` and its supporting `collectRunNodeIds` / `updateRunPosition` / `updateRunSize` functions remain run-specific in this sub-project. The `isContainer`-based update to `collectRunNodeIds` makes it correctly treat any registered non-container node as a leaf, but `arrangeGrid` itself only acts on nodes that match `'run-workspace'` type. Non-run leaf widgets are unaffected by arrange operations and are not expected to be arranged in this sub-project.

**What the shell owns:**
- Absolute positioning on the canvas
- Drag — pointer events on `dragHandleSelector` (default `.widget-drag-handle`); suppressed when `spaceHeldRef.current` is true
- Resize — bottom-right corner handle
- Selection — calls `onSelect` on pointer-down
- Double-click zoom — calls `onDoubleClickZoom` if provided
- Hover tracking
- Minimize chrome when `supportsMinimize: true`
- Calling `getFrameClass({ isDragging, isSelected, isHovered, isDropTarget })` and applying the result to its outer frame `div`

**What the shell does not own:**
- Any visual effect inside the widget boundary
- Zoom quantization
- Widget-specific interaction logic

**Frame class pattern:**

The shell calls `registration.getFrameClass(state)` on each state change and applies the returned string as a class on its outer `div`. Widget CSS defines the actual keyframes and effects.

Example (`src/widgets/runWorkspace/index.ts`):
```typescript
getFrameClass: ({ isDragging, isSelected }) => {
  if (isDragging) return 'widget-run-dragging'
  if (isSelected) return 'widget-run-selected'
  return ''
}
```

---

## InfiniteCanvas Changes

### renderNode

Rendering order is unchanged — group frames and run widgets remain absolute DOM siblings (groups first, runs on top). No nested React tree.

```typescript
function getEntityData(
  node: TreeNode,
  runMap: Map<string, RunData>,
  groupCallbacks: GroupCallbacks,
): unknown {
  if (node.type === 'run') return runMap.get(node.entityId)
  return {
    node,
    depth: depthMap.get(node.id) ?? 0,
    onShrinkToFit: groupCallbacks.onShrinkToFit,
    onDelete: groupCallbacks.onDelete,
    onMenuOpen: groupCallbacks.onMenuOpen,
  } satisfies GroupWidgetData
}

// depth param is structural (drives recursive child rendering); not forwarded to shell —
// group widgets get depth from GroupWidgetData.depth via depthMap
function renderNode(node: TreeNode, depth: number): React.ReactNode {
  const widgetType = toWidgetType(node.type)
  const reg = getWidgetComponent(widgetType)
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
      data={getEntityData(node, runMap, groupCallbacks)}
      layout={layout}
      zoom={camera.zoom}
      isSelected={isSelected(node.id)}
      isDropTarget={dropTargetId === node.id}
      spaceHeldRef={spaceHeldRef}
      onSelect={handleSelect}
      onDoubleClickZoom={handleDoubleClickZoom}
      onMove={handleMove}
      onResize={handleResize}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
    />
  )
}
```

### Canvas helper functions

The following functions currently branch on `node.type !== 'run'` or `node.type === 'run'` to distinguish containers from leaf nodes. All are updated to use `getWidgetComponent(toWidgetType(node.type))?.isContainer` instead:

- `collectGroupNodes` — collects container nodes for drop-target hit-testing
- `collectRunNodeIds` — collects leaf node IDs
- `collectRunsUnderSelected` — walks selected subtrees for multi-drag
- `collectRenderOrder` — decides whether to recurse into children

Nodes whose type has no registered component are treated as leaf nodes (non-container).

---

## useWidgetLayouts Changes

`useWidgetLayouts` has multiple sites that branch on `node.type === 'run'` or `node.type !== 'run'`. All are updated to use `getWidgetComponent(toWidgetType(node.type))?.isContainer`:

- **`computeSize`** — currently assigns `DEFAULT_RUN_WIDTH / DEFAULT_RUN_HEIGHT` for run nodes. Updated to use `registration.defaultSize` for leaf nodes (fallback to `DEFAULT_RUN_WIDTH / DEFAULT_RUN_HEIGHT` for `'run-workspace'` specifically, or for any leaf type with no `defaultSize`).
- **`absolutize`** — contains a `hasContainers` heuristic derived from node type. Updated to use `isContainer`.
- **`generateDefaultLayouts`** / **`placeNewRuns`** — the `if (node.type !== 'run') continue` guard in `placeNewRuns` is replaced with `if (reg?.isContainer) continue`, so any registered leaf type gets smart placement using `registration.defaultSize`. Unregistered types fall through to `generateDefaultLayouts` defaults.

---

## TreeNode Type Expansion

`TreeNode.type` expands from `'run' | GroupingDimension` to `string`. The canvas no longer constrains valid type values. Unknown types produce a `console.warn` and render nothing. Existing type values continue to work unchanged.

---

## Existing Widget Registrations

**run-workspace** (`src/widgets/runWorkspace/`):
- `isContainer`: false
- `defaultSize`: `{ width: 880, height: 820 }`
- `minSize`: `{ width: 300, height: 150 }`
- `dragHandleSelector`: `.widget-drag-handle`
- `getFrameClass`: drag → `widget-run-dragging` (scale 1.03 + beam shadow), selected → `widget-run-selected` (cyan glow)
- `supportsMinimize`: true

**task-group** (`src/widgets/taskGroup/`):
- Migrated from `GroupContainer.tsx`
- `isContainer`: true
- `defaultSize`: omitted (sized by child layout algorithm)
- `minSize`: `{ width: 200, height: 100 }`
- `dragHandleSelector`: `.widget-drag-handle`
- `getFrameClass`: selected → `widget-group-selected` (depth-aware glow), dropTarget → `widget-group-drop-target`
- `supportsMinimize`: false

---

## What This Does NOT Change

- Hotkey registry and `WidgetDefinition` system (sub-projects ①②)
- `SelectionProvider` and `selectedIds`
- `FocusPathContext` and the context router
- Server-side entity models
- Layout storage key (`tinstar-layouts-v3`) and layout shape

---

## Future Directions (not in scope)

- **Widget docking** — widgets attach and move as a unit; co-located widgets gain a communication channel via the Tinstar agent API
- **New entity types** — telemetry panels, custom agent widgets; each gets its own sub-project with a server entity model and a registered component
