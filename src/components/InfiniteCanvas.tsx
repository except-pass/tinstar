import { useRef, useEffect, useCallback, type PointerEvent as ReactPointerEvent } from 'react'
import type { Run, TreeNode, GroupingDimension } from '../domain/types'
import { useCanvasCamera } from '../hooks/useCanvasCamera'
import { useWidgetLayouts } from '../hooks/useWidgetLayouts'
import { CanvasWidget } from './CanvasWidget'
import { GroupContainer } from './GroupContainer'

interface Props {
  tree: TreeNode[]
  runMap: Map<string, Run>
  focusRunId: string | null
  onFocusHandled: () => void
  onSelectRun?: (runId: string) => void
  onFocusRun?: (runId: string) => void
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
    </div>
  )
}
