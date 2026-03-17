# Editor Widget — Design Spec
*Date: 2026-03-17*

## Overview

A new canvas widget type (`file-editor`) that lets users drag a file from a run's Changed or Explorer panel onto the InfiniteCanvas. The widget displays the file contents in a read-only Monaco editor with live SSE-based updates. It is a first-class, server-persisted entity that survives page refresh and renders through the same `CanvasWidgetShell` pipeline as all other widgets.

---

## 1. Entity: `EditorWidget`

Stored server-side in the document store. Included in the `/api/state` SSE snapshot under `editorWidgets[]`.

```typescript
interface EditorWidget {
  id: string          // shortId('editor') — "editor-{8 leading chars of uuid}"
  spaceId?: string    // set to activeSpaceId at creation (may be undefined when no space is active)
  sessionId: string   // source run's session
  filePath: string    // absolute path in workspace
  // Resolved to display names at creation time (not IDs):
  task: string
  epic: string
  initiative: string
  worktree: string
  repo: string
  color?: string      // inherits run accent color
}
```

`shortId` is a private helper in `src/server/api/routes.ts`. Extract it to `src/server/utils/shortId.ts` so it can be used by the new editor-widgets handler without duplication.

**Space filtering:** `editorWidgets` follow the same `inSpace` predicate as all other entities — `!sid || !e.spaceId || e.spaceId === sid`. Widgets created when no space is active (`spaceId: undefined`) will appear in every space's snapshot, mirroring existing behaviour for other unscoped entities.

---

## 2. Canvas Integration — Synthetic TreeNodes

The InfiniteCanvas renders widgets from a `TreeNode[]` tree. `EditorWidget` instances are not hierarchical, so the client synthesises flat top-level `TreeNode` entries from `editorWidgets[]` in `ServerState`.

Each `EditorWidget` maps to:

```typescript
{
  id: widget.id,       // e.g. "editor-a1b2c3d"  (same string as entityId)
  label: basename(widget.filePath),
  type: 'file-editor',
  entityId: widget.id,
  children: [],
  runCount: 0,
  activeCount: 0,
  color: widget.color,
}
```

**Tree construction:** `WorkspaceShell` currently calls `buildWorkspaceView` to produce `sidebarTree` and passes the same tree to both `HierarchySidebar` and `InfiniteCanvas`. Add a separate `canvasTree` derived in a second `useMemo`:

```typescript
const canvasTree = useMemo(
  () => [...sidebarTree, ...syntheticEditorNodes],
  [sidebarTree, syntheticEditorNodes]
)
```

Pass `canvasTree` to `InfiniteCanvas` and keep `sidebarTree` for `HierarchySidebar`. Editor widget nodes must not appear in the hierarchy sidebar.

`syntheticEditorNodes` is a `useMemo` derived from `state.editorWidgets`.

**`InfiniteCanvas` props change:** Add `editorWidgetMap: Map<string, EditorWidget>` (keyed by `widget.id`) alongside `runMap`. Pass it in from `WorkspaceShell`.

**`renderNode` data routing:** Add a third branch for `'file-editor'`:

```typescript
const data: unknown =
  node.type === 'run'
    ? runMap.get(node.entityId)
    : node.type === 'file-editor'
      ? editorWidgetMap.get(node.entityId)
      : ({ node, depth: ..., onShrinkToFit: ..., onDelete: ..., onMenuOpen: ... } satisfies GroupWidgetData)
```

**Widget registration:** `FileEditorWidget` must be registered with `defaultSize: { width: 640, height: 480 }` so `generateDefaultLayouts` uses the correct size (rather than the run defaults of 880 × 820).

**Layout key:** Layouts live under the space-scoped key `tinstar-layouts-v3-{spaceId}` (or `tinstar-layouts-v3` when no active space), managed by `useWidgetLayouts`. A new layout entry is keyed by `widget.id`.

**`useWidgetLayouts` extension — two changes:**

1. **`loadLayouts` modification**: Currently only loads IDs present in the current tree. Change it to also load any saved positions from localStorage that are NOT in the current tree, so editor widget positions are ready in the map before their tree nodes arrive via SSE:

   ```typescript
   // After the existing per-ID loading loop, add:
   for (const [id, layout] of Object.entries(parsed)) {
     if (!map.has(id) && typeof (layout as WidgetLayout).x === 'number') {
       map.set(id, layout as WidgetLayout)
     }
   }
   ```

   With this change, when the reconciliation path runs `layoutsRef.current.has(id)` for a newly arrived editor widget node, the entry is already there — no default regeneration, no position loss.

