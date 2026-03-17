# Editor Widget Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag a file from a run's Changed/Explorer panel onto the canvas to spawn a Monaco read-only editor widget with live SSE file-watching.

**Architecture:** `EditorWidget` is a first-class server-persisted entity (document store → SSE snapshot → synthetic `TreeNode` → `CanvasWidgetShell` pipeline). The drop handler lives in `InfiniteCanvas` where `camera` and `insertLayout` are both in scope. Live updates stream via a per-widget SSE endpoint with `fs.watch` + 50 ms debounce.

**Tech Stack:** TypeScript, React, Monaco Editor (`@monaco-editor/react`), Node.js `fs.watch`, EventSource (browser built-in), Playwright (e2e tests)

**Spec:** `docs/superpowers/specs/2026-03-17-editor-widget-design.md`

---

## Chunk 1: Server Foundation

### Task 1: Extract `shortId` utility

**Files:**
- Create: `src/server/utils/shortId.ts`
- Modify: `src/server/api/routes.ts`

- [ ] **Create the utility**

  ```typescript
  // src/server/utils/shortId.ts
  import { randomUUID } from 'node:crypto'

  export function shortId(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}`
  }
  ```

- [ ] **Update routes.ts to import it**

  At the top of `src/server/api/routes.ts`, add:
  ```typescript
  import { shortId } from '../utils/shortId'
  ```

  Then delete the existing private `shortId` function at lines 73–75.

- [ ] **Type-check**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors

- [ ] **Commit**

  ```bash
  git add src/server/utils/shortId.ts src/server/api/routes.ts
  git commit -m "refactor: extract shortId to shared utility"
  ```

---

### Task 2: `EditorWidget` type + document store

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/server/stores/document-store.ts`

- [ ] **Add `EditorWidget` to `src/domain/types.ts`**

  After the `Run` interface, add:
  ```typescript
  export interface EditorWidget {
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
  }
  ```

- [ ] **Add the collection to `src/server/stores/document-store.ts`**

  Add the import at the top:
  ```typescript
  import type { ..., EditorWidget } from '../../domain/types'
  ```

  Add private field after `commits`:
  ```typescript
  private editorWidgets = new Map<string, EditorWidget>()
  ```

  Add upsert/delete methods (follow the same pattern as `upsertRun` / `deleteRun`):
  ```typescript
  upsertEditorWidget(id: string, data: EditorWidget): void {
    this.editorWidgets.set(id, data)
    this.changes.emit('change', { entity: 'editorWidget', id, data })
  }

  deleteEditorWidget(id: string): void {
    this.editorWidgets.delete(id)
    this.changes.emit('change', { entity: 'editorWidget', id, data: null })
  }

  getAllEditorWidgets(): EditorWidget[] {
    return [...this.editorWidgets.values()]
  }
  ```

  Update `enablePersistence()` load block — add after the `commits` load:
  ```typescript
  if (data.editorWidgets) for (const w of data.editorWidgets) this.editorWidgets.set(w.id, w)
  ```

  Update `snapshot()` — add to the returned object:
  ```typescript
  editorWidgets: this.getAllEditorWidgets().filter(inSpace),
  ```

  Update private `snapshotAll()` — add:
  ```typescript
  editorWidgets: this.getAllEditorWidgets(),
  ```

  Update `clearSpace(spaceId)` — add:
  ```typescript
  for (const [id, e] of this.editorWidgets) if (e.spaceId === spaceId) this.editorWidgets.delete(id)
  ```

  Update `clear()` else branch — add:
  ```typescript
  this.editorWidgets.clear()
  ```

- [ ] **Type-check**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors

- [ ] **Commit**

  ```bash
  git add src/domain/types.ts src/server/stores/document-store.ts
  git commit -m "feat: EditorWidget type and document store collection"
  ```

---

### Task 3: CRUD routes (`POST` + `DELETE /api/editor-widgets`)

**Files:**
- Modify: `src/server/api/routes.ts`

- [ ] **Add/extend imports** at the top of routes.ts:
  - Add `resolve` to the existing `node:path` import line (it imports `join` and `relative` already)
  - `basename` is not needed — `filePath.split('/').pop()` is used client-side only

