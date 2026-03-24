# Image Viewer Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `image-viewer` canvas widget that displays an image file from a session workspace, live-updates on file changes via SSE cache-busting, and is created by dragging image files from the file panel.

**Architecture:** Reuses `application/tinstar-editor` MIME type for drag; drop handler in InfiniteCanvas branches on file extension to route image files to `/api/image-widgets`. Image bytes are served by a dedicated `GET /api/image-file` route (never over SSE); the `GET /api/image-watch` SSE stream emits only timestamps that the widget uses to cache-bust its `<img src>`. Natural dimensions are read server-side at POST time via `image-size` npm package.

**Tech Stack:** React + TypeScript (frontend), Node.js HTTP (backend), `image-size` npm package, `fs.watch` for file watching, SSE for live updates.

**Spec:** `docs/superpowers/specs/2026-03-20-image-viewer-widget-design.md`

---

## File Map

**Create:**
- `src/hooks/useImageWatch.ts` — SSE hook that returns `{ connected, lastUpdatedAt }`
- `src/widgets/imageViewer/ImageViewerWidget.tsx` — React component
- `src/widgets/imageViewer/index.ts` — widget registration

**Modify:**
- `src/domain/types.ts` — add `ImageWidget` interface; add `'image-viewer'` to `SelectionState.selectedType`
- `src/server/stores/document-store.ts` — add imageWidgets CRUD + clearSpace/clear/persistence/snapshot
- `src/hooks/useServerEvents.ts` — `ServerState`, `EMPTY_STATE`, delta handler, `addOptimistic`, clear-all branch
- `src/hooks/useBackendState.ts` — expose `imageWidgets`
- `src/server/api/routes.ts` — 4 new routes (POST, DELETE, GET image-file, GET image-watch)
- `src/widgets/index.ts` — add `import './imageViewer'`
- `src/components/WorkspaceShell.tsx` — syntheticImageNodes, imageWidgetMap, canvasTree, allNodeIds, handleDelete, InfiniteCanvas props
- `src/components/InfiniteCanvas.tsx` — Props, renderNode, drop handler, handleSelect, handleDoubleClickZoom, hotgroup chains

---

### Task 1: Install image-size and add ImageWidget type

**Files:**
- Modify: `package.json` (via npm install)
- Modify: `src/domain/types.ts`

- [ ] **Step 1: Install image-size**

```bash
cd /home/ubuntu/repo/tinstar && npm install image-size
```

Expected: package installs without error, `image-size` appears in `package.json` dependencies.

- [ ] **Step 2: Add ImageWidget interface to types.ts**

In `src/domain/types.ts`, after the `BrowserWidget` interface (around line 124), add:

```typescript
export interface ImageWidget {
  id: string
  spaceId?: string
  sessionId: string
  filePath: string
  task: string
  epic: string
  initiative: string
  worktree: string
  repo: string
  color?: string
  naturalWidth: number
  naturalHeight: number
}
```

- [ ] **Step 3: Update SelectionState.selectedType in types.ts**

Find `SelectionState` in `src/domain/types.ts`. The `selectedType` line currently reads:
```typescript
selectedType: GroupingDimension | 'run' | 'file-editor' | 'browser-widget' | null
```
Change it to:
```typescript
selectedType: GroupingDimension | 'run' | 'file-editor' | 'browser-widget' | 'image-viewer' | null
```

- [ ] **Step 4: Type-check**

```bash
cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors from types.ts (other unrelated errors are OK at this stage).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/repo/tinstar && git add package.json package-lock.json src/domain/types.ts
git commit -m "feat: add ImageWidget type and install image-size #V3-5-0"
```

---

### Task 2: Update DocumentStore

**Files:**
- Modify: `src/server/stores/document-store.ts`

- [ ] **Step 1: Add import for ImageWidget**

At the top import line in `document-store.ts`, add `ImageWidget` to the domain types import:

```typescript
import type { Initiative, Epic, Task, Worktree, Run, Space, EditorWidget, BrowserWidget, ImageWidget } from '../../domain/types'
```

- [ ] **Step 2: Add private imageWidgets map**

After `private browserWidgets = new Map<string, BrowserWidget>()` (line ~17), add:

```typescript
  private imageWidgets = new Map<string, ImageWidget>()
```

- [ ] **Step 3: Add CRUD methods**

After `getAllBrowserWidgets()` (around line 318), add:

```typescript
  // --- Image Widgets ---

  upsertImageWidget(id: string, data: ImageWidget): void {
    this.imageWidgets.set(id, data)
    this.changes.emit('change', { entity: 'imageWidget', id, data })
  }

  deleteImageWidget(id: string): void {
    this.imageWidgets.delete(id)
    this.changes.emit('change', { entity: 'imageWidget', id, data: null })
  }

  getAllImageWidgets(): ImageWidget[] {
    return [...this.imageWidgets.values()]
  }
```

