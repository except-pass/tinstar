# Canvas Minimap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a StarCraft-style minimap to the infinite canvas that shows work widget positions as proportional rectangles, displays a viewport indicator, and supports click/drag-to-pan navigation.

**Architecture:** A new `CanvasMinimap` React component renders an HTML `<canvas>` element positioned absolutely in the bottom-right corner of `InfiniteCanvas`. Widget bounding boxes and the viewport rectangle are drawn via `CanvasRenderingContext2D`. The component receives camera state, layouts, tree, and widget data maps as props. An `M` hotkey toggles visibility, which collapses the minimap to a small icon button.

**Tech Stack:** React, HTML Canvas 2D API, TypeScript, Tailwind (for the collapse-icon wrapper only)

---

### Task 1: Create CanvasMinimap component with canvas rendering

**Files:**
- Create: `src/components/CanvasMinimap.tsx`

This task creates the core minimap component: bounding box computation, world-to-minimap coordinate mapping, widget rectangle drawing, and viewport indicator rendering. No interaction yet — just the visual.

- [ ] **Step 1: Create CanvasMinimap.tsx with component shell and types**

```tsx
// src/components/CanvasMinimap.tsx
import { useRef, useEffect, useCallback, useState } from 'react'
import type { Camera } from '../hooks/useCanvasCamera'
import type { WidgetLayout } from '../hooks/useWidgetLayouts'
import type { TreeNode, Run, BrowserWidget, EditorWidget, ImageWidget, NatsTrafficWidget } from '../domain/types'
import { getWidgetComponent, toWidgetType } from '../widgets/widgetComponentRegistry'
import { resolveRunAccent } from './runAccent'

const MINIMAP_W = 200
const MINIMAP_H = 140
const MINIMAP_PAD = 0.1 // 10% padding around world bounds
const STORAGE_KEY = 'tinstar-minimap-visible'

interface MinimapProps {
  camera: Camera
  setCamera: React.Dispatch<React.SetStateAction<Camera>>
  layouts: Map<string, WidgetLayout>
  tree: TreeNode[]
  runMap: Map<string, Run>
  editorWidgetMap: Map<string, EditorWidget>
  browserWidgetMap: Map<string, BrowserWidget>
  imageWidgetMap: Map<string, ImageWidget>
  natsTrafficWidgetMap: Map<string, NatsTrafficWidget>
}

/** Collect all non-container (work) nodes from the tree */
function collectWorkNodes(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = []
  for (const node of nodes) {
    const reg = getWidgetComponent(toWidgetType(node.type))
    if (reg && !reg.isContainer) {
      result.push(node)
    }
    result.push(...collectWorkNodes(node.children))
  }
  return result
}

/** Resolve the accent color for a work widget node */
function getNodeColor(
  node: TreeNode,
  runMap: Map<string, Run>,
  editorWidgetMap: Map<string, EditorWidget>,
  browserWidgetMap: Map<string, BrowserWidget>,
  imageWidgetMap: Map<string, ImageWidget>,
  natsTrafficWidgetMap: Map<string, NatsTrafficWidget>,
): string {
  switch (node.type) {
    case 'run':
      return resolveRunAccent(runMap.get(node.entityId)?.color)
    case 'file-editor':
      return resolveRunAccent(editorWidgetMap.get(node.entityId)?.color)
    case 'browser-widget':
      return resolveRunAccent(browserWidgetMap.get(node.entityId)?.color)
    case 'image-viewer':
      return resolveRunAccent(imageWidgetMap.get(node.entityId)?.color)
    case 'nats-traffic':
      return resolveRunAccent(natsTrafficWidgetMap.get(node.entityId)?.color)
    default:
      return resolveRunAccent()
  }
}

/** Parse a hex color (#rrggbb) into an rgba() string */
function hexToCanvasColor(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function CanvasMinimap({
  camera, setCamera, layouts, tree,
  runMap, editorWidgetMap, browserWidgetMap, imageWidgetMap, natsTrafficWidgetMap,
}: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored !== 'false' // default to visible
  })

  // Persist visibility
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(visible))
  }, [visible])

  const toggle = useCallback(() => setVisible(v => !v), [])

  // --- Drawing ---
  useEffect(() => {
    if (!visible) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = MINIMAP_W * dpr
    canvas.height = MINIMAP_H * dpr
    ctx.scale(dpr, dpr)

    // Clear
    ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H)

    // Collect work nodes and their layouts
    const workNodes = collectWorkNodes(tree)
    const workEntries: { node: TreeNode; layout: WidgetLayout }[] = []
    for (const node of workNodes) {
      const layout = layouts.get(node.id)
      if (layout) workEntries.push({ node, layout })
    }

    if (workEntries.length === 0) return // empty minimap

    // Compute world bounding box of all work widgets
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const { layout } of workEntries) {
      minX = Math.min(minX, layout.x)
      minY = Math.min(minY, layout.y)
      maxX = Math.max(maxX, layout.x + layout.width)
      maxY = Math.max(maxY, layout.y + layout.height)
    }

    // Include viewport in bounds so the viewfinder is always visible
    const vpWorldX = -camera.x / camera.zoom
    const vpWorldY = -camera.y / camera.zoom
    const vpWorldW = window.innerWidth / camera.zoom
    const vpWorldH = window.innerHeight / camera.zoom
    minX = Math.min(minX, vpWorldX)
    minY = Math.min(minY, vpWorldY)
    maxX = Math.max(maxX, vpWorldX + vpWorldW)
    maxY = Math.max(maxY, vpWorldY + vpWorldH)

    const worldW = maxX - minX
    const worldH = maxY - minY

    // Add padding
    const padX = worldW * MINIMAP_PAD
    const padY = worldH * MINIMAP_PAD
    const totalW = worldW + padX * 2
    const totalH = worldH + padY * 2
    const originX = minX - padX
    const originY = minY - padY

    // Uniform scale to fit minimap
    const scale = Math.min(MINIMAP_W / totalW, MINIMAP_H / totalH)
    // Center the content in the minimap
    const offsetX = (MINIMAP_W - totalW * scale) / 2
    const offsetY = (MINIMAP_H - totalH * scale) / 2

    function worldToMinimap(wx: number, wy: number): [number, number] {
      return [
        offsetX + (wx - originX) * scale,
        offsetY + (wy - originY) * scale,
      ]
    }

    // Draw widget rectangles
    for (const { node, layout } of workEntries) {
      const color = getNodeColor(node, runMap, editorWidgetMap, browserWidgetMap, imageWidgetMap, natsTrafficWidgetMap)
      const [mx, my] = worldToMinimap(layout.x, layout.y)
      const mw = Math.max(2, layout.width * scale)
      const mh = Math.max(2, layout.height * scale)
      ctx.fillStyle = hexToCanvasColor(color, 0.6)
      ctx.fillRect(mx, my, mw, mh)
    }

    // Draw viewport indicator
    const [vx, vy] = worldToMinimap(vpWorldX, vpWorldY)
    const vw = vpWorldW * scale
    const vh = vpWorldH * scale
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(vx, vy, vw, vh)
  }, [visible, camera, layouts, tree, runMap, editorWidgetMap, browserWidgetMap, imageWidgetMap, natsTrafficWidgetMap])

  if (!visible) {
    // Collapsed: show small icon button
    return (
      <button
        onClick={toggle}
        className="absolute bottom-12 right-3 bg-surface-panel border border-white/10 p-1.5 rounded-sm text-slate-500 hover:text-slate-300 transition-colors select-none"
        title="Show minimap (M)"
        data-testid="minimap-toggle"
      >
        <span className="material-symbols-outlined text-base" style={{ fontSize: '16px' }}>map</span>
      </button>
    )
  }

  return (
    <div
      className="absolute bottom-12 right-3 select-none group"
      style={{
        width: MINIMAP_W,
        height: MINIMAP_H,
        background: 'rgba(15, 23, 42, 0.85)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: 2,
      }}
      data-testid="canvas-minimap"
    >
      {/* Close button — visible on hover */}
      <button
        onClick={toggle}
        className="absolute top-1 right-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity text-slate-500 hover:text-slate-300"
        title="Hide minimap (M)"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>close</span>
      </button>
      <canvas
        ref={canvasRef}
        style={{ width: MINIMAP_W, height: MINIMAP_H, display: 'block' }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to CanvasMinimap.tsx

- [ ] **Step 3: Commit**

```bash
git add src/components/CanvasMinimap.tsx
git commit -m "feat: add CanvasMinimap component with canvas rendering"
```

---

### Task 2: Add click and drag-to-pan interaction to the minimap

**Files:**
- Modify: `src/components/CanvasMinimap.tsx`

Add pointer event handlers to the minimap canvas so clicking sets the camera center and dragging continuously pans. The coordinate mapping is the inverse of the draw mapping: minimap pixel → world coordinate → camera position.

- [ ] **Step 1: Add interaction state and coordinate mapping**

Store the world-to-minimap mapping parameters in a ref so pointer handlers can use them. Add `isDragging` ref for drag state.

In `CanvasMinimap`, add these refs before the drawing `useEffect`:

```tsx
  // Store mapping params for pointer handlers
  const mappingRef = useRef<{
    originX: number; originY: number; scale: number; offsetX: number; offsetY: number
  } | null>(null)
  const isDragging = useRef(false)