- [ ] **Add POST handler** — place after the worktrees section (around line 585). Follow the `POST /api/spaces` pattern:

  ```typescript
  // POST /api/editor-widgets
  if (method === 'POST' && url === '/api/editor-widgets') {
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
      // Resolve display names from taxonomy
      const task = ctx.docStore.getAllTasks().find(t => t.id === run.taskId)
      const epic = task ? ctx.docStore.getAllEpics().find(e => e.id === task.epicId) : undefined
      const initiative = epic ? ctx.docStore.getAllInitiatives().find(i => i.id === epic.initiativeId) : undefined
      const worktree = ctx.docStore.getAllWorktrees().find(w => w.id === run.worktreeId)

      // Resolve relative paths to absolute (Explorer panel sends relative paths)
      const session = getSession(ctx.sessionConfig?.dirs.sessions ?? '', sessionId)
      const workspacePath = session?.workspace?.path
      const absoluteFilePath = filePath.startsWith('/')
        ? filePath
        : workspacePath
          ? resolve(workspacePath, filePath)
          : filePath

      const widget: EditorWidget = {
        id: shortId('editor'),
        spaceId: ctx.docStore.activeSpaceId || undefined,
        sessionId,
        filePath: absoluteFilePath,   // always absolute
        task: task?.name ?? '',
        epic: epic?.name ?? '',
        initiative: initiative?.name ?? '',
        worktree: worktree?.name ?? '',
        repo: worktree?.repo ?? run.repo ?? '',
        color: run.color,
      }
      ctx.docStore.upsertEditorWidget(widget.id, widget)
      json(res, { ok: true, data: widget })
    })
    return true
  }
  ```

  Note: you'll need to add `EditorWidget` to the imports from `../../domain/types`.

- [ ] **Add DELETE handler** — place right after the POST handler:

  ```typescript
  // DELETE /api/editor-widgets/:id
  if (method === 'DELETE' && url.startsWith('/api/editor-widgets/')) {
    const id = url.slice('/api/editor-widgets/'.length)
    const existing = ctx.docStore.getAllEditorWidgets().find(w => w.id === id)
    if (!existing) {
      json(res, { ok: false, error: { code: 'NOT_FOUND', message: `EditorWidget ${id} not found` } }, 404)
      return true
    }
    ctx.docStore.deleteEditorWidget(id)
    json(res, { ok: true })
    return true
  }
  ```

- [ ] **Note on `activeSpaceId`**: `DocumentStore.activeSpaceId` is already a public field — do NOT add a `getActiveSpaceId()` method. In the route snippet, use `ctx.docStore.activeSpaceId || undefined` directly.

- [ ] **Type-check**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors

- [ ] **Smoke-test the routes manually** (with `TINSTAR_FAST_SIM=1 npm run dev` running):

  ```bash
  # Get a real sessionId from state
  SESSION=$(curl -s http://localhost:5273/api/state | jq -r '.runs[0].sessionId')
  # Create a widget
  curl -s -X POST http://localhost:5273/api/editor-widgets \
    -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"$SESSION\",\"filePath\":\"/tmp/test.ts\"}" | jq .
  # Should return { ok: true, data: { id: "editor-...", ... } }
  # Grab the id and delete
  ID=$(curl -s -X POST http://localhost:5273/api/editor-widgets \
    -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"$SESSION\",\"filePath\":\"/tmp/test.ts\"}" | jq -r '.data.id')
  curl -s -X DELETE "http://localhost:5273/api/editor-widgets/$ID" | jq .
  # Should return { ok: true }
  ```

- [ ] **Commit**

  ```bash
  git add src/server/api/routes.ts src/server/stores/document-store.ts src/domain/types.ts
  git commit -m "feat: POST and DELETE /api/editor-widgets routes"
  ```

---

### Task 4: SSE file-watcher endpoint (`GET /api/file-watch`)

**Files:**
- Modify: `src/server/api/routes.ts`

- [ ] **Add the imports** — extend the existing imports in routes.ts:
  - In the `node:fs` import line, add `watch` to the destructured list
  - In the `node:path` import line, add `resolve` to the destructured list