- [ ] **Step 4: Update enablePersistence loading**

In `enablePersistence`, after the `browserWidgets` load line (line ~44), add:

```typescript
      if (data.imageWidgets) for (const w of data.imageWidgets) this.imageWidgets.set(w.id, w)
```

- [ ] **Step 5: Update snapshot() — SSE/client snapshot**

In `snapshot()`, after `browserWidgets: this.getAllBrowserWidgets().filter(inSpace),` add:

```typescript
      imageWidgets: this.getAllImageWidgets().filter(inSpace),
```

- [ ] **Step 6: Update snapshotAll() — disk persistence**

In `snapshotAll()`, after `browserWidgets: this.getAllBrowserWidgets(),` add:

```typescript
      imageWidgets: this.getAllImageWidgets(),
```

- [ ] **Step 7: Update clearSpace()**

In `clearSpace()`, after the `browserWidgets` loop (line ~366), add:

```typescript
    for (const [id, e] of this.imageWidgets) if (e.spaceId === spaceId) this.imageWidgets.delete(id)
```

- [ ] **Step 8: Update clear() — active space reset**

In the `else` branch of `clear()` (no active space), after `this.browserWidgets.clear()` (line ~383), add:

```typescript
      this.imageWidgets.clear()
```

- [ ] **Step 9: Type-check**

```bash
cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1 | grep document-store
```

Expected: no errors from document-store.ts.

- [ ] **Step 10: Commit**

```bash
cd /home/ubuntu/repo/tinstar && git add src/server/stores/document-store.ts
git commit -m "feat: add imageWidgets to DocumentStore #V3-5-0"
```

---

### Task 3: Update useServerEvents and useBackendState

**Files:**
- Modify: `src/hooks/useServerEvents.ts`
- Modify: `src/hooks/useBackendState.ts`

- [ ] **Step 1: Add ImageWidget to useServerEvents imports**

At the top of `src/hooks/useServerEvents.ts`, add `ImageWidget` to the domain types import:

```typescript
import type { Initiative, Epic, Task, Worktree, Run, Space, EditorWidget, BrowserWidget, ImageWidget } from '../domain/types'
```

- [ ] **Step 2: Add imageWidgets to ServerState interface**

In the `ServerState` interface, after `browserWidgets: BrowserWidget[]`, add:

```typescript
  imageWidgets: ImageWidget[]
```

- [ ] **Step 3: Add imageWidgets to EMPTY_STATE**

In `EMPTY_STATE`, after `browserWidgets: []`, add:

```typescript
  imageWidgets: [],
```

- [ ] **Step 4: Add imageWidget to addOptimistic**

In `addOptimistic`, after the `browserWidget` block, add:

```typescript
      if (entity === 'imageWidget') {
        const w = data as ImageWidget
        const exists = prev.imageWidgets.some(x => x.id === w.id)
        return { ...prev, imageWidgets: exists ? prev.imageWidgets.map(x => x.id === w.id ? w : x) : [...prev.imageWidgets, w] }
      }
```

- [ ] **Step 5: Add imageWidget delta handler**

In the delta handler block (inside `setState`), after the `browserWidget` block, add:

```typescript
        if (delta.entity === 'imageWidget') {
          const iws = prev.imageWidgets
          if (delta.data === null) {
            return { ...prev, imageWidgets: iws.filter(w => w.id !== delta.id) }
          }
          const w = delta.data as ImageWidget
          const idx = iws.findIndex(x => x.id === w.id)
          return {
            ...prev,
            imageWidgets: idx >= 0 ? iws.map((x, i) => (i === idx ? w : x)) : [...iws, w],
          }
        }
```

- [ ] **Step 6: Update clear-all branch**

Find the line: `return { ...prev, initiatives: [], epics: [], tasks: [], worktrees: [], runs: [], editorWidgets: [], browserWidgets: [] }`

Add `imageWidgets: []` to it:

```typescript
          return { ...prev, initiatives: [], epics: [], tasks: [], worktrees: [], runs: [], editorWidgets: [], browserWidgets: [], imageWidgets: [] }
```

- [ ] **Step 7: Update useBackendState.ts**

In `src/hooks/useBackendState.ts`, the return statement on line 23 currently reads:

```typescript
  return { runRepo, taxRepo, spaces: state.spaces, activeSpaceId: state.activeSpaceId, readyQueue: state.readyQueue, editorWidgets: state.editorWidgets, browserWidgets: state.browserWidgets, connected, loading, addOptimistic, disconnect }
```

