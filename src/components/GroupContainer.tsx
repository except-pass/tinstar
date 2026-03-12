import { useRef, useCallback, type PointerEvent as ReactPointerEvent } from 'react'
import type { GroupingDimension } from '../domain/types'
import { getDimensionIcon } from '../domain/dimension-meta'

const BORDER_OPACITY = [0.15, 0.12, 0.08, 0.05]
const BG_OPACITY = [0.02, 0.015, 0.01, 0.005]

function getBorderOpacity(depth: number): number {
  return BORDER_OPACITY[Math.min(depth, BORDER_OPACITY.length - 1)]
}

function getBgOpacity(depth: number): number {
  return BG_OPACITY[Math.min(depth, BG_OPACITY.length - 1)]
}

interface Props {
  nodeId: string
  label: string
  depth: number
  nodeType: GroupingDimension
  x: number
  y: number
  width: number
  height: number
  zoom: number
  spaceHeldRef: React.RefObject<boolean>
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  onShrinkToFit?: (id: string) => void
  highlighted?: boolean
}

const DRAG_THRESHOLD = 5

export function GroupContainer({
  nodeId,
  label,
  depth,
  nodeType,
  x,
  y,
  width,
  height,
  zoom,
  spaceHeldRef,
  onMove,
  onResize,
  onShrinkToFit,
  highlighted = false,
}: Props) {
  const dragging = useRef(false)
  const resizing = useRef(false)
  const dragStart = useRef({ x: 0, y: 0, originX: 0, originY: 0 })
  const resizeStart = useRef({ x: 0, y: 0, originW: 0, originH: 0 })
  const dragMoved = useRef(false)
  const resizeMoved = useRef(false)

  const onDragDown = useCallback(
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

  const onDragMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragging.current) return
      const dx = (e.clientX - dragStart.current.x) / zoom
      const dy = (e.clientY - dragStart.current.y) / zoom
      if (!dragMoved.current && Math.hypot(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y) < DRAG_THRESHOLD) return
      dragMoved.current = true
      onMove(nodeId, dragStart.current.originX + dx, dragStart.current.originY + dy)
    },
    [nodeId, zoom, onMove],
  )

  const onDragUp = useCallback(() => {
    dragging.current = false
  }, [])

  const onResizeDown = useCallback(
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

  const onResizeMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!resizing.current) return
      const dx = (e.clientX - resizeStart.current.x) / zoom
      const dy = (e.clientY - resizeStart.current.y) / zoom
      if (!resizeMoved.current && Math.hypot(e.clientX - resizeStart.current.x, e.clientY - resizeStart.current.y) < DRAG_THRESHOLD) return
      resizeMoved.current = true
      onResize(nodeId, resizeStart.current.originW + dx, resizeStart.current.originH + dy)
    },
    [nodeId, zoom, onResize],
  )

  const onResizeUp = useCallback(() => {
    resizing.current = false
  }, [])

  const handleDoubleClick = useCallback(() => {
    if (onShrinkToFit) onShrinkToFit(nodeId)
  }, [nodeId, onShrinkToFit])

  const borderOp = getBorderOpacity(depth)
  const bgOp = getBgOpacity(depth)
  const icon = getDimensionIcon(nodeType)

  return (
    <div
      data-testid={`group-container-${nodeId}`}
      className={`absolute ${depth === 0 ? 'rounded-lg' : 'rounded-md'}`}
      onDoubleClick={handleDoubleClick}
      style={{
        left: x,
        top: y,
        width,
        height,
        border: highlighted
          ? '2px solid rgba(0, 240, 255, 0.6)'
          : `1px solid rgba(0, 240, 255, ${borderOp})`,
        background: highlighted
          ? 'rgba(0, 240, 255, 0.08)'
          : `rgba(0, 240, 255, ${bgOp})`,
        boxShadow: highlighted ? '0 0 20px rgba(0, 240, 255, 0.15), inset 0 0 20px rgba(0, 240, 255, 0.05)' : 'none',
        transition: 'border 150ms, background 150ms, box-shadow 150ms',
      }}
    >
      {/* Drag handle — full header area */}
      <div
        className="h-8 flex items-center px-3 cursor-grab active:cursor-grabbing select-none"
        style={{ borderBottom: `1px solid rgba(0, 240, 255, ${borderOp * 0.5})` }}
        onPointerDown={onDragDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        onPointerCancel={onDragUp}
      >
        <span className="text-xs font-display uppercase tracking-wider text-primary/50">
          {icon} {label}
        </span>
      </div>

      {/* Resize handle — bottom-right corner */}
      <div
        className="absolute right-0 bottom-0 w-4 h-4 cursor-se-resize z-10"
        style={{
          background: `linear-gradient(135deg, transparent 50%, rgba(0, 240, 255, ${borderOp + 0.05}) 50%)`,
        }}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
    </div>
  )
}