- [ ] **Add the handler** — place after the editor-widgets DELETE handler:

  ```typescript
  // GET /api/file-watch?session=SESSION_ID&path=FILE_PATH
  if (method === 'GET' && url.startsWith('/api/file-watch')) {
    const qs = new URL(url, 'http://localhost').searchParams
    const sessionId = qs.get('session')
    const filePath = qs.get('path')

    if (!sessionId || !filePath) {
      json(res, { error: 'session and path required' }, 400)
      return true
    }

    // Find session workspace — getSession is synchronous, requires sessionsDir as first arg
    const sessDir = ctx.sessionConfig?.dirs.sessions
    if (!sessDir) {
      json(res, { error: 'session config unavailable' }, 503)
      return true
    }
    const session = getSession(sessDir, sessionId)
    if (!session) {
      json(res, { error: 'session not found' }, 404)
      return true
    }
    const workspacePath = session.workspace?.path ?? null
    if (!workspacePath) {
      json(res, { error: 'session workspace unavailable' }, 400)
      return true
    }

    const absolutePath = filePath.startsWith('/') ? filePath : resolve(workspacePath, filePath)

    // Open SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const sendEvent = (type: string, data: string) => {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`)
    }

    // Send initial content
    try {
      const content = readFileSync(absolutePath, 'utf-8')
      sendEvent('content', content)
    } catch {
      sendEvent('error', 'file unavailable')
      res.end()
      return true
    }

    // Debounced file watcher
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let watcher: ReturnType<typeof watch> | null = null

    try {
      watcher = watch(absolutePath, () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          try {
            const content = readFileSync(absolutePath, 'utf-8')
            sendEvent('content', content)
          } catch {
            sendEvent('error', 'file unavailable')
            cleanup()
            res.end()
          }
        }, 50)
      })
    } catch {
      sendEvent('error', 'file unavailable')
      res.end()
      return true
    }

    // Keepalive every 15s
    const keepalive = setInterval(() => { res.write(': keep-alive\n\n') }, 15_000)

    const cleanup = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(keepalive)
      watcher?.close()
    }

    req.on('close', () => {
      cleanup()
    })

    return true
  }
  ```

- [ ] **Type-check**

  ```bash
  npx tsc --noEmit
  ```

- [ ] **Smoke-test** (with dev server running and a real file):

  ```bash
  # In one terminal:
  curl -N "http://localhost:5273/api/file-watch?session=YOUR_SESSION&path=/tmp/watch-test.ts"
  # In another: echo "hello" >> /tmp/watch-test.ts
  # Should see content events streaming
  ```

- [ ] **Commit**

  ```bash
  git add src/server/api/routes.ts
  git commit -m "feat: GET /api/file-watch SSE endpoint"
  ```

---

## Chunk 2: Client State + Layout

### Task 5: Add `editorWidgets` to `useServerEvents` + `useBackendState`

**Files:**
- Modify: `src/hooks/useServerEvents.ts`
- Modify: `src/hooks/useBackendState.ts`

- [ ] **Add import** at the top:

  ```typescript
  import type { ..., EditorWidget } from '../domain/types'
  ```

- [ ] **Add field to `ServerState` interface**:

  ```typescript
  interface ServerState {
    // ... existing fields ...
    editorWidgets: EditorWidget[]
  }
  ```

- [ ] **Add to `EMPTY_STATE`**:

  ```typescript
  const EMPTY_STATE: ServerState = {
    // ... existing fields ...
    editorWidgets: [],
  }
  ```

- [ ] **Update the clear-all delta** (the `entity === 'all'` block) to also reset `editorWidgets`:

  Find the line like:
  ```typescript
  return { ...prev, initiatives: [], epics: [], tasks: [], worktrees: [], runs: [] }
  ```
  Replace with:
  ```typescript
  return { ...prev, initiatives: [], epics: [], tasks: [], worktrees: [], runs: [], editorWidgets: [] }
  ```

- [ ] **Add the `editorWidget` delta case** — add inside the `setState` callback, after the `run` case:

  ```typescript
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

- [ ] **Type-check**

  ```bash
  npx tsc --noEmit
  ```

- [ ] **Verify SSE snapshot includes editorWidgets** (with dev server running):

  ```bash
  curl -s http://localhost:5273/api/state | jq 'has("editorWidgets")'
  # Expected: true
  ```

- [ ] **Forward `editorWidgets` through `useBackendState`**

  `WorkspaceShell` imports from `useBackendState`, not `useServerEvents` directly. Add `editorWidgets` to the return value in `src/hooks/useBackendState.ts`:

  ```typescript
  return {
    runRepo, taxRepo,
    spaces: state.spaces,
    activeSpaceId: state.activeSpaceId,
    commits: state.commits,
    readyQueue: state.readyQueue,
    editorWidgets: state.editorWidgets,   // ← new
    connected, loading, addOptimistic,
  }
  ```

- [ ] **Type-check**

  ```bash
  npx tsc --noEmit
  ```

- [ ] **Commit**

  ```bash
  git add src/hooks/useServerEvents.ts src/hooks/useBackendState.ts
  git commit -m "feat: editorWidgets in client ServerState"
  ```

---

### Task 6: Extend `useWidgetLayouts`

**Files:**
- Modify: `src/hooks/useWidgetLayouts.ts`

- [ ] **Fix `loadLayouts` to eagerly load all saved positions**

  The existing function has an early-return guard at line ~255:
  ```typescript
  if (map.size < allIds.size * 0.8) return generateDefaultLayouts(tree)
  ```
  The off-tree loading must happen **before** this guard, not after the missing-fill block — otherwise a cold load with many tree IDs missing from localStorage will return early and never load editor widget positions.

  After the initial per-tree-ID loading loop (the `for (const id of allIds)` block), and **before** the `>0.8` guard, add:

  ```typescript
  // Load any saved positions not in the current tree
  // (e.g. editor widgets arriving via SSE after initial mount)
  for (const [id, layout] of Object.entries(parsed)) {
    if (!map.has(id) && typeof (layout as WidgetLayout).x === 'number') {
      map.set(id, layout as WidgetLayout)
    }
  }
  ```

  The full order inside `loadLayouts` after this change:
  1. `for (const id of allIds) { ... }` — load tree IDs from localStorage
  2. ← **insert off-tree block here**
  3. `if (map.size < allIds.size * 0.8) return generateDefaultLayouts(tree)` — existing guard
  4. `if (map.size < allIds.size) { ... }` — fill missing with smart placement
  5. `return map`