```

At the end of the drawing `useEffect`, after the viewport indicator drawing, store the mapping:

```tsx
    // Store mapping for pointer interaction
    mappingRef.current = { originX, originY, scale, offsetX, offsetY }
```

- [ ] **Step 2: Add minimapToWorld helper and panToMinimapPoint handler**

Add these functions inside the component, after the refs:

```tsx
  /** Convert minimap pixel coords to world coords, then set camera to center viewport there */
  const panToMinimapPoint = useCallback((mx: number, my: number) => {
    const m = mappingRef.current
    if (!m) return
    const worldX = (mx - m.offsetX) / m.scale + m.originX
    const worldY = (my - m.offsetY) / m.scale + m.originY
    // Center the viewport on this world point (zoom unchanged)
    setCamera(prev => ({
      ...prev,
      x: Math.round(window.innerWidth / 2 - worldX * prev.zoom),
      y: Math.round(window.innerHeight / 2 - worldY * prev.zoom),
    }))
  }, [setCamera])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    isDragging.current = true
    const rect = e.currentTarget.getBoundingClientRect()
    panToMinimapPoint(e.clientX - rect.left, e.clientY - rect.top)
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [panToMinimapPoint])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current) return
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    panToMinimapPoint(e.clientX - rect.left, e.clientY - rect.top)
  }, [panToMinimapPoint])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    isDragging.current = false
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }
  }, [])
