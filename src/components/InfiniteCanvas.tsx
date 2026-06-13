import { useRef, useEffect, useCallback, useState, useMemo, Fragment, type PointerEvent as ReactPointerEvent } from 'react'
import type { BrowserWidget, EditorWidget, ImageWidget, PluginWidgetInstance, Run, TreeNode, GroupingDimension } from '../domain/types'
import { findNodeLabel } from '../domain/view-models'
import { CanvasContextMenu } from './CanvasContextMenu'
import { buildMoveTargets } from '../domain/moveTargets'
import { relocateWidgetTo } from '../domain/relocateWidget'
import { useCanvasCamera } from '../hooks/useCanvasCamera'
import { useWidgetLayouts, preserveCohesion, MIN_WIDTH, MIN_HEIGHT } from '../hooks/useWidgetLayouts'
import { useSelection } from './SelectionProvider'
import { CanvasWidgetShell } from '../widgets/CanvasWidgetShell'
import { getWidgetComponent, toWidgetType, isSnappable } from '../widgets/widgetComponentRegistry'
import { useConfig } from '../context/ConfigContext'
import {
  DEFAULT_WIDGET_SIZE_PRESETS,
  computePresetSize,
  resolveAspect,
  resolvePresetSizes,
  matchPreset,
  type SizePreset,
} from '../widgets/widgetSizePresets'
import { resolveRunViewType } from '../domain/runView'
import type { GroupWidgetData } from '../widgets/widgetComponentRegistry'
import { useCanvasHotkeys } from '../hotkeys/useCanvasHotkeys'
import { useConstellationContext } from '../hotkeys/ConstellationContext'
import type { ConstellationSlot } from '../domain/constellationGraph'
import { applyAssign, nextFreeSlot } from '../hooks/useConstellationGraph'
import { addSnap, planBreak, addMember, removeMember, removeSnap } from '../domain/constellationGraph'
import { registerCanvasActions } from '../hotkeys/canvasActionsRegistry'
import { EmptyCanvasHint } from './EmptyCanvasHint'
import { PluginWidgetDisabledPlaceholder } from './PluginWidgetDisabledPlaceholder'
import { getOrCreatePluginChromeWrapper } from './PluginWidgetChrome'
import { CanvasSidebar } from './CanvasSidebar/CanvasSidebar'
import { apiFetch } from '../apiClient'
import { usePinSet } from '../hooks/usePinSet'
import type { Pin } from '../domain/pinSet'
import { resolveBackingSession } from '../canvas/resolveBackingSession'
import { EV } from '../lib/windowEvents'
import { ConstellationChrome } from '../canvas/ConstellationChrome'
import type { Rect, IdRect } from '../canvas/constellationCohesion'
import { applyGroupDrag, boundingBoxOf, fitToRect, occupiedEdgesOf } from '../canvas/constellationCohesion'
import { tidyGridClusters } from '../canvas/tidyArrange'
import { clusterGroups } from '../canvas/clusterize'
import type { DragMember } from '../canvas/constellationCohesion'
import { reflowOnResize, type ReflowRect, type ReflowMember } from '../canvas/resizeReflow'

/** Shared empty set so unsnapped widgets reuse one reference (all four [+] edges shown). */
const EMPTY_EDGES: ReadonlySet<SnapEdge> = new Set()

