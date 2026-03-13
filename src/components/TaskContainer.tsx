import { useRef, useCallback, type PointerEvent as ReactPointerEvent } from 'react'

interface Props {
  taskId: string
  taskName: string
  x: number
  y: number
  width: number
  height: number
  zoom: number
  spaceHeldRef: React.RefObject<boolean>
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  onShrinkToFit?: (id: string) => void
}

const DRAG_THRESHOLD = 5

export function TaskContainer({
  taskId,
  taskName,
  x,
  y,
  width,
  height,
  zoom,
  spaceHeldRef,
  onMove,
  onResize,
  onShrinkToFit,
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
      onMove(taskId, dragStart.current.originX + dx, dragStart.current.originY + dy)
    },
    [taskId, zoom, onMove],
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
      onResize(taskId, resizeStart.current.originW + dx, resizeStart.current.originH + dy)
    },
    [taskId, zoom, onResize],
  )

  const onResizeUp = useCallback(() => {
    resizing.current = false
  }, [])

  const handleDoubleClick = useCallback(() => {
    if (onShrinkToFit) onShrinkToFit(taskId)
  }, [taskId, onShrinkToFit])

  return (
    <div
      data-testid={`task-container-${taskId}`}
      className="absolute rounded-md"
      onDoubleClick={handleDoubleClick}
      style={{
        left: x,
        top: y,
        width,
        height,
        border: '1px solid rgba(0, 240, 255, 0.15)',
        background: 'rgba(0, 240, 255, 0.02)',
      }}
    >
      {/* Drag handle — full header area */}
      <div
        className="h-8 flex items-center px-3 cursor-grab active:cursor-grabbing select-none"
        style={{ borderBottom: '1px solid rgba(0, 240, 255, 0.08)' }}
        onPointerDown={onDragDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        onPointerCancel={onDragUp}
      >
        <span className="text-xs font-display uppercase tracking-wider text-primary/50">
          {taskName}
        </span>
      </div>

      {/* Resize handle — bottom-right corner */}
      <div
        className="absolute right-0 bottom-0 w-4 h-4 cursor-se-resize z-10"
        style={{
          background: 'linear-gradient(135deg, transparent 50%, rgba(0, 240, 255, 0.2) 50%)',
        }}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
    </div>
  )
}