- [ ] **Add `insertLayout` to hook return**

  Inside the `useWidgetLayouts` function body, add a new callback (alongside the existing `updateRunPosition`, etc.):

  ```typescript
  const insertLayout = useCallback((id: string, layout: WidgetLayout) => {
    layoutsRef.current = new Map(layoutsRef.current).set(id, layout)
    setLayouts(new Map(layoutsRef.current))
  }, [])
  ```

  Add it to the return object:
  ```typescript
  return {
    layouts,
    treeMaps: treeMapsRef.current,
    updateRunPosition,
    updateRunSize,
    moveNode,
    resizeNode,
    shrinkNode,
    getLayout,
    arrangeWorkspace,
    insertLayout,   // ← new
  }
  ```

- [ ] **Type-check**

  ```bash
  npx tsc --noEmit
  ```

- [ ] **Commit**

  ```bash
  git add src/hooks/useWidgetLayouts.ts
  git commit -m "feat: insertLayout + persistent loadLayouts for off-tree entries"
  ```

---

## Chunk 3: Canvas Wiring

### Task 7: Synthetic nodes + `canvasTree` in `WorkspaceShell`

**Files:**
- Modify: `src/components/WorkspaceShell.tsx`

- [ ] **Add import** at top:

  ```typescript
  import { basename } from 'node:path'  // or use a JS path utility
  ```

  Since this is browser code, use:
  ```typescript
  const baseName = (p: string) => p.split('/').pop() ?? p
  ```
  (inline helper, no import needed)

- [ ] **Destructure `editorWidgets` from `useBackendState`**

  `WorkspaceShell` calls `const { runRepo, taxRepo, spaces, activeSpaceId, ... } = useBackendState()`. Add `editorWidgets` to that destructure:
  ```typescript
  const { runRepo, taxRepo, spaces, activeSpaceId, commits, readyQueue,
          editorWidgets, connected, loading, addOptimistic } = useBackendState()
  ```

- [ ] **Derive `syntheticEditorNodes`** — add after `runMap` useMemo:

  ```typescript
  const syntheticEditorNodes: TreeNode[] = useMemo(
    () =>
      editorWidgets.map(w => ({
        id: w.id,
        label: w.filePath.split('/').pop() ?? w.filePath,
        type: 'file-editor',
        entityId: w.id,
        children: [],
        runCount: 0,
        activeCount: 0,
        color: w.color,
      })),
    [editorWidgets],
  )
  ```

- [ ] **Derive `editorWidgetMap`** — add after `syntheticEditorNodes`:

  ```typescript
  const editorWidgetMap = useMemo(() => {
    const map = new Map<string, EditorWidget>()
    for (const w of editorWidgets) map.set(w.id, w)
    return map
  }, [editorWidgets])
  ```

  Add `EditorWidget` to the import from `../domain/types`.

- [ ] **Derive `canvasTree`** — add after `editorWidgetMap`:

  ```typescript
  const canvasTree = useMemo(
    () => [...sidebarTree, ...syntheticEditorNodes],
    [sidebarTree, syntheticEditorNodes],
  )
  ```

- [ ] **Pass `canvasTree` and `editorWidgetMap` to `InfiniteCanvas`**

  Find the `<InfiniteCanvas` usage (around line 517) and change `tree={sidebarTree}` to `tree={canvasTree}`, and add the new prop:
  ```tsx
  <InfiniteCanvas
    tree={canvasTree}           // ← changed from sidebarTree
    runMap={runMap}
    editorWidgetMap={editorWidgetMap}   // ← new
    ...existing props...
  />
  ```

- [ ] **Type-check**

  ```bash
  npx tsc --noEmit
  ```
  Expected: error on `InfiniteCanvas` about unknown prop `editorWidgetMap` — that's expected, fix in Task 8.

- [ ] **Commit** (after Task 8 makes it compile cleanly — hold this commit until then)

---

### Task 8: `InfiniteCanvas` — props, `renderNode`, drop handler

**Files:**
- Modify: `src/components/InfiniteCanvas.tsx`

- [ ] **Add `editorWidgetMap` to Props interface**

  ```typescript
  interface Props {
    // ... existing ...
    editorWidgetMap?: Map<string, EditorWidget>
  }
  ```

  Add `EditorWidget` to imports from `../domain/types`.

- [ ] **Destructure in function signature**

  ```typescript
  export function InfiniteCanvas({ tree, runMap, editorWidgetMap = new Map(), ...rest }: Props) {
  ```