Change it to:

```typescript
  return { runRepo, taxRepo, spaces: state.spaces, activeSpaceId: state.activeSpaceId, readyQueue: state.readyQueue, editorWidgets: state.editorWidgets, browserWidgets: state.browserWidgets, imageWidgets: state.imageWidgets, connected, loading, addOptimistic, disconnect }
```

- [ ] **Step 8: Type-check**

```bash
cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1 | grep -E "useServerEvents|useBackendState"
```

Expected: no errors from those files.

- [ ] **Step 9: Commit**

```bash
cd /home/ubuntu/repo/tinstar && git add src/hooks/useServerEvents.ts src/hooks/useBackendState.ts
git commit -m "feat: add imageWidget to SSE state and backend state hook #V3-5-0"
```

---

### Task 4: Add API routes

**Files:**
- Modify: `src/server/api/routes.ts`

Add 4 routes after the `DELETE /api/editor-widgets/:id` block (around line 636). Add them before the `POST /api/browser-widgets` route.

- [ ] **Step 1: Add the imageWidgets import to routes.ts**

At the top of `routes.ts`, find the EditorWidget import and add ImageWidget:

```typescript
import type { EditorWidget, ImageWidget } from '../../domain/types'
```

(Check if this import already exists; if so, just add `ImageWidget` to it.)

- [ ] **Step 2: Add image-size import**

Near the top of `routes.ts` (after other node imports), add:

```typescript
import { imageSize } from 'image-size'
import { createReadStream } from 'node:fs'
import { watch } from 'node:fs'
```

(Note: `watch` and `createReadStream` may already be imported. Check before adding duplicates.)

- [ ] **Step 3: Add POST /api/image-widgets route**

After the `DELETE /api/editor-widgets/:id` block, add:

```typescript
  // POST /api/image-widgets
  if (method === 'POST' && url === '/api/image-widgets') {
    readBody(req).then(body => {
      const { sessionId, filePath } = JSON.parse(body) as { sessionId?: string; filePath?: string }
      if (!sessionId || !filePath) {
        json(res, { ok: false, error: { code: 'INVALID_PARAMS', message: 'sessionId and filePath required' } }, 400)
        return
      }
      const run = ctx.docStore.getAllRuns().find(r => r.sessionId === sessionId)
      if (!run) {
        json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `No run with sessionId ${sessionId}` } }, 404)
        return
      }
      const task = ctx.docStore.getAllTasks().find(t => t.id === run.taskId)
      const epic = task ? ctx.docStore.getAllEpics().find(e => e.id === task.epicId) : undefined
      const initiative = epic ? ctx.docStore.getAllInitiatives().find(i => i.id === epic.initiativeId) : undefined
      const worktree = ctx.docStore.getAllWorktrees().find(w => w.id === run.worktreeId)

      const sessDir = ctx.sessionConfig?.dirs.sessions ?? ''
      const session = getSession(sessDir, sessionId)
      const workspacePath = session?.workspace?.path
      const absoluteFilePath = (() => {
        if (!filePath.startsWith('/')) return workspacePath ? resolve(workspacePath, filePath) : filePath
        if (existsSync(filePath)) return filePath
        return workspacePath ? resolve(workspacePath, filePath.replace(/^\/+/, '')) : filePath
      })()

      let naturalWidth = 640
      let naturalHeight = 480
      try {
        const dims = imageSize(absoluteFilePath)
        naturalWidth = dims.width ?? 640
        naturalHeight = dims.height ?? 480
      } catch {
        // unsupported format or corrupt — use fallback
      }

      const widget: ImageWidget = {
        id: shortId('image'),
        spaceId: ctx.docStore.activeSpaceId || undefined,
        sessionId,
        filePath: absoluteFilePath,
        task: task?.name ?? '',
        epic: epic?.name ?? '',
        initiative: initiative?.name ?? '',
        worktree: worktree?.name ?? '',
        repo: worktree?.repo ?? run.repo ?? '',
        color: run.color,
        naturalWidth,
        naturalHeight,
      }
      ctx.docStore.upsertImageWidget(widget.id, widget)
      json(res, { ok: true, data: widget })
    })
    return true
  }

  // DELETE /api/image-widgets/:id
  if (method === 'DELETE' && url.startsWith('/api/image-widgets/')) {
    const id = url.slice('/api/image-widgets/'.length)
    const existing = ctx.docStore.getAllImageWidgets().find(w => w.id === id)
    if (!existing) {
      json(res, { ok: false, error: { code: 'NOT_FOUND', message: `ImageWidget ${id} not found` } }, 404)
      return true
    }
    ctx.docStore.deleteImageWidget(id)
    json(res, { ok: true })
    return true
  }
```

