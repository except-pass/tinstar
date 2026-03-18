# File Editor Widget

A canvas widget (`file-editor`) that displays a file from a session's workspace in a read-only Monaco editor with live SSE-based updates. Drag any file from the Changed or Explorer panel to spawn one on the canvas.

---

## Entity: `EditorWidget`

Server-persisted in the document store. Included in the `/api/state` SSE snapshot under `editorWidgets[]`.

```typescript
interface EditorWidget {
  id: string          // "editor-{8 chars}" via shortId('editor')
  spaceId?: string    // activeSpaceId at creation; undefined = appears in all spaces
  sessionId: string
  filePath: string    // absolute path in workspace
  // Resolved at creation time (display names, not IDs):
  task: string
  epic: string
  initiative: string
  worktree: string
  repo: string
  color?: string      // inherits run accent color
}
```

Editor widgets with no `spaceId` appear in every space's snapshot — consistent with other unscoped entities.

---

## Canvas Integration

Editor widgets are not hierarchical, so `WorkspaceShell` synthesises flat `TreeNode` entries from `editorWidgets[]`:

```typescript
{
  id: widget.id,
  label: basename(widget.filePath),
  type: 'file-editor',
  entityId: widget.id,
  children: [],
  runCount: 0,
  activeCount: 0,
  color: widget.color,
}
```

These synthetic nodes are merged into `canvasTree` (passed to `InfiniteCanvas`) but **not** `sidebarTree` (passed to `HierarchySidebar`). Editor widgets never appear in the sidebar.

Layout is stored in localStorage under the same space-scoped key as all other widgets (`tinstar-layouts-v3-{spaceId}`), keyed by `widget.id`.

---

## Drag to Open

Both file panels emit the same HTML5 drag payload:

```
application/tinstar-editor → JSON.stringify({ sessionId, filePath })
```

**Drop handling** is in `InfiniteCanvas` (where `camera` and `insertLayout` are available):

1. Parse `sessionId` + `filePath` from the drag data
2. `POST /api/editor-widgets { sessionId, filePath }` → returns the new `EditorWidget`
3. Spawn position: next to the source run's widget (`{ x: runLayout.x + runLayout.width + 16, y: runLayout.y }`)
4. Fallback (source run has no layout): convert drop coordinates via camera transform

---

## Live Updates: SSE File Watcher

**Endpoint:** `GET /api/file-watch?session=SESSION_ID&path=FILE_PATH`

- Path is resolved relative to `session.workspace.path` if relative; used as-is if absolute
- Reads initial content and sends it immediately as the first event
- Attaches `fs.watch()` with a **50ms debounce** to collapse rapid saves
- Sends `: keep-alive` comment every **15 seconds**
- On client disconnect: cancels debounce timer, closes watcher

**SSE event shapes:**

```typescript
{ type: 'content', data: string }
{ type: 'error',   data: string }  // e.g. file unavailable
```

**Pre-stream errors:** `404` (session not found), `400` (workspace unavailable)

**Client hook:** `useFileWatch(sessionId, filePath)` — opens `EventSource` on mount, closes on unmount. Restores scroll position after `setValue` using `onDidChangeModelContent` callback (not synchronously — Monaco resets scroll during `setValue` processing).

---

## API

```
POST   /api/editor-widgets
  Body:    { sessionId, filePath }
  Returns: 200 { ok: true, data: EditorWidget }
  Errors:  404 SESSION_NOT_FOUND, 400 INVALID_PARAMS

DELETE /api/editor-widgets/:id
  Returns: 200 { ok: true }
  Errors:  404 NOT_FOUND

GET    /api/file-watch?session=&path=
  SSE stream (see above)
```

---

## Widget Layout

```
┌─ [drag-handle] ─────────────────────── [wrap] [↗ Open in Editor] [✕] ─┐
│  ⬡ {task} · {worktree} · {filename}                                     │
├─────────────────────────────────────────────────────────────────────────┤
│  Monaco editor (read-only, language auto-detected from extension)       │
│  — or — "Binary or large file — open in external editor"               │
├─────────────────────────────────────────────────────────────────────────┤
│  ● watching · last updated Xs ago    — or — ○ disconnected             │
└─────────────────────────────────────────────────────────────────────────┘
```

**Binary/large file check:** client-side — `> 500KB` OR null bytes in first 8KB → show message instead of Monaco.

**Close:** clicking ✕ calls `DELETE /api/editor-widgets/:id`. The `EditorWidget` SSE delta arrives, the synthetic tree node disappears, the widget unmounts. Layout entry persists in localStorage (consistent with all other widgets).

**Word wrap:** toggled via the `wrap` button in the header; lit cyan when active.

---

## Known Limitations

- **Orphaned widgets:** deleting a session leaves editor widgets on canvas. File-watch SSE returns 404; footer shows "disconnected". Close manually.
- **Multi-tab divergence:** layouts live in localStorage. Two open tabs may have divergent positions.
- **Read-only:** no write/edit mode.
