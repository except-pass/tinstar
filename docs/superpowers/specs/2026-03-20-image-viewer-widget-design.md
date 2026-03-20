# Image Viewer Widget — Design Spec

**Date:** 2026-03-20
**Branch:** V3.5.0

---

## Overview

A canvas widget (`image-viewer`) that displays an image file from a session's workspace with live SSE-based updates. Drag any image file from the Changed Files or Explorer panel to spawn one on the canvas.

---

## Entity: `ImageWidget`

Server-persisted in the document store. Included in the `/api/state` SSE snapshot under `imageWidgets[]`.

```typescript
interface ImageWidget {
  id: string           // "image-{8 chars}" via shortId('image')
  spaceId?: string     // activeSpaceId at creation; undefined = appears in all spaces
  sessionId: string
  filePath: string     // absolute path in workspace
  // Resolved at creation time (display names, not IDs):
  task: string
  epic: string
  initiative: string
  worktree: string
  repo: string
  color?: string       // inherits run accent color
  naturalWidth: number   // read from image headers at creation time
  naturalHeight: number
}
```

Also update `SelectionState.selectedType` union in `src/domain/types.ts` to include `'image-viewer'`:

```typescript
selectedType: GroupingDimension | 'run' | 'file-editor' | 'browser-widget' | 'image-viewer' | null
```

---

## Canvas Integration

Synthetic `TreeNode` entries synthesised from `imageWidgets[]`. Same task-injection logic as editor/browser widgets — nested inside their matching task group node via `sessionId → run → taskId`. Orphans appended to tree root. Merged into `canvasTree` only (not `sidebarTree`). `allNodeIds` includes image widget ids.

---

## Drag to Open

**MIME type strategy:** reuse the existing `application/tinstar-editor` drag MIME type. No new type is introduced. The file panels already emit this payload for all files. The `InfiniteCanvas` drop handler branches on file extension after parsing the payload — no changes needed to drag source components or the `onDragEnter` overlay check.

```
application/tinstar-editor → JSON.stringify({ sessionId, filePath })
```

Extension check in the drop handler: if `filePath` ends with an image extension → `POST /api/image-widgets`; otherwise → `POST /api/editor-widgets` as before.

**Image extensions:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`

**Spawn size:** `min(naturalWidth, 1200) × min(naturalHeight, 900)` passed as `spawnLayout` to `insertLayout`.

**Optimistic update:** `onImageWidgetCreated(widget)` prop on `InfiniteCanvas`, implemented as `addOptimistic('imageWidget', widget)` in `WorkspaceShell`.

---

## Live Updates

**Watch endpoint:** `GET /api/image-watch?session=SESSION_ID&path=FILE_PATH`

- Attaches `fs.watch()` with 50ms debounce
- On file change: sends `data: ${JSON.stringify({ type: 'updated', timestamp: Date.now() })}\n\n`
- On pre-stream error: sends `data: ${JSON.stringify({ type: 'error', data: message })}\n\n` then closes
- Sends `: keep-alive` comment every 15 seconds
- On client disconnect: cancels debounce, closes watcher

**`useImageWatch(sessionId, filePath)` hook:**

> **Important:** unlike `useFileWatch` (which returns file text content over SSE), `useImageWatch` does NOT stream image bytes. It only returns a version timestamp. The component uses this timestamp to cache-bust a separate `<img src>` URL pointing at `GET /api/image-file`. Binary image data is never sent over SSE.

- Opens `EventSource` on mount, closes on unmount
- `connected`: `true` on `EventSource.onopen`, `false` on `EventSource.onerror`
- On `message` event: parse `JSON.parse(e.data)`; if `type === 'updated'`, set `lastUpdatedAt = new Date(msg.timestamp)`
- Returns `{ connected, lastUpdatedAt: Date | null }`

**Cache-busting:** `<img src>` = `/api/image-file?session=SESSION_ID&path=FILE_PATH&t={lastUpdatedAt.getTime()}`. When `lastUpdatedAt` updates the browser fetches a fresh copy.

---

## API

```
POST   /api/image-widgets
  Body:    { sessionId, filePath }
  Returns: 200 { ok: true, data: ImageWidget }
  Errors:  404 SESSION_NOT_FOUND, 400 INVALID_PARAMS

