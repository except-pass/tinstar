# Widget Extensibility Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded `InfiniteCanvas` widget branches with a registration-based system, introduce `CanvasWidgetShell` as a generic wrapper, and migrate `RunWorkspaceWidget` and `GroupContainer` as the first two registered widget types.

**Architecture:** A `widgetComponentRegistry` maps widget type strings to React components + config. `CanvasWidgetShell` owns drag/resize/selection for any registered type. `InfiniteCanvas.renderNode` does a registry lookup instead of type-branching. `useWidgetLayouts` consults the registry to distinguish leaf nodes from containers.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Playwright (E2E)

---

## File Map

**New files:**
- `src/widgets/widgetComponentRegistry.ts` — registry singleton + shared types
- `src/widgets/CanvasWidgetShell.tsx` — generic canvas wrapper (replaces CanvasWidget.tsx)
- `src/widgets/index.ts` — barrel import to trigger all widget registrations
- `src/widgets/runWorkspace/index.tsx` — run-workspace registration + adapter component (`.tsx` because it contains JSX)
- `src/widgets/taskGroup/TaskGroupWidget.tsx` — visual component for group containers
- `src/widgets/taskGroup/index.ts` — task-group registration

**Modified files:**
- `src/domain/types.ts` — `TreeNode.type: string` (was `GroupingDimension | 'run'`)
- `src/components/RunWorkspaceWidget/RunWorkspaceHeader.tsx` — add `widget-drag-handle` class to header root
- `src/components/RunWorkspaceWidget/index.tsx` — remove `onHeaderPointerDown/Move/Up` from usage (keep optional for compat)
- `src/components/InfiniteCanvas.tsx` — use registry in `renderNode`, helper functions, drag callbacks
- `src/hooks/useWidgetLayouts.ts` — replace `node.type === 'run'` checks with `isContainer` from registry
- `src/main.tsx` — add `import './widgets'` for component registrations
- `src/index.css` — add CSS keyframes/classes for drag and selection effects

**Files deleted after migration:**
- `src/components/CanvasWidget.tsx` — replaced by CanvasWidgetShell
- `src/components/GroupContainer.tsx` — replaced by TaskGroupWidget

---

### Task 1: Widget Component Registry

**Files:**
- Create: `src/widgets/widgetComponentRegistry.ts`

- [ ] **Step 1: Create the registry file**

```typescript
// src/widgets/widgetComponentRegistry.ts
import type React from 'react'

export interface GroupWidgetData {
  node: {
    id: string
    label: string
    type: string
    entityId: string
    children: unknown[]
    color?: string
  }
  depth: number
  onShrinkToFit?: (id: string) => void
  onDelete?: (id: string) => void
  onMenuOpen?: (nodeId: string, anchorRect: DOMRect) => void
}

export interface WidgetProps {
  data: unknown
  zoom: number
  isSelected: boolean
  isDragging: boolean
  isHovered: boolean
  isDropTarget: boolean
}

export interface WidgetFrameState {
  isDragging: boolean
  isSelected: boolean
  isHovered: boolean
  isDropTarget: boolean
}

export interface WidgetRegistration {
  type: string
  component: React.ComponentType<WidgetProps>
  isContainer: boolean
  defaultSize?: { width: number; height: number }
  minSize: { width: number; height: number }
  dragHandleSelector?: string
  getFrameClass?: (state: WidgetFrameState) => string
  supportsMinimize?: boolean
}

const registry = new Map<string, WidgetRegistration>()

export function registerWidgetComponent(reg: WidgetRegistration): void {
  if (registry.has(reg.type)) {
    throw new Error(`Widget type already registered: ${reg.type}`)
  }
  registry.set(reg.type, reg)
}

export function getWidgetComponent(type: string): WidgetRegistration | undefined {
  return registry.get(type)
}

/**
 * Maps TreeNode.type values to widget registry type strings.
 * 'run' → 'run-workspace'; all group dimension types map to themselves
 * (e.g. 'task' is registered as 'task' until task-group registration uses that key,
 * but the canonical group widget type is 'task-group').
 * For the current two-widget system: 'run' → 'run-workspace', everything else → the node type.
 */
export function toWidgetType(nodeType: string): string {
  if (nodeType === 'run') return 'run-workspace'
  return nodeType
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: no errors in new file

- [ ] **Step 3: Commit**

```bash
git add src/widgets/widgetComponentRegistry.ts
git commit -m "feat: add widgetComponentRegistry with registerWidgetComponent/getWidgetComponent/toWidgetType"
```

---

### Task 2: Expand TreeNode.type to string

**Files:**
- Modify: `src/domain/types.ts:109`

The `TreeNode.type` field is currently `GroupingDimension | 'run'`. Expanding it to `string` allows future entity types without editing the domain model.

- [ ] **Step 1: Update TreeNode.type**

In `src/domain/types.ts`, change line 109:
```typescript
// Before:
type: GroupingDimension | 'run'