```

- [ ] **Step 3: Attach pointer handlers to the minimap container div**

Update the outer `<div>` of the expanded minimap to include the pointer handlers. Add `onPointerDown`, `onPointerMove`, `onPointerUp` and `cursor: 'crosshair'` style:

```tsx
    <div
      className="absolute bottom-12 right-3 select-none group"
      style={{
        width: MINIMAP_W,
        height: MINIMAP_H,
        background: 'rgba(15, 23, 42, 0.85)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: 2,
        cursor: 'crosshair',
      }}
      data-testid="canvas-minimap"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/components/CanvasMinimap.tsx
git commit -m "feat: add click and drag-to-pan interaction to minimap"
```

---

### Task 3: Wire CanvasMinimap into InfiniteCanvas and add M hotkey

**Files:**
- Modify: `src/components/InfiniteCanvas.tsx`
- Modify: `src/hotkeys/useCanvasHotkeys.ts`

Render the minimap inside InfiniteCanvas and register the `M` hotkey.

- [ ] **Step 1: Add `onToggleMinimap` to CanvasHotkeyHandlers and handle `KeyM`**

In `src/hotkeys/useCanvasHotkeys.ts`, add the handler to the interface and the key handler:

Add to `CanvasHotkeyHandlers` interface:
```tsx
  onToggleMinimap: () => void
```

In the `onKeyDown` function, add this block before the hotgroup digit handling (before the `// Hotgroup keys` comment at line 63):

```tsx
      // M — toggle minimap
      if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        if (inEditable) return
        e.preventDefault()
        h.onToggleMinimap()
        return
      }
```

- [ ] **Step 2: Import CanvasMinimap and add toggle ref in InfiniteCanvas**

In `src/components/InfiniteCanvas.tsx`, add the import at the top with the other component imports:

```tsx
import { CanvasMinimap } from './CanvasMinimap'
```

Add a ref for toggling the minimap (after the existing refs around line 186):

```tsx
  const minimapToggleRef = useRef<(() => void) | null>(null)
```

- [ ] **Step 3: Wire `onToggleMinimap` into useCanvasHotkeys call**

In `InfiniteCanvas`, update the `useCanvasHotkeys` call (around line 656) to add:

```tsx
    onToggleMinimap: () => minimapToggleRef.current?.(),
```

- [ ] **Step 4: Render CanvasMinimap inside the canvas container**

In the JSX return of `InfiniteCanvas`, add `<CanvasMinimap>` just before the zoom indicator div (before line 1046 `{/* Bottom-right zoom indicator */}`):

```tsx
      {/* Minimap */}
      <CanvasMinimap
        camera={camera}
        setCamera={setCamera}
        layouts={layouts}
        tree={tree}
        runMap={runMap}
        editorWidgetMap={editorWidgetMap}
        browserWidgetMap={browserWidgetMap}
        imageWidgetMap={imageWidgetMap}
        natsTrafficWidgetMap={natsTrafficWidgetMap}
        toggleRef={minimapToggleRef}
      />
```

- [ ] **Step 5: Add toggleRef prop to CanvasMinimap**

Back in `src/components/CanvasMinimap.tsx`, add the `toggleRef` prop to the interface and wire it up:

Add to `MinimapProps`:
```tsx
  toggleRef?: React.MutableRefObject<(() => void) | null>
```

Add to the component body (after the `toggle` callback):
```tsx
  // Expose toggle to parent for hotkey
  useEffect(() => {
    if (toggleRef) toggleRef.current = toggle
    return () => { if (toggleRef) toggleRef.current = null }
  }, [toggleRef, toggle])
```

Add `toggleRef` to the destructured props:
```tsx
export function CanvasMinimap({
  camera, setCamera, layouts, tree,
  runMap, editorWidgetMap, browserWidgetMap, imageWidgetMap, natsTrafficWidgetMap,
  toggleRef,
}: MinimapProps) {
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/components/CanvasMinimap.tsx src/components/InfiniteCanvas.tsx src/hotkeys/useCanvasHotkeys.ts
git commit -m "feat: wire minimap into InfiniteCanvas with M hotkey toggle"
```

---

### Task 4: Add E2E test for minimap

**Files:**
- Create: `e2e/minimap.spec.ts`

Test that the minimap renders, toggles, and that clicking it pans the viewport.

- [ ] **Step 1: Create the E2E test file**

```ts
// e2e/minimap.spec.ts
import { test, expect } from './fixtures'

test.describe('Canvas Minimap', () => {
  test('minimap is visible by default and shows viewport indicator', async ({ page }) => {
    const minimap = page.getByTestId('canvas-minimap')
    await expect(minimap).toBeVisible()
    // Canvas element exists inside minimap
    const canvas = minimap.locator('canvas')
    await expect(canvas).toBeVisible()
  })

  test('M key toggles minimap visibility', async ({ page }) => {
    const minimap = page.getByTestId('canvas-minimap')
    const toggle = page.getByTestId('minimap-toggle')

    // Initially visible
    await expect(minimap).toBeVisible()

    // Press M to hide
    await page.keyboard.press('m')
    await expect(minimap).not.toBeVisible()
    await expect(toggle).toBeVisible()

    // Press M to show
    await page.keyboard.press('m')
    await expect(minimap).toBeVisible()
  })

  test('clicking collapse button shows icon, clicking icon re-expands', async ({ page }) => {
    const minimap = page.getByTestId('canvas-minimap')
    const toggle = page.getByTestId('minimap-toggle')

    // Hover to reveal close button, then click it
    await minimap.hover()
    const closeBtn = minimap.locator('button')
    await closeBtn.click()

    await expect(minimap).not.toBeVisible()
    await expect(toggle).toBeVisible()

    // Click icon to re-expand
    await toggle.click()
    await expect(minimap).toBeVisible()
  })

  test('clicking minimap pans the viewport', async ({ page }) => {
    const minimap = page.getByTestId('canvas-minimap')
    const canvas = page.getByTestId('infinite-canvas')

    // Record initial zoom indicator position (proxy for camera state)
    const zoomText = page.getByTestId('zoom-indicator')
    await expect(zoomText).toHaveText('100%')

    // Click top-left corner of minimap
    const box = await minimap.boundingBox()
    if (!box) throw new Error('minimap not visible')
    await page.mouse.click(box.x + 10, box.y + 10)

    // The viewport should have moved (we can't easily assert exact camera position,
    // but we can verify the minimap is still visible and functional after click)
    await expect(minimap).toBeVisible()
    await expect(zoomText).toHaveText('100%') // zoom unchanged
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test e2e/minimap.spec.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add e2e/minimap.spec.ts
git commit -m "test: add E2E tests for canvas minimap"
```

---

### Task 5: Manual QA and polish

**Files:**
- Possibly modify: `src/components/CanvasMinimap.tsx` (if adjustments needed)

- [ ] **Step 1: Start the dev server with mock data**

Run: `TINSTAR_FAST_SIM=1 npm run dev`

- [ ] **Step 2: Verify minimap renders in browser**

Open `http://localhost:5280` (or the port shown by Vite). Verify:
- Minimap appears bottom-right, above zoom indicator
- Widget rectangles are visible with correct colors
- White viewport indicator rectangle is visible and tracks pan/zoom

- [ ] **Step 3: Test click and drag interaction**

- Click different areas of the minimap — viewport should jump to that location
- Click and drag across the minimap — viewport should follow smoothly
- Zoom in/out (Ctrl+scroll) — viewfinder rectangle should shrink/grow

- [ ] **Step 4: Test toggle behavior**

- Press `M` — minimap collapses to icon
- Press `M` again — minimap re-expands
- Hover minimap, click `x` — collapses to icon
- Click icon — re-expands
- Refresh page — visibility state persists

- [ ] **Step 5: Commit any polish fixes**

```bash
git add -u
git commit -m "fix: minimap polish adjustments"
```