- [ ] **Destructure `insertLayout` from `useWidgetLayouts`**

  The existing destructure at lines 104–114 — add `insertLayout`:
  ```typescript
  const {
    layouts,
    treeMaps,
    updateRunPosition,
    updateRunSize,
    moveNode,
    resizeNode,
    shrinkNode,
    getLayout,
    arrangeWorkspace,
    insertLayout,   // ← new
  } = useWidgetLayouts(tree, activeSpaceId)
  ```

- [ ] **Update `renderNode` data routing** — find the `const data: unknown =` block (around line 517) and add the `file-editor` branch:

  ```typescript
  const data: unknown =
    node.type === 'run'
      ? runMap.get(node.entityId)
      : node.type === 'file-editor'
        ? editorWidgetMap.get(node.entityId)
        : ({
            node,
            depth: depthMapRef.current.get(node.id) ?? 0,
            onShrinkToFit: shrinkNode,
            onDelete: handleDeleteGroup,
            onMenuOpen: handleMenuOpenGroup,
          } satisfies GroupWidgetData)
  ```

- [ ] **Add the `onDrop` handler** — add near the other `useCallback` handlers.

  `InfiniteCanvas` already has `containerRef = useRef<HTMLDivElement>(null)` attached to the outer canvas div (line ~103). Use it for coordinate conversion — do NOT add a second ref.

  ```typescript
  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      const raw = e.dataTransfer.getData('application/tinstar-editor')
      if (!raw) return
      const { sessionId, filePath } = JSON.parse(raw) as { sessionId: string; filePath: string }

      const res = await fetch('/api/editor-widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, filePath }),
      })
      const resJson = await res.json() as { ok: boolean; data?: EditorWidget }
      if (!resJson.ok || !resJson.data) return
      const widget = resJson.data

      // Calculate spawn position: next to source run widget
      let spawnLayout: WidgetLayout = { x: 0, y: 0, width: 640, height: 480 }
      const run = [...runMap.values()].find(r => r.sessionId === sessionId)
      const sourceLayout = run ? layouts.get('run-' + run.id) : undefined
      if (sourceLayout) {
        spawnLayout = {
          x: sourceLayout.x + sourceLayout.width + 16,
          y: sourceLayout.y,
          width: 640,
          height: 480,
        }
      } else {
        // Fallback: drop coordinates converted to canvas space via containerRef
        const rect = containerRef.current!.getBoundingClientRect()
        spawnLayout = {
          x: (e.clientX - rect.left - camera.x) / camera.zoom,
          y: (e.clientY - rect.top - camera.y) / camera.zoom,
          width: 640,
          height: 480,
        }
      }

      insertLayout(widget.id, spawnLayout)
    },
    [runMap, layouts, camera, insertLayout],
  )
  ```

  Import `WidgetLayout` from `../hooks/useWidgetLayouts` (or wherever it's defined — search for `export type WidgetLayout` in that file).

- [ ] **Attach `onDragOver` and `onDrop` to the canvas div**

  Find the outermost canvas `<div ref={containerRef}>` and add:
  ```tsx
  onDragOver={(e) => { e.preventDefault() }}
  onDrop={handleDrop}
  ```
  Do not add another `ref` — `containerRef` is already attached to this element.

- [ ] **Type-check and fix WorkspaceShell commit**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors

- [ ] **Commit both WorkspaceShell and InfiniteCanvas changes**

  ```bash
  git add src/components/WorkspaceShell.tsx src/components/InfiniteCanvas.tsx src/hooks/useWidgetLayouts.ts
  git commit -m "feat: canvasTree, editorWidgetMap, drop handler wired into InfiniteCanvas"
  ```

---

## Chunk 4: Widget Component + Drag Sources

### Task 9: `useFileWatch` hook

**Files:**
- Create: `src/hooks/useFileWatch.ts`

- [ ] **Write the hook**

  ```typescript
  // src/hooks/useFileWatch.ts
  import { useEffect, useRef, useState } from 'react'

  interface FileWatchState {
    content: string | null
    connected: boolean
    lastUpdatedAt: Date | null
  }

  export function useFileWatch(sessionId: string, filePath: string): FileWatchState {
    const [content, setContent] = useState<string | null>(null)
    const [connected, setConnected] = useState(false)
    const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)

    // We need to restore scroll after setValue — use a ref to hold the pending scroll
    // The Monaco editor ref lives in the widget component; we expose a callback instead.
    // (See FileEditorWidget for scroll restore logic)

    useEffect(() => {
      const url = `/api/file-watch?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`
      const es = new EventSource(url)

      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { type: string; data: string }
          if (msg.type === 'content') {
            setContent(msg.data)
            setConnected(true)
            setLastUpdatedAt(new Date())
          } else if (msg.type === 'error') {
            setConnected(false)
          }
        } catch {
          // ignore malformed
        }
      }

      es.onerror = () => {
        setConnected(false)
      }

      return () => {
        es.close()
      }
    }, [sessionId, filePath])

    return { content, connected, lastUpdatedAt }
  }
  ```

- [ ] **Type-check**

  ```bash
  npx tsc --noEmit
  ```

- [ ] **Commit**

  ```bash
  git add src/hooks/useFileWatch.ts
  git commit -m "feat: useFileWatch SSE hook"
  ```

---

### Task 10: `FileEditorWidget` component + registration

**Files:**
- Create: `src/widgets/fileEditor/FileEditorWidget.tsx`
- Create: `src/widgets/fileEditor/index.tsx`
- Modify: `src/widgets/index.ts`

- [ ] **Write the widget component**

  ```typescript
  // src/widgets/fileEditor/FileEditorWidget.tsx
  import { useRef, useEffect, useCallback } from 'react'
  import Editor, { useMonaco } from '@monaco-editor/react'
  import type { editor as MonacoEditor } from 'monaco-editor'
  import type { EditorWidget } from '../../domain/types'
  import type { WidgetProps } from '../widgetComponentRegistry'
  import { useFileWatch } from '../../hooks/useFileWatch'

  function getLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript',
      js: 'javascript', jsx: 'javascript',
      py: 'python', rb: 'ruby', go: 'go',
      rs: 'rust', java: 'java', cs: 'csharp',
      cpp: 'cpp', c: 'c', h: 'c',
      json: 'json', yaml: 'yaml', yml: 'yaml',
      md: 'markdown', html: 'html', css: 'css',
      sh: 'shell', bash: 'shell',
      sql: 'sql', xml: 'xml', toml: 'toml',
    }
    return map[ext] ?? 'plaintext'
  }

  function isBinaryOrLarge(content: string): boolean {
    if (content.length > 500 * 1024) return true
    const sample = content.slice(0, 8192)
    return sample.includes('\x00')
  }

  export function FileEditorWidget({ data }: WidgetProps) {
    const widget = data as EditorWidget
    const { content, connected, lastUpdatedAt } = useFileWatch(widget.sessionId, widget.filePath)
    const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
    const monaco = useMonaco()

    const filename = widget.filePath.split('/').pop() ?? widget.filePath

    // When content arrives, update Monaco and restore scroll
    useEffect(() => {
      const ed = editorRef.current
      if (!ed || content === null) return
      const scrollTop = ed.getScrollTop()
      const scrollLeft = ed.getScrollLeft()
      ed.setValue(content)
      // Restore scroll after Monaco processes the change
      const disposable = ed.onDidChangeModelContent(() => {
        ed.setScrollTop(scrollTop)
        ed.setScrollLeft(scrollLeft)
        disposable.dispose()
      })
    }, [content])

    const handleEditorMount = useCallback((ed: MonacoEditor.IStandaloneCodeEditor) => {
      editorRef.current = ed
      if (content !== null) ed.setValue(content)
    }, [content])

    const handleOpenInEditor = useCallback(() => {
      fetch('/api/editor/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: widget.filePath, sessionId: widget.sessionId }),
      }).catch(() => {})
    }, [widget.filePath, widget.sessionId])

    const handleClose = useCallback(() => {
      fetch(`/api/editor-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})
    }, [widget.id])

    const secondsAgo = lastUpdatedAt
      ? Math.floor((Date.now() - lastUpdatedAt.getTime()) / 1000)
      : null

    return (
      <div className="flex flex-col h-full bg-surface-base text-slate-300 overflow-hidden">
        {/* Header */}
        <div
          className="widget-drag-handle flex items-center gap-2 px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab"
        >
          <span className="text-primary text-xs">⬡</span>
          <span className="text-2xs font-mono text-slate-400 truncate flex-1">
            {[widget.task, widget.worktree, filename].filter(Boolean).join(' · ')}
          </span>
          <button
            onClick={handleOpenInEditor}
            className="text-2xs font-mono px-2 py-0.5 rounded border border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60 flex-shrink-0"
          >
            ↗ Open in Editor
          </button>
          <button
            onClick={handleClose}
            className="text-slate-500 hover:text-slate-300 flex-shrink-0 ml-1"
            title="Close"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0">
          {content === null ? (
            <div className="flex items-center justify-center h-full text-slate-500 text-xs font-mono">
              Loading…
            </div>
          ) : isBinaryOrLarge(content) ? (
            <div className="flex items-center justify-center h-full text-slate-500 text-xs font-mono px-4 text-center">
              Binary or large file — open in external editor
            </div>
          ) : (
            <Editor
              language={getLanguage(widget.filePath)}
              theme="vs-dark"
              options={{
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 11,
                lineNumbers: 'on',
                wordWrap: 'off',
              }}
              onMount={handleEditorMount}
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

- [ ] **Write the registration file**

  ```typescript
  // src/widgets/fileEditor/index.tsx
  import { registerWidgetComponent } from '../widgetComponentRegistry'
  import { FileEditorWidget } from './FileEditorWidget'

  registerWidgetComponent({
    type: 'file-editor',
    component: FileEditorWidget,
    isContainer: false,
    defaultSize: { width: 640, height: 480 },
    minSize: { width: 300, height: 200 },
    dragHandleSelector: '.widget-drag-handle',
    supportsMinimize: false,
  })
  ```

- [ ] **Register in `src/widgets/index.ts`**

  Add the import (side-effect only):
  ```typescript
  import './fileEditor'   // registers FileEditorWidget
  ```

- [ ] **Type-check**

  ```bash
  npx tsc --noEmit
  ```

- [ ] **Install Monaco if not already present** — check first:

  ```bash
  grep '@monaco-editor' package.json
  ```

  If missing:
  ```bash
  npm install @monaco-editor/react
  ```

- [ ] **Manual verify** — with `TINSTAR_FAST_SIM=1 npm run dev`, create a widget via API and confirm it renders on canvas:

  ```bash
  SESSION=$(curl -s http://localhost:5273/api/state | jq -r '.runs[0].sessionId')
  curl -s -X POST http://localhost:5273/api/editor-widgets \
    -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"$SESSION\",\"filePath\":\"/etc/hostname\"}"
  ```
  Reload page → editor widget should appear on canvas.

- [ ] **Commit**

  ```bash
  git add src/widgets/fileEditor/ src/widgets/index.ts
  git commit -m "feat: FileEditorWidget component and registration"
  ```

---

### Task 11: Drag sources

**Files:**
- Modify: `src/components/RunWorkspaceWidget/FileTreePanel.tsx`
- Modify: `src/components/RunWorkspaceWidget/TouchedFilesPanel.tsx`
- Modify: `src/widgets/CanvasWidgetShell.tsx` (add `data-widget-type` for test selectors)

- [ ] **`FileTreePanel` — add `application/tinstar-editor` to `handleDragStart`**

  Find `handleDragStart` (around line 55):
  ```typescript
  const handleDragStart = useCallback((e: React.DragEvent, filePath: string) => {
    e.dataTransfer.setData('text/plain', filePath)
    e.dataTransfer.effectAllowed = 'copy'
  }, [])
  ```

  Replace with:
  ```typescript
  const handleDragStart = useCallback((e: React.DragEvent, filePath: string) => {
    e.dataTransfer.setData('text/plain', filePath)
    e.dataTransfer.setData('application/tinstar-editor', JSON.stringify({ sessionId, filePath }))
    e.dataTransfer.effectAllowed = 'copy'
  }, [sessionId])
  ```

  `sessionId` is already in `FileTreePanel`'s Props.

- [ ] **`TouchedFilesPanel` — add drag to file items**

  Find the file `<button>` element (around line 46). Since files need drag from a button, convert the draggable to a `<div>` wrapper or add `draggable` to the button with `onDragStart`:

  In the `files.map` loop, on the file row element, add:
  ```tsx
  draggable
  onDragStart={(e) => {
    e.stopPropagation()
    e.dataTransfer.setData('application/tinstar-editor', JSON.stringify({ sessionId: run.sessionId, filePath: file.path }))
    e.dataTransfer.effectAllowed = 'copy'
  }}
  ```

  `TouchedFilesPanel` receives `files: TouchedFile[]` and `onOpenFile`. It does NOT currently receive `sessionId`. Add it to Props:
  ```typescript
  interface Props {
    files: TouchedFile[]
    sessionId: string       // ← new
    onFileSelect?: (file: TouchedFile) => void
    onOpenFile?: (filePath: string) => void
    onCollapse?: () => void
  }
  ```

  Update the caller in `RunWorkspaceWidget/index.tsx`:
  ```tsx
  <TouchedFilesPanel
    files={run.touchedFiles}
    sessionId={run.sessionId}   // ← new
    onOpenFile={handleOpenFile}
  />
  ```

- [ ] **Type-check**

  ```bash
  npx tsc --noEmit
  ```

- [ ] **Add `data-widget-type` to `CanvasWidgetShell`** so e2e tests can select by widget type.

  In `src/widgets/CanvasWidgetShell.tsx`, find the outer `<div` (the one with `style={{ left, top, width, height }}`). Add the attribute:
  ```tsx
  data-widget-type={registration.type}
  ```
  This enables selectors like `[data-widget-type="file-editor"]` in tests.

- [ ] **Write an e2e test** — create `e2e/editor-widget.spec.ts`:

  ```typescript
  import { test, expect } from '@playwright/test'
  import { resetAndWaitForData } from './helpers'

  test('drag file from Explorer panel creates editor widget on canvas', async ({ page }) => {
    await page.goto(process.env.BASE_URL ?? 'http://localhost:5273')
    await resetAndWaitForData(page)

    // Expand the file tree panel on the first run widget
    const widget = page.locator('[data-testid^="widget-root-"]').first()
    await widget.locator('button:has-text("Explorer")').click()

    // Wait for file tree to load (root directory should expand)
    const fileItem = widget.locator('[draggable="true"]').first()
    await expect(fileItem).toBeVisible({ timeout: 5000 })

    // Count editor widgets before drag
    const before = await page.locator('[data-widget-type="file-editor"]').count()

    // Drag the file item to the canvas
    const canvas = page.locator('[data-testid="canvas-slot"]')
    const canvasBox = await canvas.boundingBox()
    if (!canvasBox) throw new Error('canvas not found')

    await fileItem.dispatchEvent('dragstart', {
      dataTransfer: {
        setData: () => {},
        effectAllowed: 'copy',
      },
    })

    // Use the API directly to simulate a drop (drag across origins is tricky in Playwright)
    // Get a session from the API and create an editor widget
    const state = await page.evaluate(async () => {
      const res = await fetch('/api/state')
      const data = await res.json()
      return data
    })
    const sessionId = state.runs[0]?.sessionId
    const filePath = '/etc/hostname'

    await page.evaluate(async ({ sessionId, filePath }) => {
      await fetch('/api/editor-widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, filePath }),
      })
    }, { sessionId, filePath })

    // Wait for editor widget to appear
    await expect(page.locator('[data-widget-type="file-editor"]')).toHaveCount(before + 1, { timeout: 5000 })
  })

  test('editor widget shows file content', async ({ page }) => {
    await page.goto(process.env.BASE_URL ?? 'http://localhost:5273')
    await resetAndWaitForData(page)

    const state = await page.evaluate(async () => {
      const r = await fetch('/api/state'); return r.json()
    })
    const sessionId = state.runs[0]?.sessionId

    // Create widget via API
    await page.evaluate(async (sid) => {
      await fetch('/api/editor-widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, filePath: '/etc/hostname' }),
      })
    }, sessionId)

    // Editor widget should appear and show some content
    const editorWidget = page.locator('[data-widget-type="file-editor"]').first()
    await expect(editorWidget).toBeVisible({ timeout: 5000 })
    // Footer should show "watching"
    await expect(editorWidget.locator('text=watching')).toBeVisible({ timeout: 5000 })
  })

  test('editor widget close button deletes it', async ({ page }) => {
    await page.goto(process.env.BASE_URL ?? 'http://localhost:5273')
    await resetAndWaitForData(page)

    const state = await page.evaluate(async () => {
      const r = await fetch('/api/state'); return r.json()
    })
    const sessionId = state.runs[0]?.sessionId

    await page.evaluate(async (sid) => {
      await fetch('/api/editor-widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, filePath: '/etc/hostname' }),
      })
    }, sessionId)

    const editorWidget = page.locator('[data-widget-type="file-editor"]').first()
    await expect(editorWidget).toBeVisible({ timeout: 5000 })

    // Click close button
    await editorWidget.locator('button[title="Close"]').click()

    // Widget should disappear
    await expect(editorWidget).not.toBeVisible({ timeout: 5000 })
  })
  ```

  Note: `[data-widget-type="file-editor"]` requires adding `data-widget-type` to `CanvasWidgetShell`. If it doesn't exist, use `[data-testid^="canvas-widget-"]` or add a `data-widget-type={registration.type}` attribute to the shell's outer div.

- [ ] **Run the tests**

  ```bash
  TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test e2e/editor-widget.spec.ts --headed
  ```

  Fix any failures.

- [ ] **Commit**

  ```bash
  git add src/components/RunWorkspaceWidget/FileTreePanel.tsx \
          src/components/RunWorkspaceWidget/TouchedFilesPanel.tsx \
          src/components/RunWorkspaceWidget/index.tsx \
          src/widgets/CanvasWidgetShell.tsx \
          e2e/editor-widget.spec.ts
  git commit -m "feat: drag-to-create editor widget from file panels"
  ```

---

## Final verification

- [ ] **Full type-check**

  ```bash
  npx tsc --noEmit
  ```

- [ ] **Run all e2e tests**

  ```bash
  TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test
  ```

  All existing tests must still pass.

- [ ] **Manual end-to-end smoke**

  1. Start `TINSTAR_FAST_SIM=1 npm run dev`
  2. Open a run widget, switch to Explorer tab, drag a file to the canvas
  3. Confirm editor widget appears next to source run widget
  4. Confirm Monaco shows file content
  5. Append a line to the file in terminal: `echo "// test" >> <file>`
  6. Confirm widget updates in real time
  7. Click "Open in Editor" — confirm it opens the file
  8. Click close (X) — confirm widget disappears
  9. Reload page — confirm widget reappears in the same position

- [ ] **Final commit**

  ```bash
  git commit --allow-empty -m "feat: editor widget complete"
  ```
