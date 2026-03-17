# Task Metadata on Canvas Container

**Date:** 2026-03-17
**Status:** Approved

## Overview

Surface task metadata (summary, % done, status, definition of done) directly on the canvas task group container, with all fields editable inline. A collapse toggle lets users hide the metadata when they want more canvas space.

## Data Model Changes

### `src/domain/types.ts`

Add `definitionOfDone` to the `Task` interface:

```ts
export interface Task {
  id: string
  name: string
  epicId: string
  initiativeId: string
  status: string
  summary: string
  settings?: EntitySettings
  spaceId?: string
  percentDone?: number | null
  definitionOfDone?: { text: string; checked: boolean }[]  // NEW
}
```

No other type changes required. `TreeNode` already passes `percentDone` and `status` through from the task; `entityId` gives access to the full task via `taxRepo`.

### API (`src/server/api/routes.ts`)

- `POST /api/tasks` — accept `definitionOfDone` in the request body alongside existing fields
- `PATCH /api/tasks/:id` — accept `definitionOfDone` in the patch body (already uses deep merge, so this works automatically)

The document store's `upsertTask` already stores whatever is passed — no changes needed there.

## Component Changes

### `src/components/TaskContainer.tsx`

**New props:**

```ts
interface Props {
  taskId: string
  taskName: string
  // ... existing positioning/resize props ...
  task?: Task                                      // full task object for metadata
  collapsed?: boolean                              // controls metadata visibility
  onToggleCollapse?: (taskId: string) => void      // called when ▼/▲ clicked
  onUpdate?: (taskId: string, patch: Partial<Task>) => void  // fires PATCH /api/tasks/:id
}
```

**Header row** (the existing 32px drag handle):
- Left: grip icon + task name (unchanged)
- Right: status pill (click to cycle `active → blocked → done → active`) + `▼/▲` collapse button

**Metadata section** (rendered below header when `collapsed !== true`):

1. **Progress row** — label "done", progress bar, percentage value
   - Click the `%` number to replace it with a text input; blur/Enter commits, fires `onUpdate({ percentDone })`
   - Progress bar is a visual read-out of the same value (not separately clickable)

2. **Summary** — plain text, click to enter edit mode (textarea, auto-height)
   - Blur or Ctrl+Enter commits, fires `onUpdate({ summary })`
   - Escape cancels

3. **Definition of Done section**
   - Label "Definition of Done"
   - Each item: `[ ]` checkbox + text
     - Click checkbox → toggles `checked`, fires `onUpdate({ definitionOfDone })`
     - Click text → inline edit (single-line input), blur commits, fires `onUpdate({ definitionOfDone })`
   - `+ add criterion` at the bottom appends `{ text: '', checked: false }` and immediately focuses the new input
   - No delete button for now (can be edited to empty via API)

**Collapse button:**
- `▼` when expanded, `▲` when collapsed
- Positioned in the header row, right of the status pill
- Clicking calls `onToggleCollapse(taskId)` — state is managed by the parent

### Collapse State — `src/hooks/useTaskCollapseState.ts` (new)

A small hook that reads/writes collapse state to `localStorage` under the key `tinstar-task-collapse-v1` (a `Record<taskId, boolean>`). Collapsed = `true`, expanded = default (`false`/absent).

```ts
function useTaskCollapseState(): {
  isCollapsed: (taskId: string) => boolean
  toggleCollapse: (taskId: string) => void
}
```

### `src/components/InfiniteCanvas.tsx`

- Instantiate `useTaskCollapseState()`
- Pass `task`, `collapsed`, `onToggleCollapse`, and `onUpdate` down to `TaskContainer`
- `task` is resolved from `taxRepo` by `entityId` for each task-type tree node

### `src/components/WorkspaceShell.tsx`

Add `handleTaskUpdate` callback:

```ts
const handleTaskUpdate = useCallback((taskId: string, patch: Partial<Task>) => {
  fetch(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}, [])
```

Pass it to `InfiniteCanvas` via a new `onTaskUpdate` prop.

## Data Flow

```
User edits field in TaskContainer
  → onUpdate(taskId, patch)
    → InfiniteCanvas passes to WorkspaceShell.handleTaskUpdate
      → PATCH /api/tasks/:id
        → DocumentStore.upsertTask (updates in-memory Map)
          → SSE delta broadcast to all clients
            → useServerEvents delta handler updates state
              → TaxonomyRepository reconstructed
                → TaskContainer re-renders with new values
```

Optimistic updates are not needed — the round-trip is fast enough for text editing.

## What Is Not In Scope

- Delete individual DoD items from the UI (use API directly for now)
- Syncing DoD items with agent output
- Separate "description" field (summary serves this purpose)
- Inline task name editing on the canvas (already supported via sidebar rename)
- Epic or initiative metadata on their canvas containers (task only for now)
