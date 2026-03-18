# Widget Registry

A registration-based rendering system that lets new canvas widget types be added without touching `InfiniteCanvas`. Each widget type self-registers its component, sizing, drag handle, and frame styling.

---

## Registration

**File:** `src/widgets/widgetComponentRegistry.ts`

Each widget calls `registerWidgetComponent(reg)` at module load. `InfiniteCanvas` resolves widget types via `getWidgetComponent(type)` instead of hardcoded branches.

```typescript
interface WidgetRegistration {
  type: string                    // e.g. 'run-workspace', 'task-group', 'file-editor'
  component: React.ComponentType<WidgetProps>
  isContainer: boolean            // true = group-like; children rendered as canvas siblings
  defaultSize?: { width: number; height: number }   // omit for containers
  minSize: { width: number; height: number }
  dragHandleSelector?: string     // default: '.widget-drag-handle'
  getFrameClass?: (state: WidgetFrameState) => string
  supportsMinimize?: boolean
}

interface WidgetFrameState {
  isDragging: boolean
  isSelected: boolean
  isHovered: boolean
  isDropTarget: boolean
}
```

Duplicate `type` throws at registration time. Unknown types produce `console.warn` and render nothing.

**Module initialization:** widget registrations are side effects at module load. All widget index files must be imported in `main.tsx`/`App.tsx` before `InfiniteCanvas` or `useWidgetLayouts` are instantiated.

---

## Node Type → Widget Type Mapping

`TreeNode.type` values don't always match widget type strings. The helper `toWidgetType(nodeType)` in `widgetComponentRegistry.ts` centralizes this:

```typescript
export function toWidgetType(nodeType: string): string {
  if (nodeType === 'run') return 'run-workspace'
  return nodeType  // group types map to themselves
}
```

All canvas functions that look up widget registrations call `toWidgetType(node.type)` first.

`TreeNode.type` is `string` (not a narrow union) to allow arbitrary future widget types.

---

## Widget Props Contract

Every registered component receives:

```typescript
interface WidgetProps {
  data: unknown          // entity data — see registered types below
  zoom: number           // raw canvas zoom float; widget quantizes as needed
  isSelected: boolean
  isDragging: boolean
  isHovered: boolean
  isDropTarget: boolean  // containers use for reassign-drag highlight
}
```

### Entity Data by Widget Type

| Widget type | `data` shape |
|---|---|
| `'run-workspace'` | `Run` — `runMap.get(node.entityId)` |
| `'task-group'` | `GroupWidgetData` — `{ node, depth, onShrinkToFit, onDelete, onMenuOpen }` |
| `'file-editor'` | `EditorWidget` — `editorWidgetMap.get(node.entityId)` |

Container action callbacks (`onShrinkToFit`, `onDelete`, `onMenuOpen`) travel via `data` rather than generic shell props, keeping the shell interface clean.

---

## CanvasWidgetShell

`src/widgets/CanvasWidgetShell.tsx` — generic replacement for `CanvasWidget.tsx`. Works for any registered type.

**What the shell owns:**
- Absolute positioning on canvas
- Drag (via `dragHandleSelector`)
- Resize (bottom-right handle)
- Selection on pointer-down
- Double-click zoom
- Hover tracking
- Minimize chrome when `supportsMinimize: true`
- Applying `getFrameClass(state)` result to the outer frame `div`

**What the shell does not own:**
- Any visual content inside the widget boundary
- Zoom quantization
- Widget-specific interaction logic

**Frame class pattern:** the shell calls `registration.getFrameClass(state)` on each state change and applies the result as a CSS class. The widget's CSS defines the actual effects.

```typescript
// Example: src/widgets/runWorkspace/index.ts
getFrameClass: ({ isDragging, isSelected }) => {
  if (isDragging) return 'widget-run-dragging'
  if (isSelected) return 'widget-run-selected'
  return ''
}
```

---

## Registered Widget Types

### `run-workspace`

Terminal + recap + file panels for an active session.

- `isContainer`: false
- `defaultSize`: 880 × 820
- `minSize`: 300 × 150
- `dragHandleSelector`: `.widget-drag-handle`
- `supportsMinimize`: true

### `task-group`

Container box grouping runs by task/epic/initiative.

- `isContainer`: true
- `defaultSize`: omitted (sized by child layout)
- `minSize`: 200 × 100
- `supportsMinimize`: false

### `file-editor`

Read-only Monaco editor with live file watching. See [file-editor-widget.md](file-editor-widget.md).

- `isContainer`: false
- `defaultSize`: 640 × 480
- `minSize`: 300 × 200
- `supportsMinimize`: false

---

## Adding a New Widget Type

1. Create `src/widgets/<name>/index.ts` — call `registerWidgetComponent({ type: '<name>', component: ..., ... })`
2. Create the component file; it receives `WidgetProps` with `data: unknown` — cast to your entity type
3. Import the index file in `main.tsx`/`App.tsx` before `InfiniteCanvas`
4. Add a server entity model if needed; route entity data through `getEntityData` in `InfiniteCanvas`
5. Add `toWidgetType` mapping if `TreeNode.type !== widget type string`