2. **`insertLayout` return value**: Add `insertLayout(id: string, layout: WidgetLayout): void` to the hook's return object (not a module-level export). Implement matching the existing mutation pattern — update the ref directly then schedule state:

   ```typescript
   const insertLayout = useCallback((id: string, layout: WidgetLayout) => {
     layoutsRef.current = new Map(layoutsRef.current).set(id, layout)
     setLayouts(new Map(layoutsRef.current))
   }, [])
   ```

---

## 3. Drag Interaction

**Drag sources — both file panels set the same transfer payload:**

```
application/tinstar-editor → JSON.stringify({ sessionId, filePath })
```

- `FileTreePanel`: already uses native HTML5 drag (`draggable` + `onDragStart`). Add `e.dataTransfer.setData('application/tinstar-editor', ...)` inside its existing `handleDragStart`. `sessionId` is already available as `Props.sessionId`.
- `TouchedFilesPanel`: add `draggable` + `onDragStart` with the same payload.

**Drop target — `InfiniteCanvas`:**

The `onDrop` handler must live **inside `InfiniteCanvas`** because both `camera` (from `useCanvasCamera()`) and `insertLayout` (from `useWidgetLayouts()`) are only available in that component's scope. Add `onDragOver` (`e.preventDefault()`) and `onDrop` handlers to the canvas `<div>`.

On drop:
1. Parse `sessionId` + `filePath` from `e.dataTransfer.getData('application/tinstar-editor')`.
2. `POST /api/editor-widgets` with `{ sessionId, filePath }` → returns the created `EditorWidget`.
3. Calculate spawn position:
   - Find `run` by iterating `runMap.values()` where `run.sessionId === sessionId`.
   - `run.id` is the entity key (e.g. `"R-abc123"`). The corresponding `TreeNode` has `id: 'run-' + run.id` (set by `buildGroupTree`).
   - Look up that node's layout via `layouts.get('run-' + run.id)` (the `layouts` Map from `useWidgetLayouts`).
   - Spawn at `{ x: sourceLayout.x + sourceLayout.width + 16, y: sourceLayout.y, width: 640, height: 480 }`.
   - **Fallback** (no source layout found): convert drop coordinates using the camera transform:
     ```typescript
     const rect = canvasRef.current!.getBoundingClientRect()
     const x = (e.clientX - rect.left - camera.x) / camera.zoom
     const y = (e.clientY - rect.top  - camera.y) / camera.zoom
     ```
4. Call `insertLayout(widget.id, spawnLayout)`.

---

## 4. Widget Component (`FileEditorWidget`)

Registered as `type: 'file-editor'` via `registerWidgetComponent`. Set `supportsMinimize: false`.

**Structure:**

```
┌─ [drag-handle] ──────────────────────────────── [Open in Editor] ─┐
│  ⬡ {task} · {worktree} · {filePath basename}                       │
├────────────────────────────────────────────────────────────────────┤
│  Monaco editor (read-only, language auto-detected from extension)  │
│  — or — "Binary or large file — open in external editor"          │
├────────────────────────────────────────────────────────────────────┤
│  ● watching · last updated Xs ago    — or — ○ disconnected        │
└────────────────────────────────────────────────────────────────────┘
```

- **Header**: `className="widget-drag-handle"` on the left; breadcrumb `task · worktree · filename`; "Open in Editor" button calls `POST /api/editor/open` with `{ path: widget.filePath, sessionId: widget.sessionId }`.
- **Body**: Monaco in `readOnly: true`; language auto-detected from extension. If content exceeds 500 KB *or* contains null bytes in first 8 KB, show a plain text message instead. Check is client-side; the server streams content regardless.
- **Footer**: Green dot + "watching" + "last updated N seconds ago"; grey dot + "disconnected" when SSE drops.

**Default size**: `{ width: 640, height: 480 }`. **Min size**: `{ width: 300, height: 200 }`.

**Close behaviour**: Clicking the shell's close button calls `DELETE /api/editor-widgets/:id`. The synthetic `TreeNode` disappears on the next SSE delta, unmounting the widget. Stale layout keys persist indefinitely in localStorage — consistent with all other widgets.

---

## 5. Live Updates — SSE File Watcher

**Server endpoint:** `GET /api/file-watch?session=SESSION_ID&path=FILE_PATH`

Uses the shared SSE helper (`Content-Type: text/event-stream` + `Cache-Control: no-cache`).