// After:
type: string
```

- [ ] **Step 2: Type check — expect some errors**

Run: `npx tsc --noEmit`
Expected: TypeScript will complain about places that assumed the narrow type (e.g. `node.type as GroupingDimension` casts, exhaustiveness checks). Note these — they will be fixed in Tasks 6–7.

- [ ] **Step 3: Commit**

```bash
git add src/domain/types.ts
git commit -m "feat: expand TreeNode.type to string for arbitrary widget types"
```

---

### Task 3: CanvasWidgetShell

**Files:**
- Create: `src/widgets/CanvasWidgetShell.tsx`

This replaces `src/components/CanvasWidget.tsx`. It handles drag (via `dragHandleSelector`), resize, selection, hover, and frame class application for any registered widget type.

- [ ] **Step 1: Create CanvasWidgetShell**

```typescript
// src/widgets/CanvasWidgetShell.tsx
import { useRef, useState, useCallback, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import type { WidgetRegistration } from './widgetComponentRegistry'
import type { WidgetLayout } from '../hooks/useWidgetLayouts'

const DRAG_THRESHOLD = 5

interface CanvasWidgetShellProps {
  registration: WidgetRegistration
  nodeId: string
  data: unknown
  layout: WidgetLayout
  zoom: number
  isSelected: boolean
  isDropTarget?: boolean
  spaceHeldRef: RefObject<boolean>
  onSelect: (id: string, additive: boolean) => void
  onDoubleClickZoom?: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  onDragStart?: (id: string) => void
  onDragMove?: (id: string, clientX: number, clientY: number) => void
  onDragEnd?: (id: string) => void
}

export function CanvasWidgetShell({
  registration,
  nodeId,
  data,
  layout,
  zoom,
  isSelected,
  isDropTarget = false,
  spaceHeldRef,
  onSelect,
  onDoubleClickZoom,
  onMove,
  onResize,
  onDragStart,
  onDragMove,
  onDragEnd,
}: CanvasWidgetShellProps) {
  const {
    component: WidgetComponent,
    dragHandleSelector = '.widget-drag-handle',
    getFrameClass,
    minSize,
  } = registration

  const containerRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  const dragging = useRef(false)
  const resizing = useRef(false)
  const dragStart = useRef({ x: 0, y: 0, originX: 0, originY: 0 })
  const resizeStart = useRef({ x: 0, y: 0, originW: 0, originH: 0 })
  const dragMoved = useRef(false)
  const resizeMoved = useRef(false)

  const frameClass =
    getFrameClass?.({ isDragging, isSelected, isHovered, isDropTarget }) ?? ''

  // Pointer down on shell: fire selection + start drag if on handle
  const handlePointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0 || spaceHeldRef.current) return
      onSelect(nodeId, e.ctrlKey || e.metaKey)

      const target = e.target as Element
      if (target.closest(dragHandleSelector)) {
        e.stopPropagation()
        containerRef.current?.setPointerCapture(e.pointerId)
        dragging.current = true
        dragMoved.current = false
        dragStart.current = {
          x: e.clientX,
          y: e.clientY,
          originX: layout.x,
          originY: layout.y,
        }
      }
    },
    [nodeId, spaceHeldRef, dragHandleSelector, layout.x, layout.y, onSelect],
  )

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragging.current) return
      const dx = (e.clientX - dragStart.current.x) / zoom
      const dy = (e.clientY - dragStart.current.y) / zoom
      if (
        !dragMoved.current &&
        Math.hypot(
          e.clientX - dragStart.current.x,
          e.clientY - dragStart.current.y,
        ) < DRAG_THRESHOLD
      )
        return
      if (!dragMoved.current) {
        dragMoved.current = true
        setIsDragging(true)
        onDragStart?.(nodeId)
      }
      onMove(nodeId, dragStart.current.originX + dx, dragStart.current.originY + dy)
      onDragMove?.(nodeId, e.clientX, e.clientY)
    },
    [nodeId, zoom, onMove, onDragStart, onDragMove],
  )

  const handlePointerUp = useCallback(() => {
    if (dragging.current && dragMoved.current) {
      onDragEnd?.(nodeId)
    }
    dragging.current = false
    dragMoved.current = false
    setIsDragging(false)
  }, [nodeId, onDragEnd])

  // Resize handle (bottom-right corner)
  const handleResizeDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      e.stopPropagation()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      resizing.current = true
      resizeMoved.current = false
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        originW: layout.width,
        originH: layout.height,
      }
    },
    [layout.width, layout.height],
  )

  const handleResizeMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!resizing.current) return
      const dx = (e.clientX - resizeStart.current.x) / zoom
      const dy = (e.clientY - resizeStart.current.y) / zoom
      if (
        !resizeMoved.current &&
        Math.hypot(
          e.clientX - resizeStart.current.x,
          e.clientY - resizeStart.current.y,
        ) < DRAG_THRESHOLD
      )
        return
      resizeMoved.current = true
      onResize(
        nodeId,
        resizeStart.current.originW + dx,
        resizeStart.current.originH + dy,
      )
    },
    [nodeId, zoom, onResize],
  )

  const handleResizeUp = useCallback(() => {
    resizing.current = false
  }, [])

  const handleDoubleClick = useCallback(() => {
    onDoubleClickZoom?.(nodeId)
  }, [nodeId, onDoubleClickZoom])

  return (
    <div
      ref={containerRef}
      data-testid={`canvas-widget-${nodeId}`}
      data-selected={isSelected ? 'true' : undefined}
      className={`absolute ${frameClass}`}
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
    >
      <WidgetComponent
        data={data}
        zoom={zoom}
        isSelected={isSelected}
        isDragging={isDragging}
        isHovered={isHovered}
        isDropTarget={isDropTarget}
      />

      {/* Resize handle — bottom-right corner */}
      <div
        className="absolute right-0 bottom-0 w-3 h-3 cursor-se-resize z-10"
        style={{
          background:
            'linear-gradient(135deg, transparent 50%, rgba(0, 240, 255, 0.25) 50%)',
        }}
        onPointerDown={handleResizeDown}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeUp}
        onPointerCancel={handleResizeUp}
      />
    </div>
  )
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: no errors in new file (ignoring pre-existing errors from Task 2)

