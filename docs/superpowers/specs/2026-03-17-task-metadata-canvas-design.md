# Task Metadata on Canvas Container

**Date:** 2026-03-17
**Status:** Approved

## Overview

Surface task metadata (summary, % done, status, definition of done) directly on the canvas task group container, with all fields editable inline. A collapse toggle lets users hide the metadata when they want more canvas space.

`TaskContainer.tsx` is dead code — it is not wired into the canvas render tree. The actual rendering target is `TaskGroupWidget`, which receives a `GroupWidgetData` payload assembled in `InfiniteCanvas.renderNode()`.

## Data Model Changes

### `src/domain/types.ts`

Add `definitionOfDone` to the `Task` interface. Also tighten `status` to a union (currently `string` — `Initiative` already uses a typed union, so this is consistent):

```ts
export interface Task {
  id: string
  name: string
  epicId: string
  initiativeId: string
  status: 'active' | 'blocked' | 'done'   // was: string
  summary: string
  settings?: EntitySettings
  spaceId?: string
  percentDone?: number | null
  definitionOfDone?: { text: string; checked: boolean }[]  // NEW
}
```

### API (`src/server/api/routes.ts`)

- `POST /api/tasks` — accept `definitionOfDone` in the request body alongside existing fields
- `PATCH /api/tasks/:id` — accept `definitionOfDone` in the patch body

`deepMergeEntity` does a shallow spread (`{ ...existing, ...patch }`), so sending `{ definitionOfDone: [...newArray] }` replaces the whole array — which is exactly what we want. **Always send the complete `definitionOfDone` array on every update, never a partial.** Sending a partial array will silently discard unchecked items.

## Component Changes

### `src/widgets/widgetComponentRegistry.ts` — extend `GroupWidgetData`

```ts
import type { Task } from '../domain/types'

export interface GroupWidgetData {
  node: { id: string; label: string; type: string; entityId: string; children: unknown[]; color?: string }
  depth: number
  onShrinkToFit?: (id: string) => void
  onDelete?: (id: string) => void
  onMenuOpen?: (nodeId: string, anchorRect: DOMRect) => void
  // NEW — only populated for task-type nodes
  task?: Task
  collapsed?: boolean
  onToggleCollapse?: (taskId: string) => void
  onTaskUpdate?: (taskId: string, patch: Partial<Task>) => void
}
```

### `src/widgets/taskGroup/TaskGroupWidget.tsx`

The component renders `GroupWidgetData`. For task-type nodes (`node.type === 'task'`), render the expanded metadata section below the existing drag-handle header.

**Header row** (existing `widget-drag-handle` div — unchanged except additions):
- Keep: icon + label + menu button / delete button
- Add right of existing buttons: status pill (only when `node.type === 'task'`) + `▼/▲` collapse button (only when `node.type === 'task'`)
- Status pill: click cycles `active → blocked → done → active`, calls `onTaskUpdate(node.entityId, { status: nextStatus })`; stop pointer propagation
- Collapse button: calls `onToggleCollapse?.(node.entityId)`; stop pointer propagation

**Metadata section** (below header, `node.type === 'task'` only, hidden when `collapsed`):

All interactive elements must call `e.stopPropagation()` on `onPointerDown` to prevent canvas pan, marquee selection, and container drag.

1. **Progress row** — `done` label + progress bar + percentage
   - Click the `%` value: replace with `<input type="number" min=0 max=100>`; blur/Enter commits, calls `onTaskUpdate(entityId, { percentDone: value })`; Escape cancels
   - Progress bar is a read-only visual of the same value

2. **Summary** — click the text to enter edit mode (`<textarea>`, auto-height)
   - Blur or Ctrl+Enter commits, calls `onTaskUpdate(entityId, { summary: value })`
   - Escape cancels, restores original