- [ ] **Step 4: Add GET /api/image-file route**

After the DELETE route above, add:

```typescript
  // GET /api/image-file?session=SESSION_ID&path=FILE_PATH
  if (method === 'GET' && url.startsWith('/api/image-file')) {
    const qs = new URL(url, 'http://localhost').searchParams
    const sessionId = qs.get('session')
    const filePath = qs.get('path')

    if (!sessionId || !filePath) {
      json(res, { error: 'session and path required' }, 400)
      return true
    }

    let absolutePath: string
    if (filePath.startsWith('/') && existsSync(filePath)) {
      absolutePath = filePath
    } else {
      const sessDir = ctx.sessionConfig?.dirs.sessions
      if (!sessDir) { json(res, { error: 'session config unavailable' }, 503); return true }
      const session = getSession(sessDir, sessionId)
      if (!session) { json(res, { error: 'session not found' }, 404); return true }
      const workspacePath = session.workspace?.path ?? null
      if (!workspacePath) { json(res, { error: 'session workspace unavailable' }, 400); return true }
      absolutePath = filePath.startsWith('/')
        ? resolve(workspacePath, filePath.replace(/^\/+/, ''))
        : resolve(workspacePath, filePath)
    }

    if (!existsSync(absolutePath)) {
      json(res, { error: 'file not found' }, 404)
      return true
    }

    const ext = absolutePath.split('.').pop()?.toLowerCase() ?? ''
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      bmp: 'image/bmp', ico: 'image/x-icon',
    }
    const contentType = mimeMap[ext] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
    createReadStream(absolutePath).pipe(res)
    return true
  }
```

- [ ] **Step 5: Add GET /api/image-watch route**

After the image-file route, add:

```typescript
  // GET /api/image-watch?session=SESSION_ID&path=FILE_PATH
  if (method === 'GET' && url.startsWith('/api/image-watch')) {
    const qs = new URL(url, 'http://localhost').searchParams
    const sessionId = qs.get('session')
    const filePath = qs.get('path')

    if (!sessionId || !filePath) {
      json(res, { error: 'session and path required' }, 400)
      return true
    }

    let absolutePath: string
    if (filePath.startsWith('/') && existsSync(filePath)) {
      absolutePath = filePath
    } else {
      const sessDir = ctx.sessionConfig?.dirs.sessions
      if (!sessDir) { json(res, { error: 'session config unavailable' }, 503); return true }
      const session = getSession(sessDir, sessionId)
      if (!session) { json(res, { error: 'session not found' }, 404); return true }
      const workspacePath = session.workspace?.path ?? null
      if (!workspacePath) { json(res, { error: 'session workspace unavailable' }, 400); return true }
      absolutePath = filePath.startsWith('/')
        ? resolve(workspacePath, filePath.replace(/^\/+/, ''))
        : resolve(workspacePath, filePath)
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let watcher: ReturnType<typeof watch> | null = null
    const keepalive = setInterval(() => { res.write(': keep-alive\n\n') }, 15_000)

    const cleanup = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(keepalive)
      watcher?.close()
    }

    try {
      watcher = watch(absolutePath, () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          res.write(`data: ${JSON.stringify({ type: 'updated', timestamp: Date.now() })}\n\n`)
        }, 50)
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.write(`data: ${JSON.stringify({ type: 'error', data: msg })}\n\n`)
      cleanup()
      res.end()
      return true
    }

    req.on('close', () => { cleanup(); res.end() })
    return true
  }
```

- [ ] **Step 6: Type-check**

```bash
cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1 | grep routes
```

Expected: no errors from routes.ts.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/repo/tinstar && git add src/server/api/routes.ts
git commit -m "feat: add image-widgets, image-file, and image-watch API routes #V3-5-0"
```

---

### Task 5: Create useImageWatch hook

**Files:**
- Create: `src/hooks/useImageWatch.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useEffect, useState } from 'react'

interface ImageWatchState {
  connected: boolean
  lastUpdatedAt: Date | null
}