DELETE /api/image-widgets/:id
  Returns: 200 { ok: true }
  Errors:  404 NOT_FOUND

GET    /api/image-file?session=SESSION_ID&path=FILE_PATH
  Returns: raw image bytes, Content-Type from MIME map below
  Path resolved: same logic as /api/file-watch — resolve relative to session
    workspace path if relative; use as-is if absolute
  Errors:  404 SESSION_NOT_FOUND, 400 WORKSPACE_UNAVAILABLE, 404 FILE_NOT_FOUND

GET    /api/image-watch?session=SESSION_ID&path=FILE_PATH
  SSE stream (see Live Updates above)
  Errors:  404 SESSION_NOT_FOUND, 400 WORKSPACE_UNAVAILABLE
```

**MIME type map for `GET /api/image-file`:**

| Extension | Content-Type |
|-----------|--------------|
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.svg` | `image/svg+xml` |
| `.bmp` | `image/bmp` |
| `.ico` | `image/x-icon` |

**`POST /api/image-widgets` server-side resolution:** identical to `POST /api/editor-widgets` — look up the run by `sessionId`, walk the taxonomy to resolve `task`, `epic`, `initiative`, `worktree`, `repo`, and inherit `color` from the run. Read `naturalWidth` / `naturalHeight` using the `image-size` npm package on the resolved absolute host path (same path-resolution as `file-watch`). If `image-size` throws (unsupported format or corrupt file), fall back to `naturalWidth: 640, naturalHeight: 480` — do not reject the POST.

---

## Open Externally

Reuses `POST /api/editor/open` and its settings key. Falls back to file-editor's command if none configured.

---

## Widget Layout

```
┌─ [drag-handle] ──────────────────── [↗ Open] [✕] ─┐
│  ⬡ {task} · {worktree} · {filename}                │
├────────────────────────────────────────────────────┤
│                                                    │
│         <img object-fit: contain>                  │
│         (centered, bg: surface-base)               │
│                                                    │
├────────────────────────────────────────────────────┤
│  ● watching · last updated Xs ago                  │
└────────────────────────────────────────────────────┘
```

- `isContainer`: false
- `defaultSize`: `{ width: 640, height: 480 }` — static fallback only; actual spawn size is `naturalWidth × naturalHeight` (capped 1200×900) passed as `spawnLayout` in the drop handler
- `minSize`: `{ width: 200, height: 150 }`
- Both header buttons: `onPointerDown={e => e.stopPropagation()}`
- Missing/unsupported file: centered error message instead of image

---

## Document Store Changes (`src/server/stores/document-store.ts`)

1. Add `private imageWidgets = new Map<string, ImageWidget>()`
2. Add `upsertImageWidget(id, data)`, `deleteImageWidget(id)`, `getAllImageWidgets()`
3. **`clearSpace(spaceId)`** — add `for (const [id, e] of this.imageWidgets) if (e.spaceId === spaceId) this.imageWidgets.delete(id)`
4. **`clear()`** — add `this.imageWidgets.clear()` in the active-space reset block
5. **`enablePersistence()`** — add load block: `if (data.imageWidgets) for (const w of data.imageWidgets) this.imageWidgets.set(w.id, w)`
6. **`snapshot()`** (public, SSE) — add `imageWidgets: [...this.imageWidgets.values()]`
7. **`snapshotAll()`** (private, disk persistence) — add `imageWidgets: [...this.imageWidgets.values()]`. Both must be updated; omitting `snapshotAll` causes widgets to be lost on server restart.

---

## SSE Client Changes (`src/hooks/useServerEvents.ts` and `src/hooks/useBackendState.ts`)

**`useServerEvents.ts`:**
1. Add `imageWidgets: ImageWidget[]` to `ServerState` interface and `EMPTY_STATE`
2. Add `imageWidget` delta handler (upsert when `data !== null`, filter-out when `data === null`)
3. Add `imageWidget` case to `addOptimistic`
4. Add `imageWidgets: []` to the `entity === 'all'` clear branch