3. **Definition of Done**
   - Label row: "Definition of Done"
   - Each item: `[ ]` checkbox + text
     - Click checkbox: toggles `checked`, calls `onTaskUpdate(entityId, { definitionOfDone: fullUpdatedArray })`
     - Click text: inline `<input>`, blur commits, calls `onTaskUpdate(entityId, { definitionOfDone: fullUpdatedArray })`; always send the complete array
   - `+ add criterion`: appends `{ text: '', checked: false }`, immediately focuses new input
   - Optimistic local state for checkbox toggles and new-item appends (round-trip visible lag on toggles would violate UI philosophy); text fields can wait for server confirmation

**Collapsed-height behaviour:** when `collapsed` is `true`, the metadata section is hidden (`display: none`). The container's stored layout height is unchanged — only the content is hidden. A `minHeight` equal to the header row height (32px) is enforced via `style` so the container never shrinks below the drag handle. Users can then manually resize to a smaller footprint if they want.

### `src/components/InfiniteCanvas.tsx`

**New prop:**
```ts
interface Props {
  // ...existing...
  onTaskUpdate?: (taskId: string, patch: Partial<Task>) => void  // NEW
}
```

**Obtain `taxRepo`** — call `const taxRepo = useTaxonomy()` at the top of `InfiniteCanvas` (import from `./TaxonomyContext`). This is the same pattern used by `RunWorkspaceWidget`.

**`renderNode()` — extend `GroupWidgetData` assembly**:
```ts
const data: unknown =
  node.type === 'run'
    ? runMap.get(node.entityId)
    : ({
        node,
        depth: depthMapRef.current.get(node.id) ?? 0,
        onShrinkToFit: shrinkNode,
        onDelete: handleDeleteGroup,
        onMenuOpen: handleMenuOpenGroup,
        // NEW — task-specific fields
        ...(node.type === 'task' && {
          task: taxRepo.getTaskById(node.entityId),
          collapsed: isTaskCollapsed(node.entityId),
          onToggleCollapse: toggleTaskCollapse,
          onTaskUpdate: props.onTaskUpdate,
        }),
      } satisfies GroupWidgetData)
```

**Collapse state** — instantiate `useTaskCollapseState()` in `InfiniteCanvas`, destructure `isTaskCollapsed` and `toggleTaskCollapse`.

### `src/hooks/useTaskCollapseState.ts` (new file)

Reads/writes collapse state to `localStorage` under key `tinstar-task-collapse-v1` (`Record<taskId, boolean>`). Collapsed = `true`, expanded = default.

```ts
export function useTaskCollapseState(): {
  isTaskCollapsed: (taskId: string) => boolean
  toggleTaskCollapse: (taskId: string) => void
}
```

### `src/components/WorkspaceShell.tsx`

Add `handleTaskUpdate` and pass it to `InfiniteCanvas`:

```ts
const handleTaskUpdate = useCallback((taskId: string, patch: Partial<Task>) => {
  fetch(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}, [])

// In JSX:
<InfiniteCanvas
  // ...existing props...
  onTaskUpdate={handleTaskUpdate}
/>
```

## Data Flow

```
User edits field in TaskGroupWidget
  → onTaskUpdate(taskId, patch)          ← always send complete arrays for definitionOfDone
    → InfiniteCanvas passes through props.onTaskUpdate
      → WorkspaceShell.handleTaskUpdate
        → PATCH /api/tasks/:id
          → DocumentStore.upsertTask
            → SSE delta broadcast
              → useServerEvents updates state
                → TaxonomyRepository reconstructed
                  → InfiniteCanvas passes new task to TaskGroupWidget via GroupWidgetData
```

Optimistic local state is used for checkbox toggles and new DoD item appends only. Text fields (summary, percentDone) wait for server round-trip — fast enough for typing.

## What Is Not In Scope

- Deleting individual DoD items from the UI (edit via API directly)
- Syncing DoD with agent output
- A separate `description` field — `summary` serves this purpose
- Inline task name editing on the canvas (use sidebar rename)
- Metadata on epic or initiative containers (task only)
- `TaskContainer.tsx` — leave as dead code, do not delete (separate cleanup)