export function useImageWatch(sessionId: string, filePath: string): ImageWatchState {
  const [connected, setConnected] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)

  useEffect(() => {
    const url = `/api/image-watch?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`
    const es = new EventSource(url)

    es.onopen = () => {
      setConnected(true)
    }

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type: string; timestamp?: number }
        if (msg.type === 'updated' && msg.timestamp) {
          setLastUpdatedAt(new Date(msg.timestamp))
        }
      } catch {
        // ignore malformed
      }
    }

    es.onerror = () => {
      setConnected(false)
    }

    return () => {
      setConnected(false)
      es.close()
    }
  }, [sessionId, filePath])

  return { connected, lastUpdatedAt }
}
```

- [ ] **Step 2: Type-check**

```bash
cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1 | grep useImageWatch
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/repo/tinstar && git add src/hooks/useImageWatch.ts
git commit -m "feat: add useImageWatch SSE hook #V3-5-0"
```

---

### Task 6: Create ImageViewerWidget component

**Files:**
- Create: `src/widgets/imageViewer/ImageViewerWidget.tsx`

- [ ] **Step 1: Create the component**

```typescript
import { useCallback, useState, useEffect } from 'react'
import type { ImageWidget } from '../../domain/types'
import type { WidgetProps } from '../widgetComponentRegistry'
import { useImageWatch } from '../../hooks/useImageWatch'

