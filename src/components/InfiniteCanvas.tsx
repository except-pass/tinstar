import { useRef, useEffect, useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { BrowserWidget, EditorWidget, ImageWidget, NatsTrafficWidget, Run, TreeNode, GroupingDimension } from '../domain/types'
import { findNodeLabel } from '../domain/view-models'
import { useCanvasCamera } from '../hooks/useCanvasCamera'
import { useWidgetLayouts } from '../hooks/useWidgetLayouts'
import { useSelection } from './SelectionProvider'
import { CanvasWidgetShell } from '../widgets/CanvasWidgetShell'
import { getWidgetComponent, toWidgetType } from '../widgets/widgetComponentRegistry'
import type { GroupWidgetData } from '../widgets/widgetComponentRegistry'
import { useCanvasHotkeys } from '../hotkeys/useCanvasHotkeys'
import { useConstellationContext } from '../hotkeys/ConstellationContext'
import { registerCanvasActions } from '../hotkeys/canvasActionsRegistry'
import { EmptyCanvasHint } from './EmptyCanvasHint'
import { CanvasSidebar } from './CanvasSidebar/CanvasSidebar'
import { apiFetch } from '../apiClient'
import { EV } from '../lib/windowEvents'

interface Props {
  tree: TreeNode[]
  runMap: Map<string, Run>
  editorWidgetMap?: Map<string, EditorWidget>
  browserWidgetMap?: Map<string, BrowserWidget>
  imageWidgetMap?: Map<string, ImageWidget>
  natsTrafficWidgetMap?: Map<string, NatsTrafficWidget>
  onImageWidgetCreated?: (widget: ImageWidget) => void
  focusRunId: string | null
  activeSpaceId?: string
  onFocusHandled: () => void
  onSelectRun?: (runId: string, additive: boolean) => void
  onFocusRun?: (runId: string) => void
  onDeleteEntity?: (entityId: string, type: string) => void
  onMenuOpen?: (entityId: string, entityType: GroupingDimension, entityName: string, anchorRect: DOMRect) => void
  onTaskUpdate?: (taskId: string, patch: { externalUrl?: string | null }) => void
  onEditorWidgetCreated?: (widget: EditorWidget) => void
  onBrowserWidgetCreated?: (widget: BrowserWidget) => void
  onNatsWidgetCreated?: (widget: NatsTrafficWidget) => void
  arrangeGridRef?: React.MutableRefObject<(() => void) | null>
  arrangeResetRef?: React.MutableRefObject<(() => void) | null>
  arrangeSwimlanesRef?: React.MutableRefObject<(() => void) | null>
  zoomToFitRunsRef?: React.MutableRefObject<((runIds: string[]) => void) | null>
  panToRunsRef?: React.MutableRefObject<((runIds: string[]) => void) | null>
  /** When true, force the canvas sidebar open regardless of localStorage preference. */
  forceMarshalOpen?: boolean
}

/** Extract entity type and ID from a tree node ID like "initiative-abc123" */
function parseNodeId(nodeId: string): { type: string; entityId: string } | null {
  const dash = nodeId.indexOf('-')
  if (dash === -1) return null
  return { type: nodeId.slice(0, dash), entityId: nodeId.slice(dash + 1) }
}


/** Build a map from child node ID → immediate parent node ID */
function buildParentMap(nodes: TreeNode[], parentId: string | null = null): Map<string, string | null> {
  const map = new Map<string, string | null>()
  for (const node of nodes) {
    map.set(node.id, parentId)
    for (const [k, v] of buildParentMap(node.children, node.id)) {
      map.set(k, v)
    }
  }
  return map
}

/** Collect all leaf (non-container) node IDs from a tree */
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

/** Collect nodes whose IDs are in selectedIds (first match per branch, tree order) */
function collectSelectedNodes(nodes: TreeNode[], selectedIds: Set<string>): TreeNode[] {
  const result: TreeNode[] = []
  for (const node of nodes) {
    if (selectedIds.has(node.id)) {
      result.push(node)
    } else {
      result.push(...collectSelectedNodes(node.children, selectedIds))
    }
  }
  return result
}

const TREEMAP_HEADER_H = 32  // h-8 drag handle on all container widgets
const TREEMAP_PAD = 8        // inner padding around children

/**
 * Compute treemap layouts for a set of nodes within a bounding rect.
 * Places nodes in an aspect-ratio-aware grid, then recurses into containers.
 * Returns a flat Map<nodeId, layout> covering every node in the subtree.
 * Work widgets (non-containers) preserve their existing size; only position changes.
 */
function computeTreemapLayouts(
  nodes: TreeNode[],
  x: number, y: number, w: number, h: number,
  gap: number,
  currentLayouts?: Map<string, import('../hooks/useWidgetLayouts').WidgetLayout>,
): Map<string, import('../hooks/useWidgetLayouts').WidgetLayout> {
  const result = new Map<string, import('../hooks/useWidgetLayouts').WidgetLayout>()
  const n = nodes.length
  if (n === 0 || w <= 0 || h <= 0) return result

  // Aspect-ratio-aware column count: cells will be as square as possible
  const R = Math.max(0.2, Math.min(5, w / h))
  const cols = Math.max(1, Math.round(Math.sqrt(n * R)))
  const rows = Math.ceil(n / cols)
  const cellW = (w - gap * (cols + 1)) / cols
  const cellH = (h - gap * (rows + 1)) / rows

  for (let i = 0; i < n; i++) {
    const node = nodes[i]!
    const col = i % cols
    const row = Math.floor(i / cols)
    const nx = Math.round(x + gap + col * (cellW + gap))
    const ny = Math.round(y + gap + row * (cellH + gap))

    const isContainer = getWidgetComponent(toWidgetType(node.type))?.isContainer
    if (isContainer) {
      // Containers: resize to fit the grid cell
      result.set(node.id, { x: nx, y: ny, width: Math.round(cellW), height: Math.round(cellH) })
      if (node.children.length > 0 && cellW > 120 && cellH > 80) {
        const childGap = Math.max(6, Math.floor(gap * 0.6))
        const innerX = nx + TREEMAP_PAD
        const innerY = ny + TREEMAP_HEADER_H
        const innerW = cellW - TREEMAP_PAD * 2
        const innerH = cellH - TREEMAP_HEADER_H - TREEMAP_PAD
        const childLayouts = computeTreemapLayouts(node.children, innerX, innerY, innerW, innerH, childGap, currentLayouts)
        for (const [id, layout] of childLayouts) result.set(id, layout)
      }
    } else {
      // Work widgets: preserve existing size, only update position
      const existing = currentLayouts?.get(node.id)
      const width = existing?.width ?? 1560
      const height = existing?.height ?? 1410
      result.set(node.id, { x: nx, y: ny, width, height })
    }
  }

  return result
}


interface MarqueeRect {
  startX: number
  startY: number
  endX: number
  endY: number
}

const MARQUEE_THRESHOLD = 5

export function InfiniteCanvas({ tree, runMap, editorWidgetMap = new Map(), browserWidgetMap = new Map(), imageWidgetMap = new Map(), natsTrafficWidgetMap = new Map(), focusRunId, activeSpaceId, onFocusHandled, onSelectRun, onFocusRun, onDeleteEntity, onMenuOpen, onTaskUpdate, onEditorWidgetCreated, onBrowserWidgetCreated, onNatsWidgetCreated, onImageWidgetCreated, arrangeGridRef, arrangeResetRef, arrangeSwimlanesRef, zoomToFitRunsRef, panToRunsRef, forceMarshalOpen }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
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
    insertLayout,
    batchSetLayouts,
  } = useWidgetLayouts(tree, activeSpaceId)
  const { camera, setCamera, cursorStyle, spaceHeld, handleWheel, startPan, movePan, endPan, centerOn } = useCanvasCamera()
  const { select, toggleSelect, selectMany, deselect, isSelected, state: selectionState, expandAll } = useSelection()

  // Drag state
  const draggingRunRef = useRef<string | null>(null)
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)

  // File-drag overlay: shows a full-canvas drop target when a tinstar-editor drag enters,
  // so the terminal iframe doesn't swallow the drop
  const [editorDragActive, setEditorDragActive] = useState(false)
  const dragEnterCountRef = useRef(0)

  // Multi-drag: snapshot of other selected widgets' positions at drag start
  const multiDragSnapshot = useRef<Map<string, { x: number; y: number }> | null>(null)

  // Marquee state
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null)
  const marqueeRef = useRef<{ startX: number; startY: number; active: boolean }>({ startX: 0, startY: 0, active: false })
  // Tracks whether the current pointer-down actually landed on empty canvas (not a widget)
  const canvasPointerDownRef = useRef(false)

  const minimapToggleRef = useRef<(() => void) | null>(null)
  const hudToggleRef = useRef<(() => void) | null>(null)

  // All run node IDs for marquee intersection
  const runNodeIdsRef = useRef<string[]>([])

  // Spawn animation: track which run node IDs are newly created (not present on initial load)
  const seenRunNodeIdsRef = useRef<Set<string> | null>(null)
  const [spawnedNodeIds, setSpawnedNodeIds] = useState<Set<string>>(new Set())

  // Keep parent map, depth map, and run node IDs in sync with tree
  const parentMapRef = useRef<Map<string, string | null>>(new Map())
  const depthMapRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    parentMapRef.current = buildParentMap(tree)
    depthMapRef.current = treeMaps.depthMap
    runNodeIdsRef.current = collectRunNodeIds(tree)

    const leafIds = runNodeIdsRef.current
    if (seenRunNodeIdsRef.current === null) {
      // First render — mark all as seen without animating
      seenRunNodeIdsRef.current = new Set(leafIds)
      return
    }
    const newIds = leafIds.filter(id => !seenRunNodeIdsRef.current!.has(id))
    if (newIds.length === 0) return
    newIds.forEach(id => seenRunNodeIdsRef.current!.add(id))
    setSpawnedNodeIds(prev => new Set([...prev, ...newIds]))
    const timer = setTimeout(() => {
      setSpawnedNodeIds(prev => {
        const next = new Set(prev)
        newIds.forEach(id => next.delete(id))
        return next
      })
    }, 900)
    return () => clearTimeout(timer)
  }, [tree, treeMaps])

  // Center on a widget when focusRunId changes — always at zoom=1.0 for crisp text
  useEffect(() => {
    if (!focusRunId) return
    onFocusHandled()
    if (!containerRef.current) return
    const layout = getLayout(focusRunId)
    if (!layout) return
    const rect = containerRef.current.getBoundingClientRect()
    setCamera({
      x: Math.round(rect.width / 2 - (layout.x + layout.width / 2)),
      y: Math.round(rect.height / 2 - (layout.y + layout.height / 2)),
      zoom: 1,
    })
  }, [focusRunId, getLayout, setCamera, onFocusHandled])

  // Listen for marshal-driven viewport directives. The marshal hand POSTs
  // /api/canvas/viewport which broadcasts a 'canvas:viewport' SSE event,
  // which useServerEvents re-emits as a window event we pick up here.
  useEffect(() => {
    function resolveNodeId(detail: { nodeId?: string; sessionName?: string }): string | null {
      if (detail.nodeId) return detail.nodeId
      if (detail.sessionName) {
        for (const run of runMap.values()) {
          if (run.sessionId === detail.sessionName) return `run-${run.id}`
        }
      }
      return null
    }
    function onViewport(e: Event) {
      const detail = (e as CustomEvent).detail as {
        action: 'set' | 'focus' | 'reset' | 'fit'
        x?: number; y?: number; zoom?: number
        nodeId?: string; sessionName?: string
        padding?: number
      }
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()

      if (detail.action === 'set') {
        if (typeof detail.x !== 'number' || typeof detail.y !== 'number') return
        setCamera(prev => ({
          x: Math.round(detail.x!),
          y: Math.round(detail.y!),
          zoom: typeof detail.zoom === 'number' ? detail.zoom : prev.zoom,
        }))
      } else if (detail.action === 'reset') {
        setCamera(prev => {
          if (prev.zoom === 1) return prev
          const cx = rect.width / 2
          const cy = rect.height / 2
          const ratio = 1 / prev.zoom
          return {
            x: Math.round(cx - (cx - prev.x) * ratio),
            y: Math.round(cy - (cy - prev.y) * ratio),
            zoom: 1,
          }
        })
      } else if (detail.action === 'focus') {
        const id = resolveNodeId(detail)
        if (!id) return
        const layout = getLayout(id)
        if (!layout) return
        centerOn(layout.x, layout.y, layout.width, layout.height, rect.width, rect.height, detail.padding ?? 80)
      } else if (detail.action === 'fit') {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0
        for (const layout of layouts.values()) {
          minX = Math.min(minX, layout.x)
          minY = Math.min(minY, layout.y)
          maxX = Math.max(maxX, layout.x + layout.width)
          maxY = Math.max(maxY, layout.y + layout.height)
          count++
        }
        if (count === 0) return
        centerOn(minX, minY, maxX - minX, maxY - minY, rect.width, rect.height, detail.padding ?? 80)
      }
    }
    window.addEventListener(EV.canvasViewport, onViewport)
    return () => window.removeEventListener(EV.canvasViewport, onViewport)
  }, [setCamera, centerOn, getLayout, layouts, runMap])

  // Attach wheel listener with { passive: false }
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => handleWheel(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [handleWheel])

  // Defensive: if the container ever scrolls (e.g. browser auto-scrolling to
  // reveal a focused descendant like a freshly-mounted ttyd iframe), snap it
  // back to 0. overflow: clip should already prevent this, but on any browser
  // that still allows it the scroll offset would visually shift the canvas,
  // minimap, HUD, and break centerOn math. Self-heal instead.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const reset = () => {
      if (el.scrollLeft !== 0) el.scrollLeft = 0
      if (el.scrollTop !== 0) el.scrollTop = 0
    }
    el.addEventListener('scroll', reset)
    return () => el.removeEventListener('scroll', reset)
  }, [])

  // Handle tinstar:open-linked-file — spawn a new editor widget next to the source widget
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleLinkedFile = async (e: Event) => {
      const { sessionId, filePath, sourceWidgetId } = (e as CustomEvent).detail as {
        sessionId: string
        filePath: string
        sourceWidgetId: string
      }

      const sourceLayout = getLayout(sourceWidgetId)
      const spawnX = sourceLayout ? sourceLayout.x + sourceLayout.width + 40 : 0
      const spawnY = sourceLayout ? sourceLayout.y : 0
      const spawnLayout = { x: spawnX, y: spawnY, width: 640, height: 480 }

      const res = await apiFetch('/api/editor-widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, filePath }),
      })
      const json = await res.json() as { ok: boolean; data?: EditorWidget }
      if (!json.ok || !json.data) return
      insertLayout(json.data.id, spawnLayout)
      onEditorWidgetCreated?.(json.data)
    }

    container.addEventListener('tinstar:open-linked-file', handleLinkedFile)
    return () => container.removeEventListener('tinstar:open-linked-file', handleLinkedFile)
  }, [getLayout, insertLayout, onEditorWidgetCreated])

  // --- Pointer handlers: pan OR marquee ---
  const panPointerIdRef = useRef<number | null>(null)

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (spaceHeld.current || e.button === 1) {
        // Space held or middle-click = pan
        e.preventDefault()
        startPan(e.nativeEvent)
        // Capture pointer so events aren't swallowed by iframes during pan
        panPointerIdRef.current = e.pointerId
        containerRef.current?.setPointerCapture(e.pointerId)
        return
      }
      // Start marquee on left-click on empty canvas
      // (widget clicks stop propagation so this only fires for true empty-canvas clicks)
      if (e.button === 0) {
        canvasPointerDownRef.current = true
        marqueeRef.current = { startX: e.clientX, startY: e.clientY, active: false }
      }
    },
    [startPan, spaceHeld],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      // Always forward to movePan — it no-ops if not panning
      movePan(e.nativeEvent)
      if (spaceHeld.current) return
      // Marquee drawing
      if (marqueeRef.current.startX !== 0 || marqueeRef.current.startY !== 0) {
        const dx = e.clientX - marqueeRef.current.startX
        const dy = e.clientY - marqueeRef.current.startY
        if (!marqueeRef.current.active && Math.hypot(dx, dy) < MARQUEE_THRESHOLD) return
        marqueeRef.current.active = true
        setMarquee({
          startX: marqueeRef.current.startX,
          startY: marqueeRef.current.startY,
          endX: e.clientX,
          endY: e.clientY,
        })
      }
    },
    [movePan, spaceHeld],
  )

  const onPointerUp = useCallback(
    (_e: ReactPointerEvent) => {
      // Always end pan (handles both space+drag and middle-click pan)
      endPan()
      // Release pointer capture from pan
      if (panPointerIdRef.current !== null) {
        try { containerRef.current?.releasePointerCapture(panPointerIdRef.current) } catch { /* already released */ }
        panPointerIdRef.current = null
      }
      const wasCanvasPointerDown = canvasPointerDownRef.current
      canvasPointerDownRef.current = false
      if (spaceHeld.current) {
        marqueeRef.current = { startX: 0, startY: 0, active: false }
        setMarquee(null)
        return
      }
      // If the pointer went down on a widget (not empty canvas), don't deselect
      if (!wasCanvasPointerDown) return

      if (marqueeRef.current.active && marquee) {
        // Resolve marquee: find all run widgets inside the bounding box
        const el = containerRef.current
        if (el) {
          const rect = el.getBoundingClientRect()
          const x1 = (Math.min(marquee.startX, marquee.endX) - rect.left - camera.x) / camera.zoom
          const y1 = (Math.min(marquee.startY, marquee.endY) - rect.top - camera.y) / camera.zoom
          const x2 = (Math.max(marquee.startX, marquee.endX) - rect.left - camera.x) / camera.zoom
          const y2 = (Math.max(marquee.startY, marquee.endY) - rect.top - camera.y) / camera.zoom

          const selected: string[] = []
          for (const nodeId of runNodeIdsRef.current) {
            const layout = layouts.get(nodeId)
            if (!layout) continue
            // Check AABB intersection
            if (
              layout.x + layout.width > x1 &&
              layout.x < x2 &&
              layout.y + layout.height > y1 &&
              layout.y < y2
            ) {
              selected.push(nodeId)
            }
          }
          if (selected.length > 0) {
            selectMany(selected, 'run')
          } else {
            deselect()
          }
        }
      } else if (!marqueeRef.current.active) {
        // Plain click on empty canvas = deselect all
        deselect()
      }

      marqueeRef.current = { startX: 0, startY: 0, active: false }
      setMarquee(null)
    },
    [endPan, spaceHeld, marquee, layouts, camera, selectMany, deselect],
  )

  const onPointerLeave = useCallback(() => {
    // Don't kill pan if we hold pointer capture (cursor crossing iframes)
    if (panPointerIdRef.current === null) {
      endPan()
    }
    marqueeRef.current = { startX: 0, startY: 0, active: false }
    setMarquee(null)
  }, [endPan])

  // Escape: cancel any drag, deselect everything, focus the canvas
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // Don't steal Escape from dialogs/modals
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return

      e.preventDefault()
      // Cancel canvas-level drag state
      endPan()
      marqueeRef.current = { startX: 0, startY: 0, active: false }
      setMarquee(null)
      canvasPointerDownRef.current = false
      draggingRunRef.current = null
      setDraggingNodeId(null)
      multiDragSnapshot.current = null
      // Deselect all
      deselect()
      // Focus the canvas container
      containerRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [endPan, deselect])

  // Widget drag callbacks
  const handleWidgetDragStart = useCallback((nodeId: string) => {
    draggingRunRef.current = nodeId
    setDraggingNodeId(nodeId)
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

  const handleWidgetDragEnd = useCallback(() => {
    draggingRunRef.current = null
    setDraggingNodeId(null)
    multiDragSnapshot.current = null
  }, [])

  // Multi-drag aware move: when dragging a selected widget, move all selected peers by the same delta
  const handleMultiMove = useCallback((nodeId: string, newX: number, newY: number) => {
    updateRunPosition(nodeId, newX, newY)
    const snap = multiDragSnapshot.current
    if (!snap) return
    const origin = snap.get('__origin__')
    if (!origin) return
    const dx = newX - origin.x
    const dy = newY - origin.y
    for (const [peerNodeId, pos] of snap) {
      if (peerNodeId === '__origin__') continue
      updateRunPosition(peerNodeId, pos.x + dx, pos.y + dy)
    }
  }, [updateRunPosition])

  // Grid arrange: treemap-style nested layout filling the viewport
  const arrangeGrid = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()

    // Determine root nodes to arrange (selected nodes, or entire tree if nothing selected)
    let rootNodes: TreeNode[]
    if (selectionState.selectedIds.size > 0) {
      rootNodes = collectSelectedNodes(tree, selectionState.selectedIds)
    } else {
      rootNodes = tree
    }
    if (rootNodes.length === 0) return

    // Viewport in canvas coords
    const vx = -camera.x / camera.zoom
    const vy = -camera.y / camera.zoom
    const vw = rect.width / camera.zoom
    const vh = rect.height / camera.zoom

    const newLayouts = computeTreemapLayouts(rootNodes, vx, vy, vw, vh, 20, layouts)
    batchSetLayouts(newLayouts)
  }, [camera, selectionState, tree, batchSetLayouts])

  // Swim lanes: rows of runs grouped by task, stacked by epic/initiative
  const arrangeSwimlanes = useCallback(() => {
    const el = containerRef.current
    if (!el) return

    const GAP = 24
    const EMPTY_H = 60  // thin placeholder bar for empty containers
    const MIN_LEAF_H = 150  // mirrors FIT_MIN_HEIGHT / useWidgetLayouts MIN_HEIGHT
    const updates = new Map<string, { x: number; y: number; width: number; height: number }>()

    // Leaf height = viewport height (in canvas coords at current zoom) — same
    // behavior as hotkey Z. Width keeps the widget's current value.
    const rect = el.getBoundingClientRect()
    const leafHeight = Math.max(MIN_LEAF_H, rect.height / camera.zoom)

    const getLeafSize = (id: string) => {
      const l = layouts.get(id)
      const w = l ? l.width : 1560
      return { w, h: leafHeight }
    }

    // Viewport origin in canvas coords
    const startX = -camera.x / camera.zoom
    const startY = -camera.y / camera.zoom
    // Track the widest row so empty containers can match
    let maxRowWidth = 400

    let cursorY = startY

    function collectLeaves(node: TreeNode): string[] {
      const reg = getWidgetComponent(toWidgetType(node.type))
      if (!reg?.isContainer) return [node.id]
      const ids: string[] = []
      for (const child of node.children) ids.push(...collectLeaves(child))
      return ids
    }

    function layoutRow(leafIds: string[], x: number, y: number): { width: number; height: number } {
      let cx = x
      let maxH = 0
      for (const id of leafIds) {
        const sz = getLeafSize(id)
        updates.set(id, { x: Math.round(cx), y: Math.round(y), width: Math.round(sz.w), height: Math.round(sz.h) })
        cx += sz.w + GAP
        maxH = Math.max(maxH, sz.h)
      }
      const totalW = cx - x - (leafIds.length > 0 ? GAP : 0)
      if (totalW > maxRowWidth) maxRowWidth = totalW
      return { width: totalW, height: maxH }
    }

    // First pass: layout all rows, collecting empty containers
    const emptyContainers: TreeNode[] = []

    function layoutGroup(nodes: TreeNode[], baseX: number): void {
      for (const node of nodes) {
        const reg = getWidgetComponent(toWidgetType(node.type))
        if (!reg?.isContainer) continue

        const allLeaves = collectLeaves(node)

        // Empty container — defer to end
        if (allLeaves.length === 0) {
          emptyContainers.push(node)
          continue
        }

        const directLeaves: string[] = []
        const subContainers: TreeNode[] = []
        for (const child of node.children) {
          const childReg = getWidgetComponent(toWidgetType(child.type))
          if (childReg?.isContainer) {
            subContainers.push(child)
          } else {
            directLeaves.push(child.id)
          }
        }

        if (subContainers.length > 0) {
          // Has sub-containers: recurse (e.g. initiative → epics, epic → tasks)
          // But also lay out any direct leaves first
          if (directLeaves.length > 0) {
            const row = layoutRow(directLeaves, baseX, cursorY)
            cursorY += row.height + GAP
          }
          layoutGroup(node.children, baseX)
        } else {
          const row = layoutRow(directLeaves, baseX, cursorY)
          if (directLeaves.length > 0) cursorY += row.height + GAP
        }
      }
    }

    // Separate top-level nodes into containers and loose leaves
    const topContainers: TreeNode[] = []
    const topLeaves: string[] = []
    for (const node of tree) {
      const reg = getWidgetComponent(toWidgetType(node.type))
      if (reg?.isContainer) {
        topContainers.push(node)
      } else {
        topLeaves.push(node.id)
      }
    }

    // Layout grouped containers first
    layoutGroup(topContainers, startX)

    // Then ungrouped leaves in a single row at the bottom
    if (topLeaves.length > 0) {
      const row = layoutRow(topLeaves, startX, cursorY)
      cursorY += row.height + GAP
    }

    // Empty containers: collapse to thin placeholder bars in a row
    if (emptyContainers.length > 0) {
      let cx = startX
      for (const node of emptyContainers) {
        updates.set(node.id, { x: Math.round(cx), y: Math.round(cursorY), width: Math.round(maxRowWidth / emptyContainers.length - GAP), height: EMPTY_H })
        cx += maxRowWidth / emptyContainers.length
      }
      cursorY += EMPTY_H + GAP
    }

    if (updates.size > 0) batchSetLayouts(updates)
  }, [camera, tree, layouts, batchSetLayouts])

  // Expose arrange functions to parent via refs
  useEffect(() => {
    if (arrangeGridRef) arrangeGridRef.current = arrangeGrid
    return () => { if (arrangeGridRef) arrangeGridRef.current = null }
  }, [arrangeGridRef, arrangeGrid])

  useEffect(() => {
    if (arrangeResetRef) arrangeResetRef.current = arrangeWorkspace
    return () => { if (arrangeResetRef) arrangeResetRef.current = null }
  }, [arrangeResetRef, arrangeWorkspace])

  useEffect(() => {
    if (arrangeSwimlanesRef) arrangeSwimlanesRef.current = arrangeSwimlanes
    return () => { if (arrangeSwimlanesRef) arrangeSwimlanesRef.current = null }
  }, [arrangeSwimlanesRef, arrangeSwimlanes])

  // Compute bounding box of a set of run node IDs using current layouts
  const getBoundingBox = useCallback((runIds: string[]): { x: number; y: number; w: number; h: number } | null => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const id of runIds) {
      const layout = layouts.get(id)
      if (!layout) continue
      minX = Math.min(minX, layout.x)
      minY = Math.min(minY, layout.y)
      maxX = Math.max(maxX, layout.x + layout.width)
      maxY = Math.max(maxY, layout.y + layout.height)
    }
    if (!isFinite(minX)) return null
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }, [layouts])

  // zoomToFitRuns: compute bounding box and zoom-to-fit flush with the viewport (no margin)
  const zoomToFitRuns = useCallback((runIds: string[]) => {
    const el = containerRef.current
    if (!el) return
    const box = getBoundingBox(runIds)
    if (!box) return
    const rect = el.getBoundingClientRect()
    centerOn(box.x, box.y, box.w, box.h, rect.width, rect.height, 0)
  }, [getBoundingBox, centerOn])

  // panToRuns: pan to center bounding box at current zoom, 60px margin (no zoom change)
  const panToRuns = useCallback((runIds: string[]) => {
    const el = containerRef.current
    if (!el) return
    const box = getBoundingBox(runIds)
    if (!box) return
    const rect = el.getBoundingClientRect()
    const MARGIN = 60
    const zoom = camera.zoom
    // Center of bounding box in canvas coords
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    // Target camera position: center the bounding box in viewport
    const newX = rect.width / 2 - cx * zoom
    const newY = rect.height / 2 - cy * zoom
    // Check if box fits at current zoom with margin; if not, clamp to show top-left
    const boxScreenW = box.w * zoom
    const boxScreenH = box.h * zoom
    if (boxScreenW > rect.width - MARGIN * 2 || boxScreenH > rect.height - MARGIN * 2) {
      // Box doesn't fit at current zoom — just center it anyway
      setCamera(prev => ({ ...prev, x: newX, y: newY }))
    } else {
      setCamera(prev => ({ ...prev, x: newX, y: newY }))
    }
  }, [getBoundingBox, camera.zoom, setCamera])

  // Expose zoomToFitRuns and panToRuns via refs
  useEffect(() => {
    if (zoomToFitRunsRef) zoomToFitRunsRef.current = zoomToFitRuns
    return () => { if (zoomToFitRunsRef) zoomToFitRunsRef.current = null }
  }, [zoomToFitRunsRef, zoomToFitRuns])

  useEffect(() => {
    if (panToRunsRef) panToRunsRef.current = panToRuns
    return () => { if (panToRunsRef) panToRunsRef.current = null }
  }, [panToRunsRef, panToRuns])

  // Constellation context and canvas hotkeys
  const constellations = useConstellationContext()

  useCanvasHotkeys({
    onConstellationNavigate: (slot) => {
      // constellations stores full node IDs (e.g. 'run-R-241', 'editor-abc', 'browser-xyz')
      const slotNodeIds = constellations.nodesInSlot(slot as never).filter(id => layouts.has(id))
      if (slotNodeIds.length === 0) return
      // Determine selection type from first node prefix
      const first = slotNodeIds[0]!
      const selType = first.startsWith('run-') ? 'run'
        : first.startsWith('editor-') ? 'file-editor'
        : first.startsWith('image-') ? 'image-viewer'
        : first.startsWith('nats-') ? 'nats-traffic'
        : 'browser-widget'
      selectMany(slotNodeIds, selType as import('../domain/types').GroupingDimension | 'run' | 'file-editor' | 'browser-widget' | 'image-viewer' | 'nats-traffic')
      // Expand all ancestors in sidebar so the nodes become visible
      const ancestorIds: string[] = []
      for (const nodeId of slotNodeIds) {
        let cur = parentMapRef.current.get(nodeId) ?? null
        while (cur) {
          ancestorIds.push(cur)
          cur = parentMapRef.current.get(cur) ?? null
        }
      }
      if (ancestorIds.length > 0) expandAll(ancestorIds)
      zoomToFitRuns(slotNodeIds)
    },
    onConstellationAssign: (slot) => {
      const { selectedType, selectedIds } = selectionState
      if (!selectedType || (selectedType !== 'run' && selectedType !== 'file-editor' && selectedType !== 'browser-widget' && selectedType !== 'image-viewer' && selectedType !== 'nats-traffic')) return
      for (const nodeId of selectedIds) {
        constellations.assign(slot, nodeId)
      }
    },
    onConstellationRemove: (slot) => {
      const { selectedType, selectedIds } = selectionState
      if (!selectedType || (selectedType !== 'run' && selectedType !== 'file-editor' && selectedType !== 'browser-widget' && selectedType !== 'image-viewer' && selectedType !== 'nats-traffic')) return
      for (const nodeId of selectedIds) {
        constellations.remove(slot, nodeId)
      }
    },
    onArrangeGrid: () => arrangeGridRef?.current?.(),
    onArrangeReset: () => arrangeResetRef?.current?.(),
    onArrangeSwimlanes: () => arrangeSwimlanesRef?.current?.(),
    onToggleMinimap: () => minimapToggleRef.current?.(),
    onToggleHud: () => hudToggleRef.current?.(),
  })

  // Register the canvas-level fit implementation so widget action handlers
  // can call fitWidgetToViewport(id) in response to the 'fit-viewport'
  // binding (Z key).
  useEffect(() => {
    const FIT_MIN_HEIGHT = 150 // mirrors MIN_HEIGHT in useWidgetLayouts.ts
    return registerCanvasActions({
      fit: (nodeId: string) => {
        const layout = getLayout(nodeId)
        if (!layout) return
        const el = containerRef.current
        if (!el) return
        // Use the canvas element's rect, not the window — sidebars take up window width.
        const rect = el.getBoundingClientRect()
        const newHeight = Math.max(FIT_MIN_HEIGHT, rect.height)
        // Grow/shrink the widget; cascade expansion updates ancestor containers.
        resizeNode(nodeId, layout.width, newHeight)
        // Clear any focus-induced auto-scroll on the canvas container. Browsers will
        // scroll even overflow-hidden elements to reveal focused descendants, which
        // invalidates our camera math. See: https://drafts.csswg.org/cssom-view/#element-scrolling-members
        el.scrollLeft = 0
        el.scrollTop = 0
        // Center the (resized) widget in the canvas viewport at zoom 1.
        const cx = rect.width / 2 - (layout.x + layout.width / 2)
        const cy = rect.height / 2 - (layout.y + newHeight / 2)
        setCamera({ x: Math.round(cx), y: Math.round(cy), zoom: 1 })
      },
    })
  }, [getLayout, resizeNode, setCamera])

  const handleDeleteGroup = useCallback((nodeId: string) => {
    if (!onDeleteEntity) return
    const parsed = parseNodeId(nodeId)
    if (parsed) onDeleteEntity(parsed.entityId, parsed.type)
  }, [onDeleteEntity])

  const handleMenuOpenGroup = useCallback((nodeId: string, anchorRect: DOMRect) => {
    if (!onMenuOpen) return
    const parsed = parseNodeId(nodeId)
    if (!parsed) return
    const label = findNodeLabel(tree, nodeId) ?? nodeId
    onMenuOpen(parsed.entityId, parsed.type as GroupingDimension, label, anchorRect)
  }, [onMenuOpen, tree])

  const handleSelect = useCallback((nodeId: string, additive: boolean) => {
    if (nodeId.startsWith('run-') && onSelectRun) {
      onSelectRun(nodeId.slice(4), additive)
    } else if (nodeId.startsWith('editor-')) {
      additive ? toggleSelect(nodeId, 'file-editor') : select(nodeId, 'file-editor')
    } else if (nodeId.startsWith('browser-')) {
      additive ? toggleSelect(nodeId, 'browser-widget') : select(nodeId, 'browser-widget')
    } else if (nodeId.startsWith('image-')) {
      additive ? toggleSelect(nodeId, 'image-viewer') : select(nodeId, 'image-viewer')
    } else if (nodeId.startsWith('nats-')) {
      additive ? toggleSelect(nodeId, 'nats-traffic') : select(nodeId, 'nats-traffic')
    } else {
      // Group container click — select it in the shared selection state so hierarchy highlights too
      const parsed = parseNodeId(nodeId)
      if (parsed) {
        const t = parsed.type as import('../domain/types').GroupingDimension
        additive ? toggleSelect(nodeId, t) : select(nodeId, t)
      }
    }
  }, [onSelectRun, select, toggleSelect])

  const handleDoubleClickShrink = useCallback((nodeId: string) => {
    shrinkNode(nodeId)
  }, [shrinkNode])

  const handleDoubleClickZoom = useCallback((nodeId: string) => {
    if (onFocusRun && nodeId.startsWith('run-')) {
      onFocusRun(nodeId.slice(4))
    } else if (nodeId.startsWith('editor-') || nodeId.startsWith('browser-') || nodeId.startsWith('image-') || nodeId.startsWith('nats-')) {
      zoomToFitRuns([nodeId])
    }
  }, [onFocusRun, zoomToFitRuns])

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()

      const rect = containerRef.current!.getBoundingClientRect()
      const dropX = Math.round((e.clientX - rect.left - camera.x) / camera.zoom)
      const dropY = Math.round((e.clientY - rect.top - camera.y) / camera.zoom)

      const rawEditor = e.dataTransfer.getData('application/tinstar-editor')
      if (rawEditor) {
        const { sessionId, filePath } = JSON.parse(rawEditor) as { sessionId: string; filePath: string }
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']
        const isImage = imageExts.some(ext => filePath.toLowerCase().endsWith(ext))

        if (isImage) {
          const imageRes = await apiFetch('/api/image-widgets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, filePath }),
          })
          const imageJson = await imageRes.json() as { ok: boolean; data?: ImageWidget }
          if (!imageJson.ok || !imageJson.data) return
          const { naturalWidth, naturalHeight } = imageJson.data
          const spawnLayout = {
            x: dropX, y: dropY,
            width: Math.min(naturalWidth, 1200),
            height: Math.min(naturalHeight, 900),
          }
          insertLayout(imageJson.data.id, spawnLayout)
          onImageWidgetCreated?.(imageJson.data)
          return
        }

        const spawnLayout = { x: dropX, y: dropY, width: 640, height: 480 }
        const editorRes = await apiFetch('/api/editor-widgets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, filePath }),
        })
        const editorJson = await editorRes.json() as { ok: boolean; data?: EditorWidget }
        if (!editorJson.ok || !editorJson.data) return
        insertLayout(editorJson.data.id, spawnLayout)
        onEditorWidgetCreated?.(editorJson.data)
        return
      }

      const rawBrowser = e.dataTransfer.getData('application/tinstar-browser')
      if (rawBrowser) {
        const { sessionId } = JSON.parse(rawBrowser) as { sessionId: string }
        const spawnLayout = { x: dropX, y: dropY, width: 800, height: 600 }
        const res = await apiFetch('/api/browser-widgets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        const resJson = await res.json() as { ok: boolean; data?: BrowserWidget }
        if (!resJson.ok || !resJson.data) return
        insertLayout(resJson.data.id, spawnLayout)
        onBrowserWidgetCreated?.(resJson.data)
        return
      }

      const rawNats = e.dataTransfer.getData('application/tinstar-nats')
      if (rawNats) {
        const { sessionId, natsSubject, color } = JSON.parse(rawNats) as { sessionId: string; natsSubject?: string; color?: string }
        const spawnLayout = { x: dropX, y: dropY, width: 500, height: 400 }
        // Build subscription filter: two-tier model (direct DM + task broadcast)
        // natsSubject is the direct address (e.g., tinstar.space.init.epic.task.session)
        // Broadcast = strip session name (no wildcard needed)
        const subscriptions = natsSubject
          ? [
              natsSubject,  // direct DM inbox for this session
              natsSubject.replace(/\.[^.]+$/, ''),  // task broadcast channel (no wildcard)
            ]
          : [`tinstar.>`]  // fallback to all tinstar traffic
        const res = await apiFetch('/api/nats-traffic-widgets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, subscriptions, color }),
        })
        const resJson = await res.json() as { ok: boolean; data?: NatsTrafficWidget }
        if (!resJson.ok || !resJson.data) return
        insertLayout(resJson.data.id, spawnLayout)
        onNatsWidgetCreated?.(resJson.data)
        return
      }

      // Hand spawn drop
      const handData = e.dataTransfer.getData('application/tinstar-hand')
      if (handData) {
        try {
          const { handName, sessionId } = JSON.parse(handData) as { handName: string; sessionId: string }
          // Spawn the hand via API
          apiFetch(`/api/sessions/${sessionId}/spawn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hand: handName }),
          })
            .then(res => res.json())
            .then(data => {
              if (data.ok) {
                // The spawned session will create a run, which will trigger SSE update
                // and the canvas will auto-add the new widget via useRunsForTask
                console.log('Hand spawned:', data.data.session)
              } else {
                console.error('Hand spawn failed:', data.error)
              }
            })
            .catch(err => console.error('Hand spawn error:', err))
        } catch {
          // Invalid data
        }
        return
      }
    },
    [camera, insertLayout, onEditorWidgetCreated, onBrowserWidgetCreated, onNatsWidgetCreated, onImageWidgetCreated],
  )

  // Recursive render: groups render behind their children (natural DOM order)
  function renderNode(node: TreeNode, _depth: number): React.ReactNode {
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
        : node.type === 'file-editor'
          ? editorWidgetMap.get(node.entityId)
          : node.type === 'browser-widget'
            ? browserWidgetMap.get(node.entityId)
            : node.type === 'image-viewer'
              ? imageWidgetMap.get(node.entityId)
              : node.type === 'nats-traffic'
                ? natsTrafficWidgetMap.get(node.entityId)
                : ({
              node,
              depth: depthMapRef.current.get(node.id) ?? 0,
              onShrinkToFit: shrinkNode,
              onDelete: handleDeleteGroup,
              onMenuOpen: handleMenuOpenGroup,
              ...(node.type === 'task' && { onTaskUpdate }),
            } satisfies GroupWidgetData)

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
        isSpawning={spawnedNodeIds.has(node.id)}
        spawnColor={node.type === 'run' ? runMap.get(node.entityId)?.color : undefined}
        isDimmed={selectionState.selectedIds.size > 0 && selectionState.selectedType === 'run' && !isSelected(node.id)}
        spaceHeldRef={spaceHeld}
        onSelect={handleSelect}
        onDoubleClickZoom={reg.isContainer ? handleDoubleClickShrink : (node.type === 'run' || node.type === 'file-editor' || node.type === 'browser-widget' || node.type === 'image-viewer' || node.type === 'nats-traffic' ? handleDoubleClickZoom : undefined)}
        onMove={moveHandler}
        onResize={resizeHandler}
        onDragStart={node.type === 'run' ? handleWidgetDragStart : undefined}
        onDragEnd={node.type === 'run' ? handleWidgetDragEnd : undefined}
      />
    )
  }

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

  const renderedNodes = collectRenderOrder(tree, 0)

  // Compute drag ghost: precise dashed outline at the widget's current drag position.
  // Sits behind the widget (z-index 50 < widget's 100) so the widget floats on top.
  let dragGhost: React.CSSProperties | null = null
  if (draggingNodeId) {
    const dragLayout = layouts.get(draggingNodeId)
    if (dragLayout) {
      dragGhost = {
        position: 'absolute',
        left: dragLayout.x,
        top: dragLayout.y,
        width: dragLayout.width,
        height: dragLayout.height,
        border: '2px dashed rgba(0, 240, 255, 0.7)',
        backgroundColor: 'rgba(0, 240, 255, 0.04)',
        pointerEvents: 'none',
        zIndex: 50,
        boxSizing: 'border-box',
      }
    }
  }

  // Compute marquee rect for rendering (screen-space, relative to container)
  let marqueeStyle: React.CSSProperties | null = null
  if (marquee) {
    const el = containerRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      marqueeStyle = {
        position: 'absolute',
        left: Math.min(marquee.startX, marquee.endX) - rect.left,
        top: Math.min(marquee.startY, marquee.endY) - rect.top,
        width: Math.abs(marquee.endX - marquee.startX),
        height: Math.abs(marquee.endY - marquee.startY),
        border: '1px solid rgba(0, 240, 255, 0.6)',
        backgroundColor: 'rgba(0, 240, 255, 0.08)',
        pointerEvents: 'none' as const,
        zIndex: 50,
      }
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-testid="infinite-canvas"
      className="w-full h-full overflow-clip relative outline-none"
      style={{
        cursor: cursorStyle,
        backgroundImage: 'radial-gradient(circle, rgba(0,240,255,0.04) 1px, transparent 1px)',
        backgroundSize: `${24 * camera.zoom}px ${24 * camera.zoom}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
      onDragOver={(e) => { e.preventDefault() }}
      onDrop={handleDrop}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('application/tinstar-editor') || e.dataTransfer.types.includes('application/tinstar-browser') || e.dataTransfer.types.includes('application/tinstar-nats') || e.dataTransfer.types.includes('application/tinstar-hand')) {
          dragEnterCountRef.current++
          setEditorDragActive(true)
        }
      }}
      onDragLeave={() => {
        dragEnterCountRef.current--
        if (dragEnterCountRef.current <= 0) {
          dragEnterCountRef.current = 0
          setEditorDragActive(false)
        }
      }}
    >
      {/* File-editor drag overlay — covers iframes so the drop always lands on the canvas */}
      {editorDragActive && (
        <div
          className="absolute inset-0 z-[9999]"
          style={{ background: 'rgba(0,240,255,0.04)', border: '2px dashed rgba(0,240,255,0.35)' }}
          onDragOver={(e) => { e.preventDefault() }}
          onDrop={(e) => { e.stopPropagation(); setEditorDragActive(false); dragEnterCountRef.current = 0; void handleDrop(e) }}
          onDragLeave={() => { dragEnterCountRef.current = 0; setEditorDragActive(false) }}
        />
      )}
      {/* Transformed canvas layer */}
      <div
        style={{
          transformOrigin: '0 0',
          transform: `translate(${Math.round(camera.x)}px, ${Math.round(camera.y)}px) scale(${camera.zoom})`,
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      >
        {renderedNodes}
        {dragGhost && <div style={dragGhost} />}
      </div>

      {/* Empty canvas hint */}
      {runMap.size === 0 && <EmptyCanvasHint />}

      {/* Marquee selection box */}
      {marqueeStyle && <div style={marqueeStyle} />}

      {/* Right-side canvas sidebar — telemetry + marshal terminal + minimap */}
      <CanvasSidebar
        camera={camera}
        setCamera={setCamera}
        layouts={layouts}
        tree={tree}
        runMap={runMap}
        editorWidgetMap={editorWidgetMap}
        browserWidgetMap={browserWidgetMap}
        imageWidgetMap={imageWidgetMap}
        natsTrafficWidgetMap={natsTrafficWidgetMap}
        onFocusRun={onFocusRun}
        selectedRunIds={selectionState.selectedType === 'run' ? selectionState.selectedIds : undefined}
        hudToggleRef={hudToggleRef}
        minimapToggleRef={minimapToggleRef}
        forceExpanded={forceMarshalOpen}
      />

      {/* Bottom-right zoom indicator */}
      <div className="absolute bottom-3 right-3 flex items-center gap-2">
        <div
          className="bg-surface-panel border border-white/10 px-3 py-1.5 text-xs font-mono text-slate-500 rounded-sm select-none"
          data-testid="zoom-indicator"
        >
          {Math.round(camera.zoom * 100)}%
        </div>
      </div>

    </div>
  )
}