- [ ] **Step 3: Commit**

```bash
git add src/widgets/CanvasWidgetShell.tsx
git commit -m "feat: add CanvasWidgetShell — generic drag/resize/selection shell for any widget type"
```

---

### Task 4: RunWorkspace Registration

**Files:**
- Modify: `src/components/RunWorkspaceWidget/RunWorkspaceHeader.tsx`
- Modify: `src/components/RunWorkspaceWidget/index.tsx`
- Create: `src/widgets/runWorkspace/index.ts`

The shell identifies the drag handle by CSS selector `.widget-drag-handle`. Add this class to `RunWorkspaceHeader`'s root element. Then create a thin adapter that wraps `RunWorkspaceWidget` and registers the widget type.

- [ ] **Step 1: Add `widget-drag-handle` class to RunWorkspaceHeader**

In `src/components/RunWorkspaceWidget/RunWorkspaceHeader.tsx`, find the root element of the component (the outermost `div` with `cursor-grab`). Add `widget-drag-handle` to its className.

The root div of RunWorkspaceHeader is the header container div. Search for `cursor-grab` in the file — that's the drag handle. Add `widget-drag-handle` to the same element's class list:

```typescript
// Before (approximate — find the div with cursor-grab):
className="... cursor-grab ..."

// After:
className="widget-drag-handle ... cursor-grab ..."
```

- [ ] **Step 2: Remove drag callbacks from RunWorkspaceWidget usage**

In `src/components/RunWorkspaceWidget/index.tsx`, the header is called with `onPointerDown/Move/Up`. Since the shell now handles drag, remove those three props from the `RunWorkspaceHeader` call:

```typescript
// Before (lines ~167-174):
<RunWorkspaceHeader
  run={run}
  compact={compact}
  onPointerDown={onHeaderPointerDown}
  onPointerMove={onHeaderPointerMove}
  onPointerUp={onHeaderPointerUp}
  onRefreshTerminal={bumpTerm}
/>

// After:
<RunWorkspaceHeader
  run={run}
  compact={compact}
  onRefreshTerminal={bumpTerm}
/>
```