export function ImageViewerWidget({ data }: WidgetProps) {
  const widget = data as ImageWidget
  const { connected, lastUpdatedAt } = useImageWatch(widget.sessionId, widget.filePath)

  const filename = widget.filePath.split('/').pop() ?? widget.filePath

  // Cache-bust src whenever file updates
  const imgSrc = lastUpdatedAt
    ? `/api/image-file?session=${encodeURIComponent(widget.sessionId)}&path=${encodeURIComponent(widget.filePath)}&t=${lastUpdatedAt.getTime()}`
    : `/api/image-file?session=${encodeURIComponent(widget.sessionId)}&path=${encodeURIComponent(widget.filePath)}`

  const handleOpenInEditor = useCallback(() => {
    fetch('/api/editor/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: widget.filePath, sessionId: widget.sessionId }),
    }).catch(() => {})
  }, [widget.filePath, widget.sessionId])

  const handleClose = useCallback(() => {
    fetch(`/api/image-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})
  }, [widget.id])

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!lastUpdatedAt) return
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [lastUpdatedAt])
  const secondsAgo = lastUpdatedAt ? Math.max(0, Math.floor((now - lastUpdatedAt.getTime()) / 1000)) : null

  const [imgError, setImgError] = useState(false)

  return (
    <div className="flex flex-col h-full bg-surface-base text-slate-300 overflow-hidden">
      {/* Header */}
      <div className="widget-drag-handle flex items-center gap-2 px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab">
        <span className="text-primary text-xs">⬡</span>
        <span className="text-2xs font-mono text-slate-400 truncate flex-1">
          {[widget.task, widget.worktree, filename].filter(Boolean).join(' · ')}
        </span>
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={handleOpenInEditor}
          className="text-2xs font-mono px-2 py-0.5 rounded border border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60 flex-shrink-0"
        >
          ↗ Open
        </button>
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={handleClose}
          className="text-slate-500 hover:text-slate-300 flex-shrink-0 ml-1"
          title="Close"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex items-center justify-center bg-surface-base">
        {imgError ? (
          <div className="text-slate-500 text-xs font-mono px-4 text-center">
            File not found or unsupported format
          </div>
        ) : (
          <img
            key={imgSrc}
            src={imgSrc}
            alt={filename}
            className="max-w-full max-h-full object-contain"
            onError={() => setImgError(true)}
            onLoad={() => setImgError(false)}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-1 bg-surface-panel border-t border-white/10 flex-shrink-0">
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: connected ? '#22c55e' : '#64748b' }}
        />
        <span className="text-2xs font-mono text-slate-500">
          {connected
            ? `watching · last updated ${secondsAgo === null ? '…' : secondsAgo + 's ago'}`
            : 'disconnected'}
        </span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1 | grep ImageViewerWidget
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/repo/tinstar && git add src/widgets/imageViewer/ImageViewerWidget.tsx
git commit -m "feat: add ImageViewerWidget component #V3-5-0"
```

---

### Task 7: Create imageViewer/index.ts and register widget

**Files:**
- Create: `src/widgets/imageViewer/index.ts`
- Modify: `src/widgets/index.ts`

- [ ] **Step 1: Create imageViewer/index.ts**

```typescript
import { registerWidgetComponent } from '../widgetComponentRegistry'
import { ImageViewerWidget } from './ImageViewerWidget'

registerWidgetComponent({
  type: 'image-viewer',
  component: ImageViewerWidget,
  isContainer: false,
  defaultSize: { width: 640, height: 480 },
  minSize: { width: 200, height: 150 },
  dragHandleSelector: '.widget-drag-handle',
  getFrameClass: ({ isSelected, isDragging }) => {
    if (isDragging) return 'widget-run-dragging'
    if (isSelected) return 'widget-run-selected'
    return ''
  },
})
```

- [ ] **Step 2: Add import to widgets/index.ts**

In `src/widgets/index.ts`, after `import './browserWidget'`, add:

```typescript
import './imageViewer'
```

- [ ] **Step 3: Type-check**

```bash
cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1 | grep -E "imageViewer|widgets/index"
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/repo/tinstar && git add src/widgets/imageViewer/index.ts src/widgets/index.ts
git commit -m "feat: register image-viewer widget type #V3-5-0"
```

---

### Task 8: Update WorkspaceShell

**Files:**
- Modify: `src/components/WorkspaceShell.tsx`

- [ ] **Step 1: Add ImageWidget import**

At the top of `WorkspaceShell.tsx`, find the domain types import and add `ImageWidget`:

```typescript
import type { EditorWidget, BrowserWidget, ImageWidget, ... } from '../domain/types'
```

- [ ] **Step 2: Destructure imageWidgets from useBackendState**

Find line ~63:
```typescript
const { runRepo, taxRepo, spaces, activeSpaceId, readyQueue, addOptimistic, editorWidgets, browserWidgets, connected } = useBackendState()
```
Add `imageWidgets` to the destructuring:
```typescript
const { runRepo, taxRepo, spaces, activeSpaceId, readyQueue, addOptimistic, editorWidgets, browserWidgets, imageWidgets, connected } = useBackendState()
```

- [ ] **Step 3: Add syntheticImageNodes memo**

After `syntheticBrowserNodes` (around line 112), add:

```typescript
  const syntheticImageNodes: TreeNode[] = useMemo(
    () =>
      imageWidgets.map(w => ({
        id: w.id,
        label: w.filePath.split('/').pop() ?? w.filePath,
        type: 'image-viewer' as const,
        entityId: w.id,
        children: [],
      })),
    [imageWidgets],
  )
```

- [ ] **Step 4: Add imageWidgetMap memo**

After `browserWidgetMap` (around line 119), add:

```typescript
  const imageWidgetMap = useMemo(() => {
    const map = new Map<string, ImageWidget>()
    for (const w of imageWidgets) map.set(w.id, w)
    return map
  }, [imageWidgets])
```

- [ ] **Step 5: Update canvasTree to include image nodes**

Find the `canvasTree` useMemo (around line 121). Change:

```typescript
    const allSynthetic = [...syntheticEditorNodes, ...syntheticBrowserNodes]
```
to:
```typescript
    const allSynthetic = [...syntheticEditorNodes, ...syntheticBrowserNodes, ...syntheticImageNodes]
```

Then add the image node injection loop after the browser node loop (around line 160). It follows the same pattern as editor and browser:

```typescript
    for (const node of syntheticImageNodes) {
      const widget = imageWidgets.find(w => w.id === node.entityId)
      const run = widget ? [...runMap.values()].find(r => r.sessionId === widget.sessionId) : undefined
      const taskNodeId = run?.taskId ? `task-${run.taskId}` : null
      if (taskNodeId) {
        const existing = byTaskNode.get(taskNodeId) ?? []
        byTaskNode.set(taskNodeId, [...existing, node])
      } else {
        orphans.push(node)
      }
    }
```

Also update the `useMemo` dependency array to include `syntheticImageNodes, imageWidgets`:

```typescript
  }, [sidebarTree, syntheticEditorNodes, syntheticBrowserNodes, syntheticImageNodes, editorWidgets, browserWidgets, imageWidgets, runMap])
```

- [ ] **Step 6: Update allNodeIds**

Find the `allNodeIds` useMemo (around line 169). After `for (const w of browserWidgets) ids.push(w.id)`, add:

```typescript
    for (const w of imageWidgets) ids.push(w.id)
```

Also add `imageWidgets` to the dependency array.

- [ ] **Step 7: Update handleDelete**

In `handleDelete` (around line 292), after the `file-editor` branch (or wherever editor/browser widget deletion is handled), add:

```typescript
    if (type === 'image-viewer') {
      fetch(`/api/image-widgets/${entityId}`, { method: 'DELETE' })
      return
    }
```

- [ ] **Step 8: Type-check (WorkspaceShell only, before InfiniteCanvas props)**

```bash
cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1 | grep WorkspaceShell
```

Expected: no errors from WorkspaceShell at this stage. The InfiniteCanvas props (`imageWidgetMap`, `onImageWidgetCreated`) will be wired in Task 9 after InfiniteCanvas is updated, to keep each commit type-clean.

- [ ] **Step 9: Commit (without InfiniteCanvas props yet)**

```bash
cd /home/ubuntu/repo/tinstar && git add src/components/WorkspaceShell.tsx
git commit -m "feat: wire imageWidgets into WorkspaceShell canvas tree #V3-5-0"
```

---

### Task 9: Update InfiniteCanvas

**Files:**
- Modify: `src/components/InfiniteCanvas.tsx`

- [ ] **Step 1: Add ImageWidget import**

Add `ImageWidget` to the import at the top of `InfiniteCanvas.tsx`:

```typescript
import type { BrowserWidget, EditorWidget, ImageWidget, Run, TreeNode, GroupingDimension } from '../domain/types'
```

- [ ] **Step 2: Add imageWidgetMap and onImageWidgetCreated to Props**

In the `Props` interface (around line 13), add after `browserWidgetMap`:

```typescript
  imageWidgetMap?: Map<string, ImageWidget>
  onImageWidgetCreated?: (widget: ImageWidget) => void
```

- [ ] **Step 3: Destructure new props in function signature**

On line ~148, update the function signature to destructure the new props:

```typescript
export function InfiniteCanvas({ tree, runMap, editorWidgetMap = new Map(), browserWidgetMap = new Map(), imageWidgetMap = new Map(), focusRunId, activeSpaceId, onFocusHandled, onSelectRun, onFocusRun, onDeleteEntity, onMenuOpen, onTaskUpdate, onEditorWidgetCreated, onBrowserWidgetCreated, onImageWidgetCreated, arrangeGridRef, arrangeResetRef, zoomToFitRunsRef, panToRunsRef }: Props) {
```

- [ ] **Step 4: Update renderNode data resolution**

Find the `data: unknown = ...` block inside `renderNode` (around line 646):

```typescript
    const data: unknown =
      node.type === 'run'
        ? runMap.get(node.entityId)
        : node.type === 'file-editor'
          ? editorWidgetMap.get(node.entityId)
          : node.type === 'browser-widget'
            ? browserWidgetMap.get(node.entityId)
            : ({
              node,
              depth: depthMapRef.current.get(node.id) ?? 0,
              onShrinkToFit: shrinkNode,
```

Add `image-viewer` branch:

```typescript
    const data: unknown =
      node.type === 'run'
        ? runMap.get(node.entityId)
        : node.type === 'file-editor'
          ? editorWidgetMap.get(node.entityId)
          : node.type === 'browser-widget'
            ? browserWidgetMap.get(node.entityId)
            : node.type === 'image-viewer'
              ? imageWidgetMap.get(node.entityId)
              : ({
                node,
                depth: depthMapRef.current.get(node.id) ?? 0,
                onShrinkToFit: shrinkNode,
```

- [ ] **Step 5: Update onDoubleClickZoom prop in renderNode**

Find line ~679:
```typescript
        onDoubleClickZoom={node.type === 'run' || node.type === 'file-editor' || node.type === 'browser-widget' ? handleDoubleClickZoom : undefined}
```
Add `'image-viewer'`:
```typescript
        onDoubleClickZoom={node.type === 'run' || node.type === 'file-editor' || node.type === 'browser-widget' || node.type === 'image-viewer' ? handleDoubleClickZoom : undefined}
```

- [ ] **Step 6: Update handleSelect**

Find the `handleSelect` callback (around line 568). After the `browser-` branch, add:

```typescript
    } else if (nodeId.startsWith('image-')) {
      additive ? toggleSelect(nodeId, 'image-viewer') : select(nodeId, 'image-viewer')
```

- [ ] **Step 7: Update handleDoubleClickZoom**

Find `handleDoubleClickZoom` (around line 585). Change:

```typescript
    } else if (nodeId.startsWith('editor-') || nodeId.startsWith('browser-')) {
```
to:
```typescript
    } else if (nodeId.startsWith('editor-') || nodeId.startsWith('browser-') || nodeId.startsWith('image-')) {
```

- [ ] **Step 8: Update handleDrop**

Find the `rawEditor` block in `handleDrop` (around line 601). Change it to branch on file extension:

```typescript
      const rawEditor = e.dataTransfer.getData('application/tinstar-editor')
      if (rawEditor) {
        const { sessionId, filePath } = JSON.parse(rawEditor) as { sessionId: string; filePath: string }
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']
        const isImage = imageExts.some(ext => filePath.toLowerCase().endsWith(ext))

        if (isImage) {
          const res = await fetch('/api/image-widgets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, filePath }),
          })
          const resJson = await res.json() as { ok: boolean; data?: ImageWidget }
          if (!resJson.ok || !resJson.data) return
          onImageWidgetCreated?.(resJson.data)
          const { naturalWidth, naturalHeight } = resJson.data
          const spawnLayout = {
            x: dropX, y: dropY,
            width: Math.min(naturalWidth, 1200),
            height: Math.min(naturalHeight, 900),
          }
          insertLayout(resJson.data.id, spawnLayout)
          return
        }

        const spawnLayout = { x: dropX, y: dropY, width: 640, height: 480 }
        const editorRes = await fetch('/api/editor-widgets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, filePath }),
        })
        const editorJson = await editorRes.json() as { ok: boolean; data?: EditorWidget }
        if (!editorJson.ok || !editorJson.data) return
        onEditorWidgetCreated?.(editorJson.data)
        insertLayout(editorJson.data.id, spawnLayout)
        return
      }
```

Also update the `useCallback` dependency array to include `onImageWidgetCreated`:
```typescript
    [camera, insertLayout, onEditorWidgetCreated, onBrowserWidgetCreated, onImageWidgetCreated],
```

- [ ] **Step 9: Update onHotgroupSelect selType chain**

Find the `onHotgroupSelect` callback (around line 516):

```typescript
      const selType = first.startsWith('run-') ? 'run'
        : first.startsWith('editor-') ? 'file-editor'
        : 'browser-widget'
```

Change to:

```typescript
      const selType = first.startsWith('run-') ? 'run'
        : first.startsWith('editor-') ? 'file-editor'
        : first.startsWith('image-') ? 'image-viewer'
        : 'browser-widget'
```

Also update the `selectMany` type assertion to include `'image-viewer'`:

```typescript
      selectMany(slotNodeIds, selType as import('../domain/types').GroupingDimension | 'run' | 'file-editor' | 'browser-widget' | 'image-viewer')
```

- [ ] **Step 10: Update onHotgroupAssign and onHotgroupRemove allowlists**

Find `onHotgroupAssign` (line ~538):
```typescript
      if (!selectedType || (selectedType !== 'run' && selectedType !== 'file-editor' && selectedType !== 'browser-widget')) return
```
Change to:
```typescript
      if (!selectedType || (selectedType !== 'run' && selectedType !== 'file-editor' && selectedType !== 'browser-widget' && selectedType !== 'image-viewer')) return
```

Find `onHotgroupRemove` (line ~545) — the same guard appears again:
```typescript
      if (!selectedType || (selectedType !== 'run' && selectedType !== 'file-editor' && selectedType !== 'browser-widget')) return
```
Change to:
```typescript
      if (!selectedType || (selectedType !== 'run' && selectedType !== 'file-editor' && selectedType !== 'browser-widget' && selectedType !== 'image-viewer')) return
```

- [ ] **Step 11: Wire imageWidgetMap and onImageWidgetCreated in WorkspaceShell**

Now that InfiniteCanvas accepts the new props, go back to `src/components/WorkspaceShell.tsx` and add the two new props to the `<InfiniteCanvas>` JSX (around line 659):

```tsx
                    imageWidgetMap={imageWidgetMap}
                    onImageWidgetCreated={(widget) => addOptimistic('imageWidget', widget)}
```

- [ ] **Step 12: Type-check — full clean pass**

```bash
cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1 | head -40
```

Expected: 0 errors total.

- [ ] **Step 13: Commit both files**

```bash
cd /home/ubuntu/repo/tinstar && git add src/components/InfiniteCanvas.tsx src/components/WorkspaceShell.tsx
git commit -m "feat: add image-viewer support to InfiniteCanvas #V3-5-0"
```

---

### Task 10: Smoke test

- [ ] **Step 1: Start dev server with mock data**

```bash
cd /home/ubuntu/repo/tinstar && TINSTAR_FAST_SIM=1 npm run dev
```

Expected: server starts without errors on port 5280.

- [ ] **Step 2: Verify type-check passes clean**

```bash
cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Verify image-file route responds**

With a real image path from a session workspace, test:
```
GET /api/image-file?session=<sessionId>&path=<imagePath>
```
Expected: returns image bytes with correct Content-Type.

- [ ] **Step 4: Verify drag-to-open**

In the running UI:
1. Open a session's file panel
2. Find an image file (`.png`, `.jpg`, etc.)
3. Drag it to the canvas
4. Expected: image viewer widget appears at drop location, sized to image natural dimensions (capped 1200×900)

- [ ] **Step 5: Verify live update**

1. Open an image viewer widget on the canvas
2. On the host machine, modify the image file
3. Expected: widget re-fetches and displays updated image within ~1 second

- [ ] **Step 6: Verify close button**

Click the `✕` button on the image viewer header.
Expected: widget disappears from canvas.

- [ ] **Step 7: Verify ↗ Open button**

Click `↗ Open` on the image viewer header.
Expected: file opens in configured external editor (or falls back to file-editor's command).

- [ ] **Step 8: Verify hotgroup assignment**

Select an image viewer widget, press a hotgroup number to assign. Switch to a different widget group and back.
Expected: image viewer is included in the hotgroup and reselected correctly.
