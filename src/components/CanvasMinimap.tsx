// src/components/CanvasMinimap.tsx
import { useRef, useEffect, useCallback, useState } from 'react'
import type { Camera } from '../hooks/useCanvasCamera'
import type { WidgetLayout } from '../hooks/useWidgetLayouts'
import type { TreeNode, Run, BrowserWidget, EditorWidget, ImageWidget, NatsTrafficWidget } from '../domain/types'
import { getWidgetComponent, toWidgetType } from '../widgets/widgetComponentRegistry'
import { resolveRunAccent, hexToRgba } from './runAccent'

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
  toggleRef?: React.MutableRefObject<(() => void) | null>
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

export function CanvasMinimap({
  camera, setCamera, layouts, tree,
  runMap, editorWidgetMap, browserWidgetMap, imageWidgetMap, natsTrafficWidgetMap,
  toggleRef,
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

  // Expose toggle to parent for hotkey
  useEffect(() => {
    if (toggleRef) toggleRef.current = toggle
    return () => { if (toggleRef) toggleRef.current = null }
  }, [toggleRef, toggle])

  // Store mapping params for pointer handlers
  const mappingRef = useRef<{
    originX: number; originY: number; scale: number; offsetX: number; offsetY: number
  } | null>(null)
  const isDragging = useRef(false)

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

    if (workEntries.length === 0) {
      mappingRef.current = null
      return
    }

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
      ctx.fillStyle = hexToRgba(color, 0.6)
      ctx.fillRect(mx, my, mw, mh)
    }

    // Draw viewport indicator
    const [vx, vy] = worldToMinimap(vpWorldX, vpWorldY)
    const vw = vpWorldW * scale
    const vh = vpWorldH * scale
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(vx, vy, vw, vh)

    // Store mapping for pointer interaction
    mappingRef.current = { originX, originY, scale, offsetX, offsetY }
  }, [visible, camera, layouts, tree, runMap, editorWidgetMap, browserWidgetMap, imageWidgetMap, natsTrafficWidgetMap])

  // --- Interaction (Task 2) ---
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
    e.stopPropagation()
    isDragging.current = false
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }
  }, [])

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
        cursor: 'crosshair',
      }}
      data-testid="canvas-minimap"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Close button — visible on hover */}
      <button
        onClick={toggle}
        onPointerDown={(e) => e.stopPropagation()}
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
