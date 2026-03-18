import { useRef, useEffect, useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { EditorWidget, Run, TreeNode, GroupingDimension } from '../domain/types'
import { useCanvasCamera } from '../hooks/useCanvasCamera'
import { useWidgetLayouts, type WidgetLayout } from '../hooks/useWidgetLayouts'
import { useSelection } from './SelectionProvider'
import { CanvasWidgetShell } from '../widgets/CanvasWidgetShell'
import { getWidgetComponent, toWidgetType } from '../widgets/widgetComponentRegistry'
import type { GroupWidgetData } from '../widgets/widgetComponentRegistry'
import { useCanvasHotkeys } from '../hotkeys/useCanvasHotkeys'
import { useHotgroupContext } from '../hotkeys/HotgroupContext'
import { EmptyCanvasHint } from './EmptyCanvasHint'

interface Props {
  tree: TreeNode[]
  runMap: Map<string, Run>
  editorWidgetMap?: Map<string, EditorWidget>
  focusRunId: string | null
  activeSpaceId?: string
  onFocusHandled: () => void
  onSelectRun?: (runId: string, additive: boolean) => void
  onFocusRun?: (runId: string) => void
  onDeleteEntity?: (entityId: string, type: string) => void
  onMenuOpen?: (entityId: string, entityType: GroupingDimension, entityName: string, anchorRect: DOMRect) => void
  onTaskUpdate?: (taskId: string, patch: { externalUrl?: string | null }) => void
  arrangeGridRef?: React.MutableRefObject<(() => void) | null>
  arrangeResetRef?: React.MutableRefObject<(() => void) | null>
  zoomToFitRunsRef?: React.MutableRefObject<((runIds: string[]) => void) | null>
  panToRunsRef?: React.MutableRefObject<((runIds: string[]) => void) | null>
}

/** Extract entity type and ID from a tree node ID like "initiative-abc123" */
function parseNodeId(nodeId: string): { type: string; entityId: string } | null {
  const dash = nodeId.indexOf('-')
  if (dash === -1) return null
  return { type: nodeId.slice(0, dash), entityId: nodeId.slice(dash + 1) }
}

/** Find a node's label by its ID in the tree */
function findNodeLabel(nodes: TreeNode[], targetId: string): string | null {
  for (const node of nodes) {
    if (node.id === targetId) return node.label
    if (node.children.length > 0) {
      const found = findNodeLabel(node.children, targetId)
      if (found) return found
    }
  }
  return null
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
 */
function computeTreemapLayouts(
  nodes: TreeNode[],
  x: number, y: number, w: number, h: number,
  gap: number,
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
    const nx = x + gap + col * (cellW + gap)
    const ny = y + gap + row * (cellH + gap)
    result.set(node.id, { x: nx, y: ny, width: cellW, height: cellH })

    const isContainer = getWidgetComponent(toWidgetType(node.type))?.isContainer
    if (isContainer && node.children.length > 0 && cellW > 120 && cellH > 80) {
      const childGap = Math.max(6, Math.floor(gap * 0.6))
      const innerX = nx + TREEMAP_PAD
      const innerY = ny + TREEMAP_HEADER_H
      const innerW = cellW - TREEMAP_PAD * 2
      const innerH = cellH - TREEMAP_HEADER_H - TREEMAP_PAD
      const childLayouts = computeTreemapLayouts(node.children, innerX, innerY, innerW, innerH, childGap)
      for (const [id, layout] of childLayouts) result.set(id, layout)
    }
  }

  return result
}

/** Collect leaf node IDs that are descendants of the given selected entity node IDs */
function collectRunsUnderSelected(
  nodes: TreeNode[],
  selectedIds: Set<string>,
): string[] {
  const result: string[] = []
  for (const node of nodes) {
    if (selectedIds.has(node.id)) {
      if (!getWidgetComponent(toWidgetType(node.type))?.isContainer) {
        result.push(node.id)
      } else {
        result.push(...collectRunNodeIds(node.children))
      }
    } else {
      result.push(...collectRunsUnderSelected(node.children, selectedIds))
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

export function InfiniteCanvas({ tree, runMap, editorWidgetMap = new Map(), focusRunId, activeSpaceId, onFocusHandled, onSelectRun, onFocusRun, onDeleteEntity, onMenuOpen, onTaskUpdate, arrangeGridRef, arrangeResetRef, zoomToFitRunsRef, panToRunsRef }: Props) {
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

  // All run node IDs for marquee intersection
  const runNodeIdsRef = useRef<string[]>([])

  // Keep parent map, depth map, and run node IDs in sync with tree
  const parentMapRef = useRef<Map<string, string | null>>(new Map())
  const depthMapRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    parentMapRef.current = buildParentMap(tree)
    depthMapRef.current = treeMaps.depthMap
    runNodeIdsRef.current = collectRunNodeIds(tree)
  }, [tree, treeMaps])

  // Center on a widget when focusRunId changes
  useEffect(() => {
    if (!focusRunId || !containerRef.current) return
    const layout = getLayout(focusRunId)
    if (!layout) return
    const rect = containerRef.current.getBoundingClientRect()
    centerOn(layout.x, layout.y, layout.width, layout.height, rect.width, rect.height)
    onFocusHandled()
  }, [focusRunId, getLayout, centerOn, onFocusHandled])

  // Attach wheel listener with { passive: false }
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => handleWheel(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [handleWheel])

  /** Convert client coords to canvas coords */
  const clientToCanvas = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current
    if (!el) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    return {
      x: (clientX - rect.left - camera.x) / camera.zoom,
      y: (clientY - rect.top - camera.y) / camera.zoom,
    }
  }, [camera])

  // --- Pointer handlers: pan OR marquee ---
  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (spaceHeld.current || e.button === 1) {
        // Space held or middle-click = pan
        e.preventDefault()
        startPan(e.nativeEvent)
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
    endPan()
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

    const layouts = computeTreemapLayouts(rootNodes, vx, vy, vw, vh, 20)
    batchSetLayouts(layouts)
  }, [camera, selectionState, tree, batchSetLayouts])

  // Expose arrange functions to parent via refs
  useEffect(() => {
    if (arrangeGridRef) arrangeGridRef.current = arrangeGrid
    return () => { if (arrangeGridRef) arrangeGridRef.current = null }
  }, [arrangeGridRef, arrangeGrid])

  useEffect(() => {
    if (arrangeResetRef) arrangeResetRef.current = arrangeWorkspace
    return () => { if (arrangeResetRef) arrangeResetRef.current = null }
  }, [arrangeResetRef, arrangeWorkspace])

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

  // zoomToFitRuns: compute bounding box and zoom-to-fit with 40px margin
  const zoomToFitRuns = useCallback((runIds: string[]) => {
    const el = containerRef.current
    if (!el) return
    const box = getBoundingBox(runIds)
    if (!box) return
    const rect = el.getBoundingClientRect()
    centerOn(box.x, box.y, box.w, box.h, rect.width, rect.height)
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

  // Hotgroup context and canvas hotkeys
  const hotgroups = useHotgroupContext()

  useCanvasHotkeys({
    onHotgroupSelect: (slot, isDoubleTap) => {
      // hotgroups stores raw run IDs (e.g. 'R-241'), layouts keys are node IDs ('run-R-241')
      const nodeIds = hotgroups.runsInSlot(slot).map(id => `run-${id}`).filter(id => layouts.has(id))
      if (nodeIds.length === 0) return
      selectMany(nodeIds, 'run')
      // Expand all ancestors in sidebar so the runs become visible
      const ancestorIds: string[] = []
      for (const nodeId of nodeIds) {
        let cur = parentMapRef.current.get(nodeId) ?? null
        while (cur) {
          ancestorIds.push(cur)
          cur = parentMapRef.current.get(cur) ?? null
        }
      }
      if (ancestorIds.length > 0) expandAll(ancestorIds)
      if (isDoubleTap) {
        zoomToFitRuns(nodeIds)
      } else {
        panToRuns(nodeIds)
      }
    },
    onHotgroupAssign: (slot) => {
      if (selectionState.selectedType !== 'run') return
      for (const nodeId of selectionState.selectedIds) {
        const runId = nodeId.startsWith('run-') ? nodeId.slice(4) : nodeId
        hotgroups.assign(slot, runId)
      }
    },
    onHotgroupRemove: (slot) => {
      if (selectionState.selectedType !== 'run') return
      for (const nodeId of selectionState.selectedIds) {
        const runId = nodeId.startsWith('run-') ? nodeId.slice(4) : nodeId
        hotgroups.remove(slot, runId)
      }
    },
    onArrangeGrid: () => arrangeGridRef?.current?.(),
    onArrangeReset: () => arrangeResetRef?.current?.(),
  })

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
    } else if (!nodeId.startsWith('editor-')) {
      // Group container click — select it in the shared selection state so hierarchy highlights too
      // (file-editor widgets do not participate in hierarchy selection)
      const parsed = parseNodeId(nodeId)
      if (parsed) {
        const t = parsed.type as import('../domain/types').GroupingDimension
        additive ? toggleSelect(nodeId, t) : select(nodeId, t)
      }
    }
  }, [onSelectRun, select, toggleSelect])

  const handleDoubleClickZoom = useCallback((nodeId: string) => {
    if (onFocusRun && nodeId.startsWith('run-')) {
      onFocusRun(nodeId.slice(4))
    }
  }, [onFocusRun])

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
      const run = [...runMap.values()].find(r => r.sessionId === sessionId)
      const sourceLayout = run ? layouts.get('run-' + run.id) : undefined
      let spawnLayout: { x: number; y: number; width: number; height: number }
      if (sourceLayout) {
        spawnLayout = {
          x: sourceLayout.x + sourceLayout.width + 16,
          y: sourceLayout.y,
          width: 640,
          height: 480,
        }
      } else {
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

  // Recursive render: groups render behind their children (natural DOM order)
  function renderNode(node: TreeNode, depth: number): React.ReactNode {
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
        isDimmed={selectionState.selectedIds.size > 0 && selectionState.selectedType === 'run' && !isSelected(node.id)}
        spaceHeldRef={spaceHeld}
        onSelect={handleSelect}
        onDoubleClickZoom={node.type === 'run' ? handleDoubleClickZoom : undefined}
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
      className="w-full h-full overflow-hidden relative outline-none"
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
      onDragOver={(e) => { e.preventDefault() }}
      onDrop={handleDrop}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('application/tinstar-editor')) {
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
      data-testid="infinite-canvas"
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
          transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
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