- Returns `404` if `session` is not a known session ID.
- Returns `400 { error: 'session workspace unavailable' }` if `session.workspace.path` is null.
- Resolves `FILE_PATH` relative to `session.workspace.path` if relative; uses as-is if already absolute.
- Reads initial file content and sends it as the first SSE event.
- Attaches an `fs.watch()` listener with a **50 ms debounce** to collapse rapid consecutive events. Re-reads and streams full content on each debounced trigger.
- If `fs.watch()` throws, sends `{ type: 'error', data: 'file unavailable' }` and closes the stream.
- Sends a keepalive comment (`: keep-alive\n\n`) every 15 seconds.
- On SSE client disconnect, cancels the debounce timer and closes the watcher.

**SSE event shape:**

```typescript
{ type: 'content', data: string }
{ type: 'error',   data: string }
```

**Client hook:** `useFileWatch(sessionId: string, filePath: string)`

- `connected` initialises to `false`; becomes `true` on first message, `false` on `EventSource` error.
- Opens an `EventSource` on mount; relies on the browser's built-in reconnect.
- On each `content` event: save `editor.getScrollTop()` + `editor.getScrollLeft()`, call `editor.setValue(content)`, then restore scroll inside an `editor.onDidChangeModelContent` callback (not synchronously — Monaco resets scroll during `setValue` processing).
- Tracks `lastUpdatedAt: Date`.
- Closes `EventSource` on unmount.

---

## 6. Server Endpoints

```
POST   /api/editor-widgets
  Body:    { sessionId: string, filePath: string }
  Success: 200 { ok: true, data: EditorWidget }
  Errors:  404 { ok: false, error: { code: 'SESSION_NOT_FOUND', message: string } }
           400 { ok: false, error: { code: 'INVALID_PARAMS',    message: string } }

DELETE /api/editor-widgets/:id
  Success: 200 { ok: true }
  Errors:  404 { ok: false, error: { code: 'NOT_FOUND', message: string } }

GET    /api/file-watch?session=&path=
  SSE stream. See Section 5.
  Pre-stream errors: 404 (session not found), 400 (workspace unavailable / invalid params)
```

State mutations go through document store methods; the SSE broadcaster picks up changes automatically via the `changes` event — routes do not emit SSE deltas directly.

---

## 7. State Integration

**`ServerState` type** (in `useServerEvents.ts`) gains `editorWidgets: EditorWidget[]`. `EMPTY_STATE` also gains `editorWidgets: []`.

**Delta handler** — add two blocks:

```typescript
// Clear-all delta (entity === 'all') must also clear editorWidgets:
if (delta.entity === 'all' && delta.data === null) {
  return { ...prev, initiatives: [], epics: [], tasks: [], worktrees: [], runs: [], editorWidgets: [] }
}

// Editor widget upsert/delete (inline, no helper — matches existing pattern):
if (delta.entity === 'editorWidget') {
  const prev = s.editorWidgets
  if (delta.data === null) {
    return { ...s, editorWidgets: prev.filter(w => w.id !== delta.id) }
  }
  const w = delta.data as EditorWidget
  const idx = prev.findIndex(x => x.id === w.id)
  return {
    ...s,
    editorWidgets: idx >= 0 ? prev.map((x, i) => (i === idx ? w : x)) : [...prev, w],
  }
}
```

**Document store** — all locations updated explicitly:

| Location | Change |
|---|---|
| Private fields | `private editorWidgets = new Map<string, EditorWidget>()` |
| `enablePersistence()` | Add load: `if (data.editorWidgets) for (const w of data.editorWidgets) this.editorWidgets.set(w.id, w)` |
| `snapshot()` | Add `editorWidgets: [...this.editorWidgets.values()].filter(inSpace)` |
| `snapshotAll()` (private) | Add `editorWidgets: [...this.editorWidgets.values()]` |
| `clearSpace(spaceId)` | `for (const [id, e] of this.editorWidgets) if (e.spaceId === spaceId) this.editorWidgets.delete(id)` |
| `clear()` else branch | `this.editorWidgets.clear()` (the `if (sid)` branch delegates to `clearSpace`, which handles it) |

---

## 8. Known Limitations

- **Multi-tab layout divergence**: Layouts live in localStorage. If Tinstar is open in two tabs, editor widget positions may diverge — consistent with all other widgets.
- **Orphaned widgets**: Deleting a session leaves editor widgets on canvas. The file-watch SSE returns 404, the footer shows "disconnected", and the widget can be closed manually.
- **Stale localStorage keys**: Closed widget layout entries persist indefinitely and are silently ignored.

---

## 9. Out of Scope

- Editable / writable mode.
- Multiple-file tabs within one widget.
- Syncing layout to the server.
- Minimise support.
- Editor widget nodes in the hierarchy sidebar.
