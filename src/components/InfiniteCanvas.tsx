import { useRef, useEffect, useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Run, TreeNode, GroupingDimension } from '../domain/types'
import { useCanvasCamera } from '../hooks/useCanvasCamera'
import { useWidgetLayouts, type WidgetLayout } from '../hooks/useWidgetLayouts'
import { CanvasWidget } from './CanvasWidget'
import { GroupContainer } from './GroupContainer'
import { ReassignDialog } from './ReassignDialog'

interface Props {
  tree: TreeNode[]
  runMap: Map<string, Run>
  focusRunId: string | null
  onFocusHandled: () => void
  onSelectRun?: (runId: string) => void
  onFocusRun?: (runId: string) => void
}

/** Extract entity type and ID from a tree node ID like "initiative-abc123" */
function parseNodeId(nodeId: string): { type: string; entityId: string } | null {
  const dash = nodeId.indexOf('-')
  if (dash === -1) return null
  return { type: nodeId.slice(0, dash), entityId: nodeId.slice(dash + 1) }
}

/** Find all group (non-run) nodes in the tree */
function collectGroupNodes(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = []
  for (const node of nodes) {
    if (node.type !== 'run') {
      result.push(node)
      result.push(...collectGroupNodes(node.children))
    }
  }
  return result
}

interface DropTarget {
  nodeId: string
  label: string
  type: string
  entityId: string
}

interface ReassignState {
  runId: string
  target: DropTarget
}