The Props interface in RunWorkspaceWidget keeps `onHeaderPointerDown/Move/Up` as optional (for backwards compat during transition), but they are no longer forwarded to the header.

- [ ] **Step 3: Create run-workspace registration**

The file must be `.tsx` (not `.ts`) because it contains JSX.

```typescript
// src/widgets/runWorkspace/index.tsx
import { registerWidgetComponent, type WidgetProps } from '../widgetComponentRegistry'
import { RunWorkspaceWidget } from '../../components/RunWorkspaceWidget'
import type { RunData } from '../../types'

function RunWorkspaceAdapter({ data, zoom }: WidgetProps) {
  const run = data as RunData
  return <RunWorkspaceWidget run={run} className="w-full h-full" zoom={zoom} />
}

registerWidgetComponent({
  type: 'run-workspace',
  component: RunWorkspaceAdapter,
  isContainer: false,
  defaultSize: { width: 880, height: 820 },
  minSize: { width: 300, height: 150 },
  dragHandleSelector: '.widget-drag-handle',
  getFrameClass: ({ isDragging, isSelected }) => {
    if (isDragging) return 'widget-run-dragging'
    if (isSelected) return 'widget-run-selected'
    return ''
  },
  supportsMinimize: true,
})
```

Note: `RunWorkspaceWidget` does not yet accept a `zoom` prop — add it as optional to the Props interface in `RunWorkspaceWidget/index.tsx` for future use (but do not use it yet — the terminal font-size feature is a follow-up):

```typescript
// In RunWorkspaceWidget Props interface, add:
zoom?: number
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: no new errors from these files

- [ ] **Step 5: Commit**

```bash
git add src/components/RunWorkspaceWidget/RunWorkspaceHeader.tsx \
        src/components/RunWorkspaceWidget/index.tsx \
        src/widgets/runWorkspace/index.tsx
git commit -m "feat: add run-workspace widget registration, add widget-drag-handle to header"
```

---

### Task 5: TaskGroup Widget and Registration

**Files:**
- Create: `src/widgets/taskGroup/TaskGroupWidget.tsx`
- Create: `src/widgets/taskGroup/index.ts`

`TaskGroupWidget` is a visual-only component — no drag/resize logic (shell handles that). It renders the group chrome: depth-aware border/bg, header with drag handle class, menu/delete buttons. It fills `w-full h-full` inside the shell.

- [ ] **Step 1: Create TaskGroupWidget component**

```typescript
// src/widgets/taskGroup/TaskGroupWidget.tsx
import { useCallback } from 'react'
import type { WidgetProps, GroupWidgetData } from '../widgetComponentRegistry'
import { getDimensionIcon } from '../../domain/dimension-meta'
import type { GroupingDimension } from '../../domain/types'

const BORDER_OPACITY = [0.15, 0.12, 0.08, 0.05]
const BG_OPACITY = [0.02, 0.015, 0.01, 0.005]