**`useBackendState.ts`:**
5. Add `imageWidgets: state.imageWidgets` to the hook's return value so `WorkspaceShell` can access it

---

## WorkspaceShell Changes (`src/components/WorkspaceShell.tsx`)

1. Destructure `imageWidgets` from `useBackendState()`
2. Build `syntheticImageNodes` memo (same pattern as `syntheticEditorNodes`)
3. Build `imageWidgetMap` memo
4. Inject `syntheticImageNodes` into `canvasTree` via the same task-injection pass as editor/browser nodes
5. Add image widget ids to `allNodeIds`
6. Add `if (type === 'image-viewer') { fetch(\`/api/image-widgets/${entityId}\`, { method: 'DELETE' }); return }` to `handleDelete`
7. Pass `imageWidgetMap` and `onImageWidgetCreated={(widget) => addOptimistic('imageWidget', widget)}` to `InfiniteCanvas`

---

## InfiniteCanvas Changes (`src/components/InfiniteCanvas.tsx`)

1. Add `imageWidgetMap?: Map<string, ImageWidget>` and `onImageWidgetCreated?: (w: ImageWidget) => void` to `Props`
2. In `renderNode` entity data resolution: add `node.type === 'image-viewer'` → `imageWidgetMap.get(node.entityId)`
3. In `handleDrop`: check `filePath` extension; image extensions → `POST /api/image-widgets`, use capped natural dimensions as `spawnLayout`, call `onImageWidgetCreated`
4. **`handleSelect`**: add `nodeId.startsWith('image-')` branch → `selectedType: 'image-viewer'`
5. **`handleDoubleClickZoom`**: add `node.type === 'image-viewer'` to the condition enabling double-click zoom
6. **Hotgroup `onHotgroupSelect`**: add `startsWith('image-') ? 'image-viewer'` to the `selType` prefix-chain
7. **Hotgroup type-guards** (`onHotgroupAssign`, `onHotgroupRemove`): add `'image-viewer'` to the `selectedType` allowlist alongside `'file-editor'` and `'browser-widget'`

---

## Widget Registration (`src/widgets/imageViewer/index.ts`)

```typescript
registerWidgetComponent({
  type: 'image-viewer',
  component: ImageViewerWidget,
  isContainer: false,
  defaultSize: { width: 640, height: 480 },  // static fallback only
  minSize: { width: 200, height: 150 },
  dragHandleSelector: '.widget-drag-handle',
  getFrameClass: ({ isSelected, isDragging }) => {
    if (isDragging) return 'widget-run-dragging'
    if (isSelected) return 'widget-run-selected'
    return ''
  },
})
```

**Import location:** add `import './imageViewer'` to `src/widgets/index.ts` (the barrel file).

---

## Implementation Checklist

1. `npm install image-size`
2. Add `ImageWidget` to `src/domain/types.ts`; add `'image-viewer'` to `SelectionState.selectedType` union
3. Update `DocumentStore`: upsert/delete/getAll + `clearSpace` + `clear` + `enablePersistence` + `snapshot` + `snapshotAll`
4. Update `useServerEvents.ts`: `ServerState`, `EMPTY_STATE`, delta handler, `addOptimistic`, clear-all branch
5. Update `useBackendState.ts`: expose `imageWidgets: state.imageWidgets`
6. Add 4 routes to `src/server/api/routes.ts`
7. Create `src/hooks/useImageWatch.ts`
8. Create `src/widgets/imageViewer/ImageViewerWidget.tsx`
9. Create `src/widgets/imageViewer/index.ts`
10. Add `import './imageViewer'` to `src/widgets/index.ts`
11. Update `WorkspaceShell`: syntheticImageNodes, imageWidgetMap, canvasTree injection, allNodeIds, handleDelete, props to InfiniteCanvas
12. Update `InfiniteCanvas`: Props, renderNode, drop handler, handleSelect, handleDoubleClickZoom, hotgroup selType chain, hotgroup type-guards