export function InfiniteCanvas({ tree, runMap, focusRunId, onFocusHandled, onSelectRun, onFocusRun }: Props) {
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
  } = useWidgetLayouts(tree)
  const { camera, cursorStyle, spaceHeld, handleWheel, startPan, movePan, endPan, centerOn } = useCanvasCamera()

  // Drag-to-reassign state
  const draggingRunRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [reassign, setReassign] = useState<ReassignState | null>(null)
  const groupNodesRef = useRef<TreeNode[]>([])

  // Keep group nodes list in sync with tree
  useEffect(() => {
    groupNodesRef.current = collectGroupNodes(tree)
  }, [tree])

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

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => { startPan(e.nativeEvent) },
    [startPan],
  )
  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => { movePan(e.nativeEvent) },
    [movePan],
  )
  const onPointerUp = useCallback(() => { endPan() }, [endPan])

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

  /** Hit-test canvas point against group containers, return deepest match */
  const hitTestGroups = useCallback((canvasX: number, canvasY: number): DropTarget | null => {
    let best: { node: TreeNode; layout: WidgetLayout; depth: number } | null = null

    for (const node of groupNodesRef.current) {
      const layout = layouts.get(node.id)
      if (!layout) continue
      if (
        canvasX >= layout.x && canvasX <= layout.x + layout.width &&
        canvasY >= layout.y && canvasY <= layout.y + layout.height
      ) {
        const parsed = parseNodeId(node.id)
        if (!parsed) continue
        // Prefer deeper (more specific) containers
        const depth = node.id.split('-').length // rough proxy
        if (!best || depth > best.depth) {
          best = { node, layout, depth }
        }
      }
    }

    if (!best) return null
    const parsed = parseNodeId(best.node.id)!
    return { nodeId: best.node.id, label: best.node.label, type: parsed.type, entityId: parsed.entityId }
  }, [layouts])

  // Widget drag callbacks
  const handleWidgetDragStart = useCallback((runId: string) => {
    draggingRunRef.current = runId
  }, [])

  const handleWidgetDragMove = useCallback((clientX: number, clientY: number) => {
    if (!draggingRunRef.current) return
    const canvas = clientToCanvas(clientX, clientY)
    const target = hitTestGroups(canvas.x, canvas.y)
    setDropTarget(prev => {
      if (prev?.nodeId === target?.nodeId) return prev
      return target
    })
  }, [clientToCanvas, hitTestGroups])

  const handleWidgetDragEnd = useCallback(() => {
    const runId = draggingRunRef.current
    draggingRunRef.current = null
    if (runId && dropTarget) {
      setReassign({ runId, target: dropTarget })
    }
    setDropTarget(null)
  }, [dropTarget])

  const handleReassignConfirm = useCallback(async () => {
    if (!reassign) return
    const { runId, target } = reassign

    // Build the patch based on target type
    // resolveDimension resolves task via run.taskId, epic/initiative via task's FKs
    const patch: Record<string, string> = {}
    if (target.type === 'task') patch.taskId = target.entityId

    // Move the widget inside the target container
    const containerLayout = layouts.get(target.nodeId)
    if (containerLayout) {
      const runNodeId = `run-${runId}`
      updateRunPosition(runNodeId, containerLayout.x + 30, containerLayout.y + 50)
    }

    await fetch(`/api/runs/${runId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    setReassign(null)
  }, [reassign, layouts, updateRunPosition])

  const handleReassignCancel = useCallback(() => {
    setReassign(null)
  }, [])

  // Recursive render: groups render behind their children (natural DOM order)
  function renderNode(node: TreeNode, depth: number): React.ReactNode {
    if (node.type === 'run') {
      const run = runMap.get(node.entityId)
      if (!run) return null
      const layout = layouts.get(node.id)
      if (!layout) return null
      return (
        <CanvasWidget
          key={node.id}
          run={run}
          x={layout.x}
          y={layout.y}
          width={layout.width}
          height={layout.height}
          zoom={camera.zoom}
          spaceHeldRef={spaceHeld}
          onMove={(runId, x, y) => updateRunPosition(node.id, x, y)}
          onResize={(runId, w, h) => updateRunSize(node.id, w, h)}
          onSelect={onSelectRun}
          onDoubleClickZoom={onFocusRun}
          onDragStart={handleWidgetDragStart}
          onDragMove={handleWidgetDragMove}
          onDragEnd={handleWidgetDragEnd}
        />
      )
    }

    // Group container + recurse children
    const layout = layouts.get(node.id)
    if (!layout) return null
    return (
      <GroupContainer
        key={node.id}
        nodeId={node.id}
        label={node.label}
        depth={depth}
        nodeType={node.type as GroupingDimension}
        x={layout.x}
        y={layout.y}
        width={layout.width}
        height={layout.height}
        zoom={camera.zoom}
        spaceHeldRef={spaceHeld}
        onMove={moveNode}
        onResize={resizeNode}
        onShrinkToFit={shrinkNode}
        highlighted={dropTarget?.nodeId === node.id}
      />
    )
  }

  // Collect all nodes in render order: groups first (bottom), then leaves (top)
  // This ensures children render on top of their parent containers
  function collectRenderOrder(nodes: TreeNode[], depth: number): React.ReactNode[] {
    const result: React.ReactNode[] = []
    for (const node of nodes) {
      if (node.type !== 'run') {
        // Render group container first (behind)
        result.push(renderNode(node, depth))
        // Then recurse into children
        result.push(...collectRenderOrder(node.children, depth + 1))
      } else {
        result.push(renderNode(node, depth))
      }
    }
    return result
  }

  const renderedNodes = collectRenderOrder(tree, 0)

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-hidden relative"
      style={{
        cursor: cursorStyle,
        backgroundImage: 'radial-gradient(circle, rgba(0,240,255,0.04) 1px, transparent 1px)',
        backgroundSize: `${24 * camera.zoom}px ${24 * camera.zoom}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      data-testid="infinite-canvas"
    >
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
      </div>

      {/* Bottom-right controls */}
      <div className="absolute bottom-3 right-3 flex items-center gap-2">
        <button
          className="bg-surface-panel border border-white/10 px-3 py-1.5 text-xs font-mono text-slate-400 hover:text-primary hover:border-primary/30 rounded-sm select-none transition-colors"
          onClick={arrangeWorkspace}
          data-testid="arrange-button"
        >
          Arrange
        </button>
        <div
          className="bg-surface-panel border border-white/10 px-3 py-1.5 text-xs font-mono text-slate-500 rounded-sm select-none"
          data-testid="zoom-indicator"
        >
          {Math.round(camera.zoom * 100)}%
        </div>
      </div>

      {reassign && (
        <ReassignDialog
          runId={reassign.runId}
          targetLabel={reassign.target.label}
          targetType={reassign.target.type}
          onConfirm={handleReassignConfirm}
          onCancel={handleReassignCancel}
        />
      )}
    </div>
  )
}