export function TaskGroupWidget({ data, isDropTarget }: WidgetProps) {
  const { node, depth, onShrinkToFit, onDelete, onMenuOpen } =
    data as GroupWidgetData

  const borderOp =
    BORDER_OPACITY[Math.min(depth, BORDER_OPACITY.length - 1)] ?? 0.05
  const bgOp = BG_OPACITY[Math.min(depth, BG_OPACITY.length - 1)] ?? 0.005
  const icon = getDimensionIcon(node.type as GroupingDimension)

  const handleDoubleClick = useCallback(() => {
    onShrinkToFit?.(node.id)
  }, [node.id, onShrinkToFit])

  return (
    <div
      data-testid={`group-container-${node.id}`}
      className={`w-full h-full ${depth === 0 ? 'rounded-lg' : 'rounded-md'}`}
      onDoubleClick={handleDoubleClick}
      style={{
        border: isDropTarget
          ? '2px solid rgba(0, 240, 255, 0.6)'
          : `1px solid rgba(0, 240, 255, ${borderOp})`,
        background: isDropTarget
          ? 'rgba(0, 240, 255, 0.08)'
          : `rgba(0, 240, 255, ${bgOp})`,
        boxShadow: isDropTarget
          ? '0 0 20px rgba(0, 240, 255, 0.15), inset 0 0 20px rgba(0, 240, 255, 0.05)'
          : 'none',
        transition: 'border 150ms, background 150ms, box-shadow 150ms',
      }}
    >
      {/* Header — drag handle for the shell */}
      <div
        className="widget-drag-handle group/header h-8 flex items-center px-3 cursor-grab active:cursor-grabbing select-none"
        style={{
          borderBottom: `1px solid rgba(0, 240, 255, ${borderOp * 0.5})`,
        }}
        onDragStart={(e) => e.preventDefault()}
      >
        <span className="text-xs font-display uppercase tracking-wider text-primary/50 flex-1">
          {icon} {node.label}
        </span>
        {onMenuOpen && (
          <button
            className="w-5 h-5 flex items-center justify-center text-slate-500 hover:text-primary opacity-0 group-hover/header:opacity-100 transition-opacity cursor-pointer"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              onMenuOpen(node.id, rect)
            }}
            data-testid={`menu-group-${node.id}`}
            aria-label={`Menu for ${node.label}`}
          >
            ⋮
          </button>
        )}
        {onDelete && !onMenuOpen && (
          <button
            className="w-5 h-5 flex items-center justify-center text-slate-500 hover:text-red-400 opacity-0 group-hover/header:opacity-100 transition-opacity cursor-pointer"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onDelete(node.id)}
            data-testid={`delete-group-${node.id}`}
            aria-label={`Delete ${node.label}`}
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create task-group registration**

The group dimension types (`'initiative'`, `'epic'`, `'task'`, `'worktree'`) all map to the same `TaskGroupWidget`. Register each separately so `getWidgetComponent('initiative')` etc. return a registration:

```typescript
// src/widgets/taskGroup/index.ts
import { registerWidgetComponent, type WidgetProps } from '../widgetComponentRegistry'
import { TaskGroupWidget } from './TaskGroupWidget'

// All grouping dimension types use the same TaskGroupWidget.
// toWidgetType() returns the node type string unchanged for non-run types,
// so each dimension type must be registered explicitly.
for (const type of ['initiative', 'epic', 'task', 'worktree']) {
  registerWidgetComponent({
    type,
    component: TaskGroupWidget,
    isContainer: true,
    // No defaultSize — containers are sized by the layout algorithm
    minSize: { width: 200, height: 100 },
    dragHandleSelector: '.widget-drag-handle',
    getFrameClass: ({ isDropTarget }) => {
      if (isDropTarget) return 'widget-group-drop-target'
      return ''
    },
    supportsMinimize: false,
  })
}
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 4: Commit**

```bash
git add src/widgets/taskGroup/TaskGroupWidget.tsx src/widgets/taskGroup/index.ts
git commit -m "feat: add TaskGroupWidget and task-group registration for all grouping dimension types"
```

---

### Task 6: Update InfiniteCanvas

**Files:**
- Modify: `src/components/InfiniteCanvas.tsx`

This is the largest change. Replace the hardcoded two-branch `renderNode` with a registry lookup, update all helper functions to use `isContainer`, and update drag callback signatures.

- [ ] **Step 1: Update imports**

At the top of `InfiniteCanvas.tsx`, replace:
```typescript
import { CanvasWidget } from './CanvasWidget'
import { GroupContainer } from './GroupContainer'
```
With:
```typescript
import { CanvasWidgetShell } from '../widgets/CanvasWidgetShell'
import { getWidgetComponent, toWidgetType } from '../widgets/widgetComponentRegistry'
import type { GroupWidgetData } from '../widgets/widgetComponentRegistry'
```

Also remove `GroupingDimension` from the `domain/types` import if it is only used for the group cast — it may still be needed for `handleMenuOpenGroup`.

- [ ] **Step 2: Update collectGroupNodes, collectRunNodeIds, collectRunsUnderSelected, collectRenderOrder**

Replace all four functions (lines 49–94 and 638–649):

```typescript
function collectGroupNodes(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = []
  for (const node of nodes) {
    if (getWidgetComponent(toWidgetType(node.type))?.isContainer) {
      result.push(node)
      result.push(...collectGroupNodes(node.children))
    }
  }
  return result
}

function collectRunNodeIds(nodes: TreeNode[]): string[] {
  const result: string[] = []
  for (const node of nodes) {
    if (!getWidgetComponent(toWidgetType(node.type))?.isContainer) {
      result.push(node.id)
    } else {
      result.push(...collectRunNodeIds(node.children))
    }
  }
  return result
}

function collectRunsUnderSelected(
  nodes: TreeNode[],
  selectedIds: Set<string>,
): string[] {
  const result: string[] = []
  for (const node of nodes) {
    if (selectedIds.has(node.id)) {
      if (!getWidgetComponent(toWidgetType(node.type))?.isContainer) {
        result.push(node.id)
      } else {
        result.push(...collectRunNodeIds(node.children))
      }
    } else {
      result.push(...collectRunsUnderSelected(node.children, selectedIds))
    }
  }
  return result
}
```

`collectRenderOrder` (lines 638–649):
```typescript
function collectRenderOrder(nodes: TreeNode[], depth: number): React.ReactNode[] {
  const result: React.ReactNode[] = []
  for (const node of nodes) {
    if (getWidgetComponent(toWidgetType(node.type))?.isContainer) {
      result.push(renderNode(node, depth))
      result.push(...collectRenderOrder(node.children, depth + 1))
    } else {
      result.push(renderNode(node, depth))
    }
  }
  return result
}
```

- [ ] **Step 3: Update drag callback signatures**

`handleWidgetDragStart` (line 312) — now receives `nodeId` (full, e.g. `'run-R-241'`) instead of raw run ID:

```typescript
const handleWidgetDragStart = useCallback((nodeId: string) => {
  draggingRunRef.current = nodeId
  if (isSelected(nodeId)) {
    const snap = new Map<string, { x: number; y: number }>()
    for (const leafId of runNodeIdsRef.current) {
      if (leafId !== nodeId && isSelected(leafId)) {
        const layout = layouts.get(leafId)
        if (layout) snap.set(leafId, { x: layout.x, y: layout.y })
      }
    }
    const dragLayout = layouts.get(nodeId)
    if (dragLayout) snap.set('__origin__', { x: dragLayout.x, y: dragLayout.y })
    multiDragSnapshot.current = snap.size > 1 ? snap : null
  } else {
    multiDragSnapshot.current = null
  }
}, [isSelected, layouts])
```

`handleWidgetDragMove` (line 333) — gains `nodeId` first parameter; `draggingRunRef` now stores full nodeId:

```typescript
const handleWidgetDragMove = useCallback((_nodeId: string, clientX: number, clientY: number) => {
  if (!draggingRunRef.current) return
  const canvas = clientToCanvas(clientX, clientY)
  let target = hitTestGroups(canvas.x, canvas.y)
  if (target) {
    // Don't offer to reassign to any current ancestor — walk using full nodeId
    let nodeId: string | null = draggingRunRef.current
    while (nodeId) {
      const parent: string | null = parentMapRef.current.get(nodeId) ?? null
      if (parent === target.nodeId) { target = null; break }
      nodeId = parent
    }
  }
  setDropTarget(prev => {
    if (prev?.nodeId === target?.nodeId) return prev
    return target
  })
}, [clientToCanvas, hitTestGroups])
```

`handleWidgetDragEnd` (line 352) — receives `nodeId` (unused; use `draggingRunRef`). Extract raw run ID with `.replace(/^run-/, '')` for `ReassignState`:

```typescript
const handleWidgetDragEnd = useCallback((_nodeId: string) => {
  const storedNodeId = draggingRunRef.current
  draggingRunRef.current = null
  multiDragSnapshot.current = null
  if (storedNodeId && dropTarget) {
    setReassign({ runId: storedNodeId.replace(/^run-/, ''), target: dropTarget })
  }
  setDropTarget(null)
}, [dropTarget])
```

- [ ] **Step 4: Add handleSelect helper**

`CanvasWidgetShell.onSelect` will call this with `nodeId`. For run nodes, translate to raw run ID for `onSelectRun`. Group containers do not call `onSelectRun` — this matches the current behavior where clicking a `GroupContainer` never triggered run selection:

```typescript
const handleSelect = useCallback((nodeId: string, additive: boolean) => {
  if (nodeId.startsWith('run-') && onSelectRun) {
    // onSelectRun is the external prop; the parent's useSelection() state
    // is updated by the parent (WorkspaceShell) which calls selectMany via context.
    // This matches current CanvasWidget behavior which passes onSelectRun directly.
    onSelectRun(nodeId.slice(4), additive)
  }
  // Group containers intentionally do not fire onSelectRun (same as current GroupContainer)
}, [onSelectRun])
```

- [ ] **Step 5: Replace renderNode**

Replace the existing `renderNode` function (lines 583–636):

```typescript
// depth param is structural only (drives collectRenderOrder recursion)
// Group widgets get depth from GroupWidgetData.depth via depthMapRef
function renderNode(node: TreeNode, depth: number): React.ReactNode {
  const widgetType = toWidgetType(node.type)
  const reg = getWidgetComponent(widgetType)
  if (!reg) {
    console.warn(`No widget registered for type: ${node.type}`)
    return null
  }
  const layout = layouts.get(node.id)
  if (!layout) return null

  const data: unknown =
    node.type === 'run'
      ? runMap.get(node.entityId)
      : ({
          node,
          depth: depthMapRef.current.get(node.id) ?? 0,
          onShrinkToFit: shrinkNode,
          onDelete: handleDeleteGroup,
          onMenuOpen: handleMenuOpenGroup,
        } satisfies GroupWidgetData)

  // Run widgets use handleMultiMove + updateRunSize (with cascade expansion)
  // Container widgets use moveNode (moves descendants) + resizeNode (min-bounds)
  const moveHandler = reg.isContainer ? moveNode : handleMultiMove
  const resizeHandler = reg.isContainer ? resizeNode : updateRunSize

  return (
    <CanvasWidgetShell
      key={node.id}
      registration={reg}
      nodeId={node.id}
      data={data}
      layout={layout}
      zoom={camera.zoom}
      isSelected={isSelected(node.id)}
      isDropTarget={dropTarget?.nodeId === node.id}
      spaceHeldRef={spaceHeld}
      onSelect={handleSelect}
      onDoubleClickZoom={node.type === 'run' ? onFocusRun : undefined}
      onMove={moveHandler}
      onResize={resizeHandler}
      onDragStart={node.type === 'run' ? handleWidgetDragStart : undefined}
      onDragMove={node.type === 'run' ? handleWidgetDragMove : undefined}
      onDragEnd={node.type === 'run' ? handleWidgetDragEnd : undefined}
    />
  )
}
```

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit`
Expected: errors from `src/components/InfiniteCanvas.tsx` should be resolved. Pre-existing errors from other files (not yet migrated) are fine.

- [ ] **Step 7: Commit**

```bash
git add src/components/InfiniteCanvas.tsx
git commit -m "feat: migrate InfiniteCanvas renderNode to widget registry, update drag callbacks and helpers"
```

---

### Task 7: Update useWidgetLayouts

**Files:**
- Modify: `src/hooks/useWidgetLayouts.ts`

Three internal functions branch on `node.type === 'run'` or `node.type !== 'run'`. Replace with `isContainer` from the registry.

- [ ] **Step 1: Add registry import**

At the top of `src/hooks/useWidgetLayouts.ts`:
```typescript
import { getWidgetComponent, toWidgetType } from '../widgets/widgetComponentRegistry'
```

- [ ] **Step 2: Update computeSize (line 74)**

Replace:
```typescript
if (node.type === 'run') {
  const size = { width: DEFAULT_RUN_WIDTH, height: DEFAULT_RUN_HEIGHT }
  sizeMap.set(node.id, size)
  return size
}

const hasContainers = node.children.some(c => c.type !== 'run')
```

With:
```typescript
const reg = getWidgetComponent(toWidgetType(node.type))
if (!reg?.isContainer) {
  const w = reg?.defaultSize?.width ?? DEFAULT_RUN_WIDTH
  const h = reg?.defaultSize?.height ?? DEFAULT_RUN_HEIGHT
  const size = { width: w, height: h }
  sizeMap.set(node.id, size)
  return size
}

const hasContainers = node.children.some(
  c => getWidgetComponent(toWidgetType(c.type))?.isContainer,
)
```

- [ ] **Step 3: Update absolutize (line 128)**

Replace:
```typescript
const hasContainers = parent.children.some(c => c.type !== 'run')
```

With:
```typescript
const hasContainers = parent.children.some(
  c => getWidgetComponent(toWidgetType(c.type))?.isContainer,
)
```

- [ ] **Step 4: Update placeNewRuns (line 181)**

Replace:
```typescript
if (!node || node.type !== 'run') continue
```

With:
```typescript
const nodeReg = getWidgetComponent(toWidgetType(node?.type ?? ''))
if (!node || nodeReg?.isContainer) continue
```

And replace the default size usages in the two `placed.set(...)` calls on lines 198 and 207:
```typescript
// Before:
placed.set(id, { x: maxRight + RUN_GAP, y: refY, width: DEFAULT_RUN_WIDTH, height: DEFAULT_RUN_HEIGHT })
// ...
placed.set(id, { x: parentLayout.x + padX, y: parentLayout.y + padTop, width: DEFAULT_RUN_WIDTH, height: DEFAULT_RUN_HEIGHT })

// After (use registered defaultSize, fall back to constants):
const w = nodeReg?.defaultSize?.width ?? DEFAULT_RUN_WIDTH
const h = nodeReg?.defaultSize?.height ?? DEFAULT_RUN_HEIGHT
placed.set(id, { x: maxRight + RUN_GAP, y: refY, width: w, height: h })
// ...
placed.set(id, { x: parentLayout.x + padX, y: parentLayout.y + padTop, width: w, height: h })
```

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit`
Expected: clean (or only unrelated pre-existing errors)

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useWidgetLayouts.ts
git commit -m "feat: update useWidgetLayouts to use widget registry isContainer instead of node.type checks"
```

---

### Task 8: Wire Imports, CSS, Cleanup, and Verify

**Files:**
- Create: `src/widgets/index.ts`
- Modify: `src/main.tsx`
- Modify: `src/index.css`
- Delete: `src/components/CanvasWidget.tsx`
- Delete: `src/components/GroupContainer.tsx`

- [ ] **Step 1: Create widget barrel**

```typescript
// src/widgets/index.ts
// Side-effect imports: register all widget components at module load
import './runWorkspace'
import './taskGroup'
```

- [ ] **Step 2: Add widget import to main.tsx**

In `src/main.tsx`, add the widget component registrations import alongside the existing hotkey widgets import:

```typescript
// Before:
import './hotkeys/widgets'  // register widget definitions

// After:
import './hotkeys/widgets'  // register hotkey WidgetDefinitions
import './widgets'           // register widget components
```

- [ ] **Step 3: Add CSS classes to src/index.css**

Add the following to `src/index.css` (find an appropriate section, near existing animation classes):

```css
/* ── Widget frame effects ────────────────────────────────────────────── */

/* Run workspace: drag state — scale up + downward beam shadow */
.widget-run-dragging {
  transform: scale(1.03);
  box-shadow:
    0 20px 60px rgba(0, 240, 255, 0.25),
    0 40px 100px rgba(0, 240, 255, 0.12),
    0 0 0 1px rgba(0, 240, 255, 0.4);
  z-index: 100;
  transition: transform 100ms ease-out;
}

/* Run workspace: selected state — cyan glow */
.widget-run-selected {
  box-shadow:
    0 0 0 2px rgba(0, 240, 255, 0.8),
    0 0 20px rgba(0, 240, 255, 0.3);
}

/* Group container: drop-target state — highlight */
.widget-group-drop-target {
  /* applied via TaskGroupWidget's isDropTarget prop — no shell class needed */
}
```

- [ ] **Step 4: Remove GroupContainer and CanvasWidget imports from InfiniteCanvas (if any remain)**

Run: `grep -n "GroupContainer\|CanvasWidget" src/components/InfiniteCanvas.tsx`
Expected: no matches (Task 6 replaced these)

- [ ] **Step 5: Delete old files**

```bash
rm src/components/CanvasWidget.tsx
rm src/components/GroupContainer.tsx
```

- [ ] **Step 6: Final type check**

Run: `npx tsc --noEmit`
Expected: clean output (zero errors)

- [ ] **Step 7: Start dev server and smoke test**

```bash
TINSTAR_FAST_SIM=1 npm run dev
```

Open browser. Verify:
- Canvas renders groups and run widgets
- Dragging a run widget by its header moves it
- Dragging a group container by its header moves it
- Resizing (bottom-right corner) works for both
- Selecting a run widget shows selection styling
- Group containers show drop-target highlight when a run is dragged over them

- [ ] **Step 8: Run E2E tests**

```bash
TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:<port> npx playwright test
```
Expected: all tests pass

- [ ] **Step 9: Commit**

```bash
git add src/widgets/index.ts src/main.tsx src/index.css
git add -u src/components/CanvasWidget.tsx src/components/GroupContainer.tsx
git commit -m "feat: wire widget component registrations, add CSS frame effects, delete legacy CanvasWidget/GroupContainer"
```

---

## Verification Checklist

After all tasks complete:

- [ ] `npx tsc --noEmit` passes clean
- [ ] Playwright E2E suite passes
- [ ] Canvas drag/resize works for both run widgets and group containers
- [ ] Selection styling visible for run widgets
- [ ] Drop-target highlight visible when dragging runs over groups
- [ ] Browser console shows no `No widget registered for type:` warnings
- [ ] `getWidgetComponent('initiative')`, `getWidgetComponent('epic')`, `getWidgetComponent('task')`, `getWidgetComponent('worktree')` all return registrations (can verify in browser console)