/** Unique pin id, mirroring the browser's note-id style (`note-<ts36>-<rand>`). */
const makePinId = (): string => `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
import { SnapZoneOverlay } from '../canvas/SnapZoneOverlay'
import { resolveSnapTarget, revalidateSnapTarget, resolveSnapCommit, snapMembership } from '../canvas/snapZoneResolver'
import type { SnapWidget, SnapTarget, SnapEdge } from '../canvas/snapZoneResolver'
import { AddWidgetPicker } from './AddWidgetPicker'
import { useWidgetCatalog } from '../hooks/useWidgetCatalog'
import { useAddWidget } from '../hooks/useAddWidget'
import { composeAddWidgetMembership } from '../canvas/addWidgetMembership'
import type { WidgetLayout } from '../hooks/useWidgetLayouts'
import { RunNodeCapabilities } from './RunNodeCapabilities'

interface Props {
  tree: TreeNode[]
  runMap: Map<string, Run>
  editorWidgetMap?: Map<string, EditorWidget>
  browserWidgetMap?: Map<string, BrowserWidget>
  imageWidgetMap?: Map<string, ImageWidget>
  pluginWidgetMap?: Map<string, PluginWidgetInstance>
  onPluginWidgetCreated?: (instance: PluginWidgetInstance) => void
  onImageWidgetCreated?: (widget: ImageWidget) => void
  focusRunId: string | null
  activeSpaceId?: string
  onFocusHandled: () => void
  onSelectRun?: (runId: string, additive: boolean) => void
  onFocusRun?: (runId: string) => void
  onDeleteEntity?: (entityId: string, type: string) => void
  onMenuOpen?: (entityId: string, entityType: GroupingDimension, entityName: string, anchorRect: DOMRect) => void
  /** Open the session create dialog for a session-backed add-widget; calls back with the created sessionId. */
  onRequestCreateSession?: (prefill: { taskId?: string; view?: string }, onCreated: (sessionId: string) => void) => void
  onTaskUpdate?: (taskId: string, patch: { externalUrl?: string | null }) => void
  onEditorWidgetCreated?: (widget: EditorWidget) => void
  onBrowserWidgetCreated?: (widget: BrowserWidget) => void
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

/** Collect all snappable leaf node IDs from a tree (the drag-to-snap set). */
function collectSnappableLeafIds(nodes: TreeNode[]): string[] {
  const result: string[] = []
  for (const node of nodes) {
    const hasChildren = Array.isArray(node.children) && node.children.length > 0
    if (hasChildren) {
      result.push(...collectSnappableLeafIds(node.children))
      continue
    }
    // Leaf node: snappable unless its (present) registration opts out / is a container.
    // isSnappable fails open for a missing registration (the spawn race). Empty
    // containers CAN reach here as leaves (filterEmptyNodes is conditional on
    // showEmptyEntities, and hidden-run pruning can empty a container afterward) —
    // but every host container type registers with isContainer:true, so isSnappable
    // rejects them via the registration check. Fail-open therefore only admits
    // genuinely unregistered (spawn-race) widget types, which are never host containers.
    if (isSnappable(getWidgetComponent(toWidgetType(node.type)))) result.push(node.id)
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
// Snap-zone snap distance (canvas units)
const SNAP_DISTANCE = 60

// Build the richest available descriptor for any pin shape (native capture or
// browser flat blob). Exported for unit testing; used in the batched send-all
// prompt so each bullet carries meaningful context rather than bare coordinates.
export function describePinSpot(p: Pin): string {
  const c = p.context as { capture?: { label?: string }; url?: string; target?: { text?: string; imageAlt?: string; tag?: string } } | undefined
  if (c?.capture?.label) return c.capture.label
  if (c?.url) {
    const el = c.target?.text || c.target?.imageAlt || c.target?.tag
    return el ? `${el} — ${c.url}` : c.url
  }
  return `${Math.round(p.nx * 100)}%,${Math.round(p.ny * 100)}%`
}

/** Floor a widget's own minSize to the global layout floor that updateRunSize
 *  actually enforces, so preset sizes (and the active-state match) agree with
 *  what gets stored. */
function effectiveMinSize(min: { width: number; height: number }) {
  return { width: Math.max(MIN_WIDTH, min.width), height: Math.max(MIN_HEIGHT, min.height) }
}

export function InfiniteCanvas({ tree, runMap, editorWidgetMap = new Map(), browserWidgetMap = new Map(), imageWidgetMap = new Map(), pluginWidgetMap = new Map(), focusRunId, activeSpaceId, onFocusHandled, onSelectRun, onFocusRun, onDeleteEntity, onMenuOpen, onRequestCreateSession, onTaskUpdate, onEditorWidgetCreated, onBrowserWidgetCreated, onImageWidgetCreated, onPluginWidgetCreated, arrangeGridRef, arrangeResetRef, arrangeSwimlanesRef, zoomToFitRunsRef, panToRunsRef, forceMarshalOpen }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Seed initial placement for browser widgets opened via the host placement API
  // (POST/PATCH /api/browser-widgets with position/nearNodeId), and for file-editor
  // widgets snapped to their session on create (POST /api/editor-widgets). Consulted
  // by the layout hook only for nodes that don't have a layout yet.
  const placementSeed = useMemo(() => {
    const seed = new Map<string, import('../hooks/useWidgetLayouts').WidgetLayout>()
    for (const w of browserWidgetMap.values()) {
      if (w.position) {
        seed.set(w.id, {
          x: w.position.x,
          y: w.position.y,
          width: w.size?.width ?? 800,
          height: w.size?.height ?? 600,
        })
      }
    }
    for (const w of editorWidgetMap.values()) {
      if (w.position) {
        seed.set(w.id, {
          x: w.position.x,
          y: w.position.y,
          width: w.size?.width ?? 640,
          height: w.size?.height ?? 480,
        })
      }
    }
    return seed
  }, [browserWidgetMap, editorWidgetMap])
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
  } = useWidgetLayouts(tree, activeSpaceId, placementSeed)
  const { camera, setCamera, cursorStyle, spaceHeld, handleWheel, startPan, movePan, endPan, centerOn } = useCanvasCamera()
  const appConfig = useConfig()
  const sizePresets = appConfig?.ui.widgetSizePresets ?? DEFAULT_WIDGET_SIZE_PRESETS
  const { select, toggleSelect, selectMany, deselect, isSelected, state: selectionState } = useSelection()

  // Container size tracked via ResizeObserver — avoids getBoundingClientRect in the render body
  // (which forces a layout flush on every render, including 60fps pan).
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setContainerSize({ width: r.width, height: r.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Drag state
  const draggingRunRef = useRef<string | null>(null)
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  // Snap-zone drag state: tracks dragged widget's current rect for overlay + drop resolution
  // Magnetic snap: the widget the current drag would join, with the flush position to land at.
  // Mirrored into a ref so drag-end (a stable callback) reads the latest without re-subscribing.
  const [snapPreview, setSnapPreview] = useState<SnapTarget | null>(null)
  const snapPreviewRef = useRef<SnapTarget | null>(null)
  const draggedSnapRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const lastUnsnappedDragPositionRef = useRef<{ x: number; y: number } | null>(null)

  // Safety net for the iframe-pointer guard ([data-dragging] in the CSS): the
  // normal drag-end path clears draggingNodeId, but a shell Escape-cancel does
  // NOT call onDragEnd, so without this the guard could stick and freeze iframes.
  // Clear on Escape (immediately) and on any pointer release (idempotent on the
  // normal path, which already nulled it). UI-only — never affects snap commit.
  useEffect(() => {
    const clear = () => setDraggingNodeId(prev => (prev === null ? prev : null))
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clear() }
    window.addEventListener('pointerup', clear)
    window.addEventListener('pointercancel', clear)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerup', clear)
      window.removeEventListener('pointercancel', clear)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // File-drag overlay: shows a full-canvas drop target when a tinstar-editor drag enters,
  // so the terminal iframe doesn't swallow the drop
  const [editorDragActive, setEditorDragActive] = useState(false)
  const dragEnterCountRef = useRef(0)

  // Multi-drag: snapshot of other selected widgets' positions at drag start
  const multiDragSnapshot = useRef<Map<string, { x: number; y: number }> | null>(null)

  // Constellation group-drag: snapshot of ALL members' start positions (including dragged widget)
  const constellationDragSnapshot = useRef<Map<string, { x: number; y: number }> | null>(null)
  // Which constellation slot the current drag belongs to (null = no constellation drag)
  const constellationDragSlot = useRef<import('../domain/constellationGraph').ConstellationSlot | null>(null)
  // Whether alt was held at drag-start (triggers pop-out on drag-end)
  const altHeldAtDragStart = useRef(false)

  // Marquee state
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null)
  const marqueeRef = useRef<{ startX: number; startY: number; active: boolean }>({ startX: 0, startY: 0, active: false })
  // Tracks whether the current pointer-down actually landed on empty canvas (not a widget)
  const canvasPointerDownRef = useRef(false)

  const minimapToggleRef = useRef<(() => void) | null>(null)
  const hudToggleRef = useRef<(() => void) | null>(null)

  // All snappable leaf node IDs (drag-to-snap + marquee intersection set)
  const snappableLeafIdsRef = useRef<string[]>([])

  // Spawn animation: track which snappable leaf node IDs are newly created (not present on initial load)
  const seenRunNodeIdsRef = useRef<Set<string> | null>(null)
  const [spawnedNodeIds, setSpawnedNodeIds] = useState<Set<string>>(new Set())

  // Keep parent map, depth map, and snappable leaf node IDs in sync with tree
  const parentMapRef = useRef<Map<string, string | null>>(new Map())
  const depthMapRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    parentMapRef.current = buildParentMap(tree)
    depthMapRef.current = treeMaps.depthMap
    snappableLeafIdsRef.current = collectSnappableLeafIds(tree)

    const leafIds = snappableLeafIdsRef.current
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

  // Listen for widget:flash-focus — pan to, flash, and (for runs) focus a widget by id.
  // Dispatched by `dispatchFlashFocus` (see src/canvas/flashAndFocus.ts), used by the inbox.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ widgetId: string; source: 'run' | 'plugin' }>).detail
      if (!detail) return
      const { widgetId, source } = detail

      // Build nodeId for layout lookup. Runs are stored with the `run-` prefix in the layouts map;
      // plugin widgets use their bare id.
      const nodeId = source === 'run' ? `run-${widgetId}` : widgetId
      const layout = getLayout(nodeId)
      if (!layout) return

      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return

      // Pan + light zoom-to-fit at current zoom-ish; use centerOn for consistency.
      centerOn(layout.x, layout.y, layout.width, layout.height, rect.width, rect.height, 80)

      // Flash: add a CSS class to the widget's DOM element for ~700ms.
      const el = document.querySelector(`[data-widget-id="${CSS.escape(widgetId)}"]`) as HTMLElement | null
      if (el) {
        el.classList.add('widget-flash')
        window.setTimeout(() => el.classList.remove('widget-flash'), 700)
      }

      // Focus path — forward to onFocusRun for runs (existing behavior), otherwise nothing extra.
      if (source === 'run' && onFocusRun) {
        onFocusRun(widgetId)
      }
    }
    window.addEventListener('widget:flash-focus', handler as EventListener)
    return () => window.removeEventListener('widget:flash-focus', handler as EventListener)
  }, [getLayout, centerOn, onFocusRun])

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
          for (const nodeId of snappableLeafIdsRef.current) {
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
        // Plain click on empty canvas = deselect all and clear active constellation
        deselect()
        setActiveConstellationSlot(null)
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

  // Track alt key state globally so drag-start can read it even though onDragStart
  // receives only nodeId (no pointer event). Use a ref so it doesn't cause re-renders.
  const altKeyRef = useRef(false)
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => { if (e.key === 'Alt') altKeyRef.current = true }
    const onUp = (e: KeyboardEvent) => { if (e.key === 'Alt') altKeyRef.current = false }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  // Constellation chrome: active slot driven by digit hotkey
  const [activeConstellationSlot, setActiveConstellationSlot] = useState<ConstellationSlot | null>(null)

  // Focused widget for digit-hotkey cycle bookkeeping (not wired to rendering in this PR)
  const [focusedWidgetId, setFocusedWidgetId] = useState<string | null>(null)

  // Constellation context — must be declared before widget drag callbacks that reference it
  const constellations = useConstellationContext()

  // ── Pins ──────────────────────────────────────────────────────────────────
  // Universal per-node canvas pins (one PinSet per space). The iframe pointer
  // guard is raised during place/reposition drags so dragging over browser/
  // terminal iframe widgets doesn't swallow the pointer stream.
  const pinSet = usePinSet(activeSpaceId ?? '')
  const [pinDragging, setPinDragging] = useState(false)
  const pinCtx = useMemo(
    () => ({ slotsForNode: constellations.slotsForNode, nodesInSlot: constellations.nodesInSlot }),
    [constellations.slotsForNode, constellations.nodesInSlot],
  )

  const submitPin = useCallback(
    async (pinId: string, nodeId: string, freshComment: string) => {
      const pin = pinSet.set.pins.find(p => p.id === pinId)
      if (!pin) return
      const sessionId = resolveBackingSession(nodeId, pinCtx)
      if (!sessionId) return // button is disabled in this state; guard anyway
      const label = findNodeLabel(tree, nodeId) ?? nodeId
      // Use the FRESH comment from the bubble draft, not pin.comment — the store
      // update is async and pin.comment still holds the pre-edit value this tick.
      const comment = freshComment || '(no comment)'
      // Native-widget pins carry a semantic capture of what was under the marker
      // (browser pins use their own richer format via formatBrowserPin instead).
      const captureLabel = (pin.context?.capture as { label?: string } | undefined)?.label
      const prompt = captureLabel
        ? `📍 Pinned on ${label} — on "${captureLabel}" — ${comment}`
        : `📍 Pinned on ${label} — ${comment}`
      try {
        const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/enter-prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        })
        const body = await res.json().catch(() => null) as { ok?: boolean; error?: { message?: string } } | null
        if (!res.ok || body?.ok === false) throw new Error(body?.error?.message || `HTTP ${res.status}`)
        pinSet.update(pinId, p => ({ ...p, comment: freshComment, sentAt: Date.now() }))
      } catch (err) {
        console.warn('[pins] submit failed:', err)
      }
    },
    [pinSet, pinCtx, tree],
  )

  // Batch-submit every UNSENT pin on a node as one prompt, then mark them all sent.
  const sendAllPins = useCallback(
    async (nodeId: string) => {
      const sessionId = resolveBackingSession(nodeId, pinCtx)
      if (!sessionId) return // button is disabled in this state; guard anyway
      const widgetPins = pinSet.forNode(nodeId).filter(p => !p.sentAt)
      if (widgetPins.length === 0) return
      const label = findNodeLabel(tree, nodeId) ?? nodeId
      const bullets = widgetPins.map(p =>
        `• on "${describePinSpot(p)}" — ${p.comment || '(no comment)'}`
      ).join('\n')
      const prompt = `📍 ${widgetPins.length} pins on ${label}:\n${bullets}`
      try {
        const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/enter-prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        })
        const body = await res.json().catch(() => null) as { ok?: boolean; error?: { message?: string } } | null
        if (!res.ok || body?.ok === false) throw new Error(body?.error?.message || `HTTP ${res.status}`)
        for (const p of widgetPins) pinSet.update(p.id, x => ({ ...x, sentAt: Date.now() }))
      } catch (err) {
        console.warn('[pins] send-all failed:', err)
      }
    },
    [pinSet, pinCtx, tree],
  )

  // Remove every pin on a node (no confirm — matches the original toolbar's clear-all).
  const clearAllPins = useCallback(
    (nodeId: string) => {
      pinSet.clearNode(nodeId)
    },
    [pinSet],
  )

  // ── Add-widget picker + orchestrator ──────────────────────────────────────
  const { entries: catalog } = useWidgetCatalog()
  const [addPicker, setAddPicker] = useState<{ sourceNodeId: string; edge: SnapEdge; anchor: { x: number; y: number } } | null>(null)
  // Smart default: from a saloon you most likely add a run; from a run you most
  // likely add a browser. Falls back to GLOBAL_DEFAULT for everything else.
  const DEFAULT_FOR: Record<string, string> = { 'saloon': 'run-workspace', 'run-workspace': 'browser-widget' }
  const GLOBAL_DEFAULT = 'run-workspace'

  // nodeId → widget type, used to resolve the picker's smart default.
  const nodeTypeById = useMemo(() => {
    const map = new Map<string, string>()
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) { map.set(n.id, n.type); walk(n.children) }
    }
    walk(tree)
    return map
  }, [tree])

  // ── Right-click "Move widget here" context menu ───────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null)

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Empty-space only: right-click on a widget falls through to the native /
    // future per-widget menu (do NOT preventDefault before this guard).
    if ((e.target as HTMLElement).closest('[data-widget-id]')) return
    e.preventDefault()
    // Screen→canvas conversion — verbatim from handleDrop's drop-point math.
    const rect = containerRef.current!.getBoundingClientRect()
    const canvasX = Math.round((e.clientX - rect.left - camera.x) / camera.zoom)
    const canvasY = Math.round((e.clientY - rect.top - camera.y) / camera.zoom)
    setCtxMenu({ x: e.clientX, y: e.clientY, canvasX, canvasY })
  }, [camera.x, camera.y, camera.zoom])

  const moveTargets = useMemo(
    () => buildMoveTargets(tree, layouts, {
      isContainer: (id) => !!getWidgetComponent(toWidgetType(nodeTypeById.get(id) ?? ''))?.isContainer,
      labelOf: (id) => findNodeLabel(tree, id) ?? id,
      slotsOf: (id) => constellations.slotsForNode(id).map(Number).filter((n) => !Number.isNaN(n)),
    }),
    [tree, layouts, nodeTypeById, constellations],
  )

  const relocateWidget = useCallback((id: string) => {
    if (!ctxMenu) return
    relocateWidgetTo(id, { x: ctxMenu.canvasX, y: ctxMenu.canvasY }, {
      getLayout, insertLayout,
      slotsForNode: constellations.slotsForNode,
      removeFromSlot: constellations.remove,
    })
    setCtxMenu(null)
  }, [ctxMenu, getLayout, insertLayout, constellations])

  // Pending run placements, keyed by sessionId. When a session-backed widget is
  // added we open the create dialog; once the resulting run appears via SSE we
  // flush its layout + snap it to the source. Node id for a run is `run-<run.id>`.
  const pendingRunPlacement = useRef<Map<string, { layout: WidgetLayout; sourceNodeId: string; spaceId: string }>>(new Map())
  const registerPendingRunPlacement = useCallback((sessionId: string, layout: WidgetLayout, sourceNodeId: string, spaceId: string) => {
    pendingRunPlacement.current.set(sessionId, { layout, sourceNodeId, spaceId })
  }, [])
  useEffect(() => {
    if (pendingRunPlacement.current.size === 0) return
    for (const run of runMap.values()) {
      const pend = pendingRunPlacement.current.get(run.sessionId)
      if (!pend) continue
      // Only apply in the space the add was initiated from. insertLayout and
      // constellations are bound to activeSpaceId, so applying here while the
      // user has navigated away would write the layout + membership (and a stale
      // sourceNodeId) into the wrong space. Leave it pending until they return.
      if (pend.spaceId !== activeSpaceId) continue
      const nodeId = `run-${run.id}`
      insertLayout(nodeId, { ...pend.layout })
      // Plan from the live graph and persist as one atomic write (see useAddWidget).
      constellations.update(g => composeAddWidgetMembership(g, pend.sourceNodeId, nodeId))
      pendingRunPlacement.current.delete(run.sessionId)
    }
  }, [runMap, insertLayout, constellations, activeSpaceId])

  // Promise wrapper around the host's session create dialog. Resolves with the
  // created sessionId; if the dialog is cancelled `onCreated` never fires and the
  // promise simply never resolves — acceptable here since the only deferred side
  // effect is registering a pending placement (nothing leaks). No timers.
  const openCreateSession = useCallback((prefill: { spaceId: string; view?: string }) => {
    return new Promise<string | null>((resolve) => {
      if (!onRequestCreateSession) { resolve(null); return }
      onRequestCreateSession(prefill.view ? { view: prefill.view } : {}, (sessionId) => resolve(sessionId))
    })
  }, [onRequestCreateSession])

  const addWidget = useAddWidget({
    spaceId: activeSpaceId ?? '',
    getLayout,
    insertLayout,
    updateConstellation: constellations.update,
    openCreateSession,
    registerPendingRunPlacement,
  })

  // Edges of a node that already abut a snapped constellation neighbor (where a break-link
  // chip sits) — the add-widget [+] is suppressed there so it only shows on exposed edges.
  const occupiedEdgesFor = useCallback((nodeId: string): ReadonlySet<SnapEdge> => {
    const slots = constellations.slotsForNode(nodeId)
    if (slots.length === 0) return EMPTY_EDGES
    const target = getLayout(nodeId)
    if (!target) return EMPTY_EDGES
    const memberIds = new Set<string>()
    for (const s of slots) for (const m of constellations.nodesInSlot(s)) memberIds.add(m)
    const others: IdRect[] = []
    for (const id of memberIds) {
      if (id === nodeId) continue
      const l = getLayout(id)
      if (l) others.push({ id, x: l.x, y: l.y, width: l.width, height: l.height })
    }
    if (others.length === 0) return EMPTY_EDGES
    return occupiedEdgesOf({ id: nodeId, x: target.x, y: target.y, width: target.width, height: target.height }, others)
  }, [constellations, getLayout])

  // Memoized inverted index: nodeId → slot (first slot only) and occupied slot set
  const slotByNode = useMemo(() => {
    const map = new Map<string, import('../domain/constellationGraph').ConstellationSlot>()
    for (const [slot, nodeIds] of Object.entries(constellations.store) as [import('../domain/constellationGraph').ConstellationSlot, string[]][]) {
      for (const id of nodeIds) {
        if (!map.has(id)) map.set(id, slot)
      }
    }
    return map
  }, [constellations.store])

  const occupiedSlots = useMemo(() => {
    const set = new Set<import('../domain/constellationGraph').ConstellationSlot>()
    for (const [slot, nodeIds] of Object.entries(constellations.store) as [import('../domain/constellationGraph').ConstellationSlot, string[]][]) {
      if (nodeIds.length > 0) set.add(slot)
    }
    return set
  }, [constellations.store])

  const collectSnapNeighbors = useCallback((nodeId: string): SnapWidget[] => {
    // Magnetic snap only targets work widgets (runs, plugin widgets, editors, browsers, …) —
    // never grouping containers (Initiative/Epic/Task). snappableLeafIdsRef holds exactly the
    // snappable leaf nodes (see collectSnappableLeafIds), so filter neighbors to that set.
    const leafIds = new Set(snappableLeafIdsRef.current)
    const neighbors: SnapWidget[] = []
    for (const [id, l] of layouts) {
      if (id === nodeId || !leafIds.has(id)) continue
      neighbors.push({ id, x: l.x, y: l.y, width: l.width, height: l.height })
    }
    return neighbors
  }, [layouts])

  // Widget drag callbacks
  // Resize re-snap: snapshot the resized widget + its constellation co-members at resize-start,
  // then on resize-end shift members flush against the new size (push when grown, pull when
  // shrunk). Overlap/gaps during the drag are intentional — only the end state re-snaps.
  const resizeReflowSnapshot = useRef<{ nodeId: string; start: ReflowRect; members: ReflowMember[] } | null>(null)

  const handleResizeStart = useCallback((nodeId: string) => {
    const slot = constellations.slotsForNode(nodeId)[0]
    const l = getLayout(nodeId)
    if (!slot || !l) { resizeReflowSnapshot.current = null; return }
    const members: ReflowMember[] = []
    for (const id of constellations.nodesInSlot(slot)) {
      if (id === nodeId) continue
      const ml = getLayout(id)
      if (ml) members.push({ id, x: ml.x, y: ml.y, width: ml.width, height: ml.height })
    }
    resizeReflowSnapshot.current = { nodeId, start: { x: l.x, y: l.y, width: l.width, height: l.height }, members }
  }, [constellations, getLayout])

  // width/height are the final dragged dimensions, passed in from the shell — reading
  // them from getLayout here would risk a stale (pre-last-frame) size, since onResize
  // only queues a React state update.
  const handleResizeEnd = useCallback((nodeId: string, width: number, height: number) => {
    const snap = resizeReflowSnapshot.current
    resizeReflowSnapshot.current = null
    if (!snap || snap.nodeId !== nodeId) return
    const moves = reflowOnResize({ start: snap.start, final: { width, height }, members: snap.members })
    for (const [id, pos] of moves) updateRunPosition(id, pos.x, pos.y)
  }, [updateRunPosition])

  /** Resize a widget to an S/M/L preset: viewport-relative size, per-type aspect,
   *  applied through the same resize path a drag uses (persist + cascade + re-snap). */
  const applySizePreset = useCallback(
    (nodeId: string, widgetType: string, preset: SizePreset) => {
      const el = containerRef.current
      const layout = getLayout(nodeId)
      if (!el || !layout) return
      const rect = el.getBoundingClientRect()
      const viewport = { width: rect.width / camera.zoom, height: rect.height / camera.zoom }

      const reg = getWidgetComponent(widgetType)
      const minSize = effectiveMinSize(reg?.minSize ?? { width: MIN_WIDTH, height: MIN_HEIGHT })
      const aspect = resolveAspect(sizePresets, widgetType)
      const size = computePresetSize(viewport, sizePresets[preset], aspect, minSize)

      const resize = reg?.isContainer ? resizeNode : updateRunSize
      // Mirror a drag-resize gesture so the constellation re-settles identically.
      handleResizeStart(nodeId)
      resize(nodeId, size.width, size.height)
      handleResizeEnd(nodeId, size.width, size.height)

      // Keep the widget within the visible viewport (top-left anchored).
      // Skip for constellation members: handleResizeEnd already reflowed them
      // relative to the anchor's original position — nudging the anchor afterward
      // would desync the other members.
      const inConstellation = constellations.slotsForNode(nodeId).length > 0
      if (!inConstellation) {
        const vx = -camera.x / camera.zoom
        const vy = -camera.y / camera.zoom
        let nx = layout.x
        let ny = layout.y
        if (nx + size.width > vx + viewport.width) nx = Math.max(vx, vx + viewport.width - size.width)
        if (ny + size.height > vy + viewport.height) ny = Math.max(vy, vy + viewport.height - size.height)
        if (Math.round(nx) !== layout.x || Math.round(ny) !== layout.y) {
          updateRunPosition(nodeId, Math.round(nx), Math.round(ny))
        }
      }
    },
    [camera, sizePresets, resizeNode, updateRunSize, updateRunPosition, getLayout, handleResizeStart, handleResizeEnd, constellations],
  )

  const handleWidgetDragStart = useCallback((nodeId: string) => {
    draggingRunRef.current = nodeId
    setDraggingNodeId(nodeId)

    // Reset any prior snap preview; it's recomputed live as the drag moves.
    snapPreviewRef.current = null
    draggedSnapRectRef.current = null
    lastUnsnappedDragPositionRef.current = null
    setSnapPreview(null)

    // Snapshot alt-key state at drag-start for pop-out decision at drag-end
    altHeldAtDragStart.current = altKeyRef.current

    // Constellation group-drag: if the widget is in a constellation and alt is NOT held,
    // capture start positions for all members so we can move them as one.
    const slot = constellations.slotsForNode(nodeId)[0] ?? null
    if (slot && !altKeyRef.current) {
      constellationDragSlot.current = slot
      const memberIds = constellations.nodesInSlot(slot)
      const snap = new Map<string, { x: number; y: number }>()
      for (const memberId of memberIds) {
        const layout = layouts.get(memberId)
        if (layout) snap.set(memberId, { x: layout.x, y: layout.y })
      }
      constellationDragSnapshot.current = snap
    } else {
      constellationDragSlot.current = null
      constellationDragSnapshot.current = null
    }

    if (isSelected(nodeId)) {
      const snap = new Map<string, { x: number; y: number }>()
      for (const leafId of snappableLeafIdsRef.current) {
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
  }, [isSelected, layouts, constellations])

  const handleWidgetDragEnd = useCallback((nodeId: string) => {
    // Alt-pop-out: if alt was held at drag-start, remove the widget from its constellation slot
    const slot = constellationDragSlot.current
    if (slot && altHeldAtDragStart.current) {
      constellations.remove(slot, nodeId)
      // Dispatch flourish event so the sidebar row flashes
      window.dispatchEvent(new CustomEvent('constellation:flourish', { detail: { nodeId } }))
    }

    // Magnetic snap committed: the widget already sits flush (set during move). Now join the
    // target's constellation — or form a new one with it. Only when alt wasn't held and the
    // dragged widget isn't already grouped.
    const preview = snapPreviewRef.current
    const isUngrouped = constellations.slotsForNode(nodeId).length === 0
    if (!altHeldAtDragStart.current && preview && isUngrouped) {
      let draggedLayout = draggedSnapRectRef.current
      if (!draggedLayout) {
        const layout = getLayout(nodeId)
        draggedLayout = layout
          ? { x: layout.x, y: layout.y, width: layout.width, height: layout.height }
          : null
      }
      const validatedPreview = draggedLayout
        ? revalidateSnapTarget(
            nodeId,
            preview,
            { x: draggedLayout.x, y: draggedLayout.y, width: draggedLayout.width, height: draggedLayout.height },
            collectSnapNeighbors(nodeId),
            SNAP_DISTANCE,
          )
        : null
      const commit = resolveSnapCommit(validatedPreview, slotByNode, occupiedSlots)
      if (commit.kind === 'join' && validatedPreview) {
        let next = applyAssign(constellations.graph, commit.slot, nodeId)
        next = addSnap(next, nodeId, validatedPreview.targetId, validatedPreview.anchors)
        constellations.applyGraph(next)
      } else if (commit.kind === 'form') {
        let next = applyAssign(constellations.graph, commit.slot, nodeId)
        next = applyAssign(next, commit.slot, commit.withId)
        next = addSnap(next, nodeId, commit.withId, validatedPreview?.anchors)
        constellations.applyGraph(next)
      } else {
        const unsnapped = lastUnsnappedDragPositionRef.current
        if (unsnapped) updateRunPosition(nodeId, unsnapped.x, unsnapped.y)
      }
    }
    snapPreviewRef.current = null
    draggedSnapRectRef.current = null
    lastUnsnappedDragPositionRef.current = null
    setSnapPreview(null)

    draggingRunRef.current = null
    setDraggingNodeId(null)
    multiDragSnapshot.current = null
    constellationDragSnapshot.current = null
    constellationDragSlot.current = null
    altHeldAtDragStart.current = false
  }, [collectSnapNeighbors, constellations, getLayout, slotByNode, occupiedSlots, updateRunPosition])

  // Multi-drag + constellation-aware move:
  // - If dragging a widget that's in a constellation (and alt was NOT held), move all members together.
  // - Otherwise fall through to the existing multi-drag / single-drag path.
  const handleMultiMove = useCallback((nodeId: string, newX: number, newY: number) => {
    const cSnap = constellationDragSnapshot.current
    if (cSnap) {
      // Group drag: compute delta from this widget's start position, apply to all members
      const origin = cSnap.get(nodeId)
      if (origin) {
        const dx = newX - origin.x
        const dy = newY - origin.y
        const members: DragMember[] = []
        for (const [memberId, pos] of cSnap) {
          members.push({ id: memberId, x: pos.x, y: pos.y })
        }
        const updated = applyGroupDrag(members, { dx, dy })
        for (const [memberId, pos] of updated) {
          updateRunPosition(memberId, pos.x, pos.y)
        }
        return
      }
    }

    // Magnetic snap: when dragging a single ungrouped widget (no alt, no multi-select), pull it
    // flush against the nearest neighbor in range. The widget itself moves to the snapped spot.
    const layout = layouts.get(nodeId)
    const isUngrouped = constellations.slotsForNode(nodeId).length === 0
    const snapEligible = !altKeyRef.current
      && !multiDragSnapshot.current
      && !!layout
      && isUngrouped
    if (!multiDragSnapshot.current && layout && isUngrouped) {
      lastUnsnappedDragPositionRef.current = { x: newX, y: newY }
    } else {
      lastUnsnappedDragPositionRef.current = null
    }
    let finalX = newX
    let finalY = newY
    let preview: SnapTarget | null = null
    if (snapEligible && layout) {
      const neighbors = collectSnapNeighbors(nodeId)
      preview = resolveSnapTarget(nodeId, { x: newX, y: newY, width: layout.width, height: layout.height }, neighbors, SNAP_DISTANCE)
      if (import.meta.env.DEV && !preview) {
        // eslint-disable-next-line no-console
        console.debug('[snap] no target', { nodeId, candidates: neighbors.length, snapDistance: SNAP_DISTANCE })
      }
      const membership = preview ? snapMembership(preview.targetId, slotByNode, occupiedSlots) : null
      if (preview && membership?.kind !== 'full-slots') {
        finalX = preview.x
        finalY = preview.y
      }
    }
    snapPreviewRef.current = preview
    draggedSnapRectRef.current = layout
      ? { x: finalX, y: finalY, width: layout.width, height: layout.height }
      : null
    setSnapPreview(preview)

    // Existing single / multi-selection drag path
    updateRunPosition(nodeId, finalX, finalY)
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
  }, [collectSnapNeighbors, updateRunPosition, layouts, constellations, slotByNode, occupiedSlots])

  // Rigid snap-clusters derived from the current layouts + snap graph. Passed to
  // preserveCohesion so each arrange path keeps snap-attached widgets as one block.
  const computeClusterGroups = useCallback(() => {
    const rects = Array.from(layouts, ([id, l]) => ({ id, x: l.x, y: l.y, width: l.width, height: l.height }))
    return clusterGroups(rects, constellations.graph)
  }, [layouts, constellations.graph])

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
    batchSetLayouts(preserveCohesion(newLayouts, layouts, computeClusterGroups()))
  }, [camera, selectionState, tree, layouts, batchSetLayouts, computeClusterGroups])

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

    if (updates.size > 0) batchSetLayouts(preserveCohesion(updates, layouts, computeClusterGroups()))
  }, [camera, tree, layouts, batchSetLayouts, computeClusterGroups])

  // Expose arrange functions to parent via refs
  useEffect(() => {
    if (arrangeGridRef) arrangeGridRef.current = arrangeGrid
    return () => { if (arrangeGridRef) arrangeGridRef.current = null }
  }, [arrangeGridRef, arrangeGrid])

  useEffect(() => {
    // Pass constellation slot members so reset keeps snapped groups (e.g. a
    // session and its attached browser) together instead of scattering them.
    if (arrangeResetRef) arrangeResetRef.current = () => arrangeWorkspace(computeClusterGroups())
    return () => { if (arrangeResetRef) arrangeResetRef.current = null }
  }, [arrangeResetRef, arrangeWorkspace, computeClusterGroups])

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

  useCanvasHotkeys({
    onConstellationNavigate: (slot: ConstellationSlot) => {
      if (activeConstellationSlot === slot) {
        // Repeat press: advance focus through members
        const memberIds = constellations.nodesInSlot(slot).filter(id => layouts.has(id))
        if (memberIds.length === 0) return
        const currentIdx = memberIds.indexOf(focusedWidgetId ?? '')
        const nextIdx = (currentIdx + 1) % memberIds.length
        setFocusedWidgetId(memberIds[nextIdx] ?? null)
      } else {
        // First press: activate, zoom-to-fit, focus primary member
        setActiveConstellationSlot(slot)
        const memberRects = constellations.nodesInSlot(slot)
          .map(id => {
            const l = layouts.get(id)
            if (!l) return null
            return { x: l.x, y: l.y, width: l.width, height: l.height } as Rect
          })
          .filter((r): r is Rect => r !== null)
        const box = boundingBoxOf(memberRects)
        if (!box) return
        const canvasRect = containerRef.current?.getBoundingClientRect()
        if (!canvasRect) return
        const newCamera = fitToRect(box, { width: canvasRect.width, height: canvasRect.height }, 40)
        setCamera(newCamera)
        // Primary member: most-recently-focused (if it's in this slot), else first
        const liveMemberIds = constellations.nodesInSlot(slot).filter(id => layouts.has(id))
        const primary = liveMemberIds.find(id => id === focusedWidgetId) ?? liveMemberIds[0]
        if (primary) setFocusedWidgetId(primary)
      }
    },
    onConstellationAssign: (slot) => {
      const { selectedType, selectedIds } = selectionState
      if (!selectedType || (selectedType !== 'run' && selectedType !== 'file-editor' && selectedType !== 'browser-widget' && selectedType !== 'image-viewer')) return
      for (const nodeId of selectedIds) {
        constellations.assign(slot, nodeId)
      }
    },
    onConstellationRemove: (slot) => {
      const { selectedType, selectedIds } = selectionState
      if (!selectedType || (selectedType !== 'run' && selectedType !== 'file-editor' && selectedType !== 'browser-widget' && selectedType !== 'image-viewer')) return
      for (const nodeId of selectedIds) {
        constellations.remove(slot, nodeId)
      }
    },
    onArrangeGrid: () => arrangeGridRef?.current?.(),
    onArrangeReset: () => arrangeResetRef?.current?.(),
    onArrangeSwimlanes: () => arrangeSwimlanesRef?.current?.(),
    onToggleMinimap: () => minimapToggleRef.current?.(),
    onToggleHud: () => hudToggleRef.current?.(),
    onConstellationZoomFit: () => {
      if (!activeConstellationSlot) return
      const memberRects = constellations.nodesInSlot(activeConstellationSlot)
        .map(id => {
          const l = layouts.get(id)
          if (!l) return null
          return { id, x: l.x, y: l.y, width: l.width, height: l.height }
        })
        .filter((r): r is { id: string; x: number; y: number; width: number; height: number } => r !== null)
      if (memberRects.length === 0) return
      const box = boundingBoxOf(memberRects)
      if (!box) return
      const canvasRect = containerRef.current?.getBoundingClientRect()
      if (!canvasRect) return
      setCamera(fitToRect(box, { width: canvasRect.width, height: canvasRect.height }, 40))
    },
    onConstellationTidy: () => {
      if (!activeConstellationSlot) return
      const memberRects = constellations.nodesInSlot(activeConstellationSlot)
        .map(id => {
          const l = layouts.get(id)
          if (!l) return null
          return { id, x: l.x, y: l.y, width: l.width, height: l.height }
        })
        .filter((r): r is { id: string; x: number; y: number; width: number; height: number } => r !== null)
      if (memberRects.length === 0) return
      const positions = tidyGridClusters(memberRects, constellations.graph, 40)
      for (const [id, p] of positions) updateRunPosition(id, p.x, p.y)
    },
    onConstellationLeave: () => {
      if (!activeConstellationSlot || !focusedWidgetId) return
      constellations.remove(activeConstellationSlot, focusedWidgetId)
      window.dispatchEvent(new CustomEvent('constellation:flourish', { detail: { nodeId: focusedWidgetId } }))
    },
    onConstellationDissolve: () => {
      if (!activeConstellationSlot) return
      const ids = constellations.nodesInSlot(activeConstellationSlot).slice()
      for (const id of ids) {
        constellations.remove(activeConstellationSlot, id)
        window.dispatchEvent(new CustomEvent('constellation:flourish', { detail: { nodeId: id } }))
      }
      setActiveConstellationSlot(null)
    },
  })

  // Plugin-API constellation actions: widgets call
  // api.constellations.fitToMine() / tidyMine() / assignToSlot(n) / leave()
  // which dispatch window CustomEvents. The host fulfills them here using
  // the same primitives as the digit/Z/Shift+Z hotkey paths above.
  useEffect(() => {
    const onFit = (e: Event) => {
      const detail = (e as CustomEvent<{ widgetId: string }>).detail
      const slot = constellations.slotsForNode(detail.widgetId)[0] as ConstellationSlot | undefined
      if (!slot) return
      setActiveConstellationSlot(slot)
      const memberRects = constellations.nodesInSlot(slot)
        .map(memberId => {
          const l = layouts.get(memberId)
          if (!l) return null
          return { id: memberId, x: l.x, y: l.y, width: l.width, height: l.height }
        })
        .filter((r): r is { id: string; x: number; y: number; width: number; height: number } => r !== null)
      const box = boundingBoxOf(memberRects)
      if (!box) return
      const canvasRect = containerRef.current?.getBoundingClientRect()
      if (!canvasRect) return
      setCamera(fitToRect(box, { width: canvasRect.width, height: canvasRect.height }, 40))
    }
    const onTidy = (e: Event) => {
      const detail = (e as CustomEvent<{ widgetId: string }>).detail
      const slot = constellations.slotsForNode(detail.widgetId)[0] as ConstellationSlot | undefined
      if (!slot) return
      const memberRects = constellations.nodesInSlot(slot)
        .map(memberId => {
          const l = layouts.get(memberId)
          if (!l) return null
          return { id: memberId, x: l.x, y: l.y, width: l.width, height: l.height }
        })
        .filter((r): r is { id: string; x: number; y: number; width: number; height: number } => r !== null)
      if (memberRects.length === 0) return
      const positions = tidyGridClusters(memberRects, constellations.graph, 40)
      for (const [posId, p] of positions) updateRunPosition(posId, p.x, p.y)
    }
    const onAssign = (e: Event) => {
      const detail = (e as CustomEvent<{ widgetId: string; slot: number }>).detail
      const slotStr = String(detail.slot) as ConstellationSlot
      constellations.assign(slotStr, detail.widgetId)
    }
    const onLeave = (e: Event) => {
      const detail = (e as CustomEvent<{ widgetId: string }>).detail
      const slot = constellations.slotsForNode(detail.widgetId)[0] as ConstellationSlot | undefined
      if (!slot) return
      constellations.remove(slot, detail.widgetId)
    }
    window.addEventListener('constellation:fit-mine', onFit)
    window.addEventListener('constellation:tidy-mine', onTidy)
    window.addEventListener('constellation:assign', onAssign)
    window.addEventListener('constellation:leave', onLeave)
    return () => {
      window.removeEventListener('constellation:fit-mine', onFit)
      window.removeEventListener('constellation:tidy-mine', onTidy)
      window.removeEventListener('constellation:assign', onAssign)
      window.removeEventListener('constellation:leave', onLeave)
    }
  }, [constellations, layouts, updateRunPosition, setCamera])

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

      const rawPluginWidget = e.dataTransfer.getData('application/tinstar-plugin-widget')
      if (rawPluginWidget) {
        const { pluginId, widgetType, defaultSize } = JSON.parse(rawPluginWidget) as {
          pluginId: string
          widgetType: string
          defaultSize: { width: number; height: number }
        }
        const spawnLayout = { x: dropX, y: dropY, width: defaultSize.width, height: defaultSize.height }
        const res = await apiFetch('/api/plugin-widgets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pluginId,
            widgetType,
            spaceId: activeSpaceId,
            position: { x: dropX, y: dropY },
            size: defaultSize,
            data: null,
          }),
        })
        const resJson = await res.json() as { ok: boolean; data?: PluginWidgetInstance }
        if (!resJson.ok || !resJson.data) {
          // Server validation rejected the spawn (unknown widget type, singleton violation, etc.).
          // The palette UI should reflect this through the SSE delta path for singletons; for
          // unknown types, the next palette load will exclude the entry. Logging only for now.
          // eslint-disable-next-line no-console
          console.warn('[canvas] plugin-widget spawn rejected:', resJson)
          return
        }
        insertLayout(resJson.data.id, spawnLayout)
        onPluginWidgetCreated?.(resJson.data)
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
    [camera, insertLayout, onEditorWidgetCreated, onBrowserWidgetCreated, onImageWidgetCreated, onPluginWidgetCreated],
  )

  // Viewport in canvas-space for preset size resolution (null until ResizeObserver fires).
  const presetViewport = containerSize
    ? { width: containerSize.width / camera.zoom, height: containerSize.height / camera.zoom }
    : null

  // Recursive render: groups render behind their children (natural DOM order)
  function renderNode(node: TreeNode, _depth: number): React.ReactNode {
    const run = node.type === 'run' ? runMap.get(node.entityId) : undefined
    const widgetType = node.type === 'run'
      ? resolveRunViewType(run ?? {}, (t) => !!getWidgetComponent(t))
      : toWidgetType(node.type)
    const reg = getWidgetComponent(widgetType)
    if (!reg) {
      // If this is a plugin widget whose type is no longer registered (plugin disabled,
      // uninstalled, or type renamed), render a host-owned placeholder instead of crashing.
      if (pluginWidgetMap.has(node.entityId)) {
        const instance = pluginWidgetMap.get(node.entityId)!
        const layout = layouts.get(node.id)
        if (!layout) return null
        return (
          <CanvasWidgetShell
            key={node.id}
            registration={{ type: node.type, component: () => <PluginWidgetDisabledPlaceholder instance={instance} reason="unknown-type" />, isContainer: false, minSize: { width: 200, height: 150 } }}
            nodeId={node.id}
            widgetId={node.entityId}
            data={instance}
            layout={layout}
            zoom={camera.zoom}
            isSelected={isSelected(node.id)}
            isFocused={focusedWidgetId === node.id}
            isSpawning={spawnedNodeIds.has(node.id)}
            spawnColor={undefined}
            isDimmed={selectionState.selectedIds.size > 0 && selectionState.selectedType === 'run' && !isSelected(node.id)}
            spaceHeldRef={spaceHeld}
            onSelect={handleSelect}
            onDoubleClickZoom={handleDoubleClickZoom}
            onMove={handleMultiMove}
            onResize={updateRunSize}
            onResizeStart={handleResizeStart}
            onResizeEnd={handleResizeEnd}
            onAddWidget={(nodeId, edge, anchor) => setAddPicker({ sourceNodeId: nodeId, edge, anchor })}
            occupiedEdges={occupiedEdgesFor(node.id)}
          />
        )
      }
      console.warn(`No widget registered for type: ${node.type}`)
      return null
    }
    const layout = layouts.get(node.id)
    if (!layout) return null

    const data: unknown =
      node.type === 'run'
        ? (widgetType === 'run-workspace'
            ? run
            : { ...(run?.viewData && typeof run.viewData === 'object' ? run.viewData as Record<string, unknown> : {}), sessionId: run?.sessionId })
        : node.type === 'file-editor'
          ? editorWidgetMap.get(node.entityId)
          : node.type === 'browser-widget'
            ? browserWidgetMap.get(node.entityId)
            : node.type === 'image-viewer'
              ? imageWidgetMap.get(node.entityId)
              : pluginWidgetMap.has(node.entityId)
                // Plugin widget: pass the instance as data. The widget's useData hook
                // reads live state from the singleton SSE store; this prop is a
                // convenience snapshot the component may optionally reference.
                ? pluginWidgetMap.get(node.entityId)
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

    // Plugin widgets get a host-owned chrome (header + close + drag handle)
    // so they're consistent with built-in widgets even when the plugin author
    // doesn't ship their own header. Per-type wrapper cache preserves
    // component identity so the inner plugin doesn't remount on parent renders.
    const isPluginWidget = pluginWidgetMap.has(node.entityId)
    const effectiveReg = isPluginWidget
      ? { ...reg, component: getOrCreatePluginChromeWrapper(reg.type, reg.component) }
      : reg

    // Any snappable leaf widget participates in constellation snap, not
    // just runs. Runs, plugin widgets, editors, browsers, images
    // all behave the same in the snap pipeline.
    const isSnapLeaf = isSnappable(reg)

    let activeSizePreset: SizePreset | null = null
    if (isSnapLeaf && presetViewport) {
      const aspect = resolveAspect(sizePresets, widgetType)
      const sizes = resolvePresetSizes(presetViewport, sizePresets, aspect, effectiveMinSize(reg.minSize))
      activeSizePreset = matchPreset({ width: layout.width, height: layout.height }, sizes)
    }

    return (
      <Fragment key={node.id}>
        {run && <RunNodeCapabilities run={run} />}
        <CanvasWidgetShell
          registration={effectiveReg}
          nodeId={node.id}
          widgetId={node.entityId}
          data={data}
          layout={layout}
          zoom={camera.zoom}
          isSelected={isSelected(node.id)}
          isFocused={focusedWidgetId === node.id}
          isSpawning={spawnedNodeIds.has(node.id)}
          spawnColor={node.type === 'run' ? runMap.get(node.entityId)?.color : undefined}
          isDimmed={selectionState.selectedIds.size > 0 && selectionState.selectedType === 'run' && !isSelected(node.id)}
          spaceHeldRef={spaceHeld}
          onSelect={handleSelect}
          onDoubleClickZoom={reg.isContainer ? handleDoubleClickShrink : (isSnapLeaf ? handleDoubleClickZoom : undefined)}
          onMove={moveHandler}
          onResize={resizeHandler}
          onResizeStart={isSnapLeaf ? handleResizeStart : undefined}
          onResizeEnd={isSnapLeaf ? handleResizeEnd : undefined}
          onDragStart={isSnapLeaf ? handleWidgetDragStart : undefined}
          onDragEnd={isSnapLeaf ? handleWidgetDragEnd : undefined}
          onAddWidget={isSnapLeaf ? (nodeId, edge, anchor) => setAddPicker({ sourceNodeId: nodeId, edge, anchor }) : undefined}
          occupiedEdges={occupiedEdgesFor(node.id)}
          onApplySizePreset={isSnapLeaf ? (preset) => applySizePreset(node.id, widgetType, preset) : undefined}
          activeSizePreset={activeSizePreset}
          pins={pinSet.forNode(node.id)}
          pinAccent={run?.color}
          pinCanSubmit={resolveBackingSession(node.id, pinCtx) !== null}
          onCreatePin={(nodeId, nx, ny, context) => pinSet.create({ id: makePinId(), nodeId, nx, ny, comment: '', createdAt: Date.now(), ...(context ? { context } : {}) })}
          onRepositionPin={(id, nx, ny) => pinSet.update(id, p => ({ ...p, nx, ny }))}
          onPinCommentChange={(id, comment) => pinSet.update(id, p => ({ ...p, comment }))}
          onDeletePin={(id) => pinSet.remove(id)}
          onSubmitPin={(id, comment) => submitPin(id, node.id, comment)}
          onPinDragActive={setPinDragging}
          onSendAllPins={(nodeId) => sendAllPins(nodeId)}
          onClearAllPins={(nodeId) => clearAllPins(nodeId)}
        />
      </Fragment>
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

  // Snap overlay: highlight only the single widget the drag would snap to.
  const snapTargetWidget = useMemo((): SnapWidget | null => {
    if (!snapPreview) return null
    const l = layouts.get(snapPreview.targetId)
    return l ? { id: snapPreview.targetId, x: l.x, y: l.y, width: l.width, height: l.height } : null
  }, [snapPreview, layouts])
  const snapCanJoin = snapPreview
    ? (slotByNode.has(snapPreview.targetId) || occupiedSlots.size < 9)
    : true

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
      data-dragging={draggingNodeId ? 'true' : undefined}
      data-pin-dragging={pinDragging ? 'true' : undefined}
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
      onContextMenu={handleContextMenu}
      onDragOver={(e) => { e.preventDefault() }}
      onDrop={handleDrop}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('application/tinstar-editor') || e.dataTransfer.types.includes('application/tinstar-hand')) {
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
        {/* Chrome is inside the camera transform so it scales with canvas zoom — unlike the screen-space marquee. */}
        {(['1','2','3','4','5','6','7','8','9'] as const).map(slot => {
          const memberIds = constellations.nodesInSlot(slot)
          const members = memberIds
            .map(id => {
              const l = layouts.get(id)
              if (!l) return null
              return { id, x: l.x, y: l.y, width: l.width, height: l.height }
            })
            .filter((m): m is { id: string; x: number; y: number; width: number; height: number } => m !== null)
          // Outline shows when the slot is hotkey-active OR any member is selected (clicked).
          const active = activeConstellationSlot === slot || memberIds.some(id => isSelected(id))
          return (
            <ConstellationChrome
              key={`constellation-chrome-${slot}`}
              slot={slot}
              members={members}
              active={active}
              onBreak={(aId, bId) => {
                // Break only this seam: split the constellation along it. Larger side keeps the
                // slot; the smaller side becomes its own group (≥2) or is freed (lone widget).
                const liveIds = new Set(members.map(m => m.id))
                const plan = planBreak(constellations.graph, aId, bId, slot, liveIds)
                let next = removeSnap(constellations.graph, aId, bId)
                for (const id of plan.removeFromSlot) next = removeMember(next, id, slot)
                if (plan.newGroup.length > 0) {
                  const free = nextFreeSlot(next)
                  if (free) for (const id of plan.newGroup) next = addMember(next, id, free)
                }
                constellations.applyGraph(next)
              }}
            />
          )
        })}
        <SnapZoneOverlay target={snapTargetWidget} canJoin={snapCanJoin} />
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

      {/* Add-widget picker — screen-space (anchored to the clicked ghost button) */}
      {addPicker && catalog.length > 0 && (() => {
        const sourceType = toWidgetType(nodeTypeById.get(addPicker.sourceNodeId) ?? '')
        const wanted = DEFAULT_FOR[sourceType] ?? GLOBAL_DEFAULT
        const defaultType = catalog.some(e => e.type === wanted) ? wanted : catalog[0]!.type
        return (
          <AddWidgetPicker
            entries={catalog}
            defaultType={defaultType}
            anchor={addPicker.anchor}
            onPick={(entry) => { void addWidget(entry, addPicker.sourceNodeId, addPicker.edge); setAddPicker(null) }}
            onClose={() => setAddPicker(null)}
          />
        )
      })()}

      {/* Right-click "Move widget here" menu — screen-space, empty-space only */}
      {ctxMenu && (
        <CanvasContextMenu
          anchor={{ x: ctxMenu.x, y: ctxMenu.y }}
          targets={moveTargets}
          onPick={relocateWidget}
          onClose={() => setCtxMenu(null)}
        />
      )}

    </div>
  )
}
