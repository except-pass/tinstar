import { useRef, useCallback, type PointerEvent as ReactPointerEvent } from 'react'
import type { Run } from '../domain/types'
import { RunWorkspaceWidget } from './RunWorkspaceWidget'
import { hexToRgba, resolveRunAccent } from './runAccent'

interface Props {
  run: Run
  x: number
  y: number
  width: number
  height: number
  zoom: number
  spaceHeldRef: React.RefObject<boolean>
  selected?: boolean
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  onSelect?: (runId: string, additive: boolean) => void
  onDoubleClickZoom?: (runId: string) => void
  onDragStart?: (runId: string) => void
  onDragMove?: (clientX: number, clientY: number) => void
  onDragEnd?: () => void
}

const DRAG_THRESHOLD = 5

export function CanvasWidget({
  run,
  x,
  y,
  width,
  height,
  zoom,
  spaceHeldRef,
  selected,
  onMove,
  onResize,
  onSelect,
  onDoubleClickZoom,
  onDragStart,
  onDragMove: onDragMoveParent,
  onDragEnd,
}: Props) {
  const dragging = useRef(false)
  const resizing = useRef(false)
  const dragStart = useRef({ x: 0, y: 0, originX: 0, originY: 0 })
  const resizeStart = useRef({ x: 0, y: 0, originW: 0, originH: 0 })
  const dragMoved = useRef(false)
  const resizeMoved = useRef(false)

  // --- Drag (header bar) ---
  const handleDragDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0 || spaceHeldRef.current) return
      e.stopPropagation()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      dragging.current = true
      dragMoved.current = false
      dragStart.current = { x: e.clientX, y: e.clientY, originX: x, originY: y }
    },
    [x, y, spaceHeldRef],
  )

  const handleDragMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragging.current) return
      const dx = (e.clientX - dragStart.current.x) / zoom
      const dy = (e.clientY - dragStart.current.y) / zoom
      if (!dragMoved.current && Math.hypot(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y) < DRAG_THRESHOLD) return
      if (!dragMoved.current) {
        dragMoved.current = true
        onDragStart?.(run.id)
      }
      onMove(run.id, dragStart.current.originX + dx, dragStart.current.originY + dy)
      onDragMoveParent?.(e.clientX, e.clientY)
    },
    [run.id, zoom, onMove, onDragStart, onDragMoveParent],
  )

  const handleDragUp = useCallback(() => {
    if (dragging.current && dragMoved.current) {
      onDragEnd?.()
    }
    dragging.current = false
  }, [onDragEnd])

  // --- Resize (corner handle) ---
  const handleResizeDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      e.stopPropagation()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      resizing.current = true
      resizeMoved.current = false
      resizeStart.current = { x: e.clientX, y: e.clientY, originW: width, originH: height }
    },
    [width, height],
  )

  const handleResizeMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!resizing.current) return
      const dx = (e.clientX - resizeStart.current.x) / zoom
      const dy = (e.clientY - resizeStart.current.y) / zoom
      if (!resizeMoved.current && Math.hypot(e.clientX - resizeStart.current.x, e.clientY - resizeStart.current.y) < DRAG_THRESHOLD) return
      resizeMoved.current = true
      onResize(run.id, resizeStart.current.originW + dx, resizeStart.current.originH + dy)
    },
    [run.id, zoom, onResize],
  )

  const handleResizeUp = useCallback(() => {
    resizing.current = false
  }, [])

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!dragMoved.current && !resizeMoved.current && onSelect) {
      onSelect(run.id, e.ctrlKey || e.metaKey)
    }
  }, [run.id, onSelect])

  const runAccent = resolveRunAccent(run.color)

  const handleDoubleClick = useCallback(() => {
    if (onDoubleClickZoom) {
      onDoubleClickZoom(run.id)
    }
  }, [run.id, onDoubleClickZoom])

  return (
    <div
      data-testid={`canvas-widget-${run.id}`}
      data-selected={selected ? 'true' : undefined}
      className="absolute flex flex-col bg-surface-base border"
      style={{
        left: x,
        top: y,
        width,
        height,
        borderColor: selected ? runAccent : hexToRgba(runAccent, 0.3),
        boxShadow: selected
          ? `0 0 0 2px ${runAccent}, 0 0 12px ${hexToRgba(runAccent, 0.3)}`
          : `0 0 6px ${hexToRgba(runAccent, 0.12)}`,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {/* The actual widget — header is the drag handle */}
      <RunWorkspaceWidget
        run={run}
        className="flex-1 overflow-hidden"
        onHeaderPointerDown={handleDragDown}
        onHeaderPointerMove={handleDragMove}
        onHeaderPointerUp={handleDragUp}
      />

      {/* Resize handle — bottom-right corner */}
      <div
        className="absolute right-0 bottom-0 w-3 h-3 cursor-se-resize z-10"
        style={{
          background: `linear-gradient(135deg, transparent 50%, ${hexToRgba(runAccent, 0.4)} 50%)`,
        }}
        onPointerDown={handleResizeDown}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeUp}
        onPointerCancel={handleResizeUp}
      />
    </div>
  )
}
