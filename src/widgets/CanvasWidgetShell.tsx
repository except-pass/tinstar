import { useRef, useState, useCallback, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import type { WidgetRegistration } from './widgetComponentRegistry'
import type { WidgetLayout } from '../hooks/useWidgetLayouts'

const DRAG_THRESHOLD = 5

interface CanvasWidgetShellProps {
  registration: WidgetRegistration
  nodeId: string
  data: unknown
  layout: WidgetLayout
  zoom: number
  isSelected: boolean
  isDropTarget?: boolean
  spaceHeldRef: RefObject<boolean>
  onSelect: (id: string, additive: boolean) => void
  onDoubleClickZoom?: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  onDragStart?: (id: string) => void
  onDragMove?: (id: string, clientX: number, clientY: number) => void
  onDragEnd?: (id: string) => void
}

export function CanvasWidgetShell({
  registration,
  nodeId,
  data,
  layout,
  zoom,
  isSelected,
  isDropTarget = false,
  spaceHeldRef,
  onSelect,
  onDoubleClickZoom,
  onMove,
  onResize,
  onDragStart,
  onDragMove,
  onDragEnd,
}: CanvasWidgetShellProps) {
  const {
    component: WidgetComponent,
    dragHandleSelector = '.widget-drag-handle',
    getFrameClass,
    minSize,
  } = registration

  const containerRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  const dragging = useRef(false)
  const resizing = useRef(false)
  const dragStart = useRef({ x: 0, y: 0, originX: 0, originY: 0 })
  const resizeStart = useRef({ x: 0, y: 0, originW: 0, originH: 0 })
  const dragMoved = useRef(false)
  const resizeMoved = useRef(false)
  const dragPointerId = useRef<number | null>(null)

  const frameClass =
    getFrameClass?.({ isDragging, isSelected, isHovered, isDropTarget }) ?? ''

  // Pointer down on shell: fire selection + start drag if on handle
  const handlePointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0 || spaceHeldRef.current) return
      onSelect(nodeId, e.ctrlKey || e.metaKey)

      const target = e.target as Element
      if (target.closest(dragHandleSelector)) {
        e.stopPropagation()
        dragging.current = true
        dragMoved.current = false
        dragPointerId.current = e.pointerId
        dragStart.current = {
          x: e.clientX,
          y: e.clientY,
          originX: layout.x,
          originY: layout.y,
        }
      }
    },
    [nodeId, spaceHeldRef, dragHandleSelector, layout.x, layout.y, onSelect],
  )

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragging.current) return
      const dx = (e.clientX - dragStart.current.x) / zoom
      const dy = (e.clientY - dragStart.current.y) / zoom
      if (
        !dragMoved.current &&
        Math.hypot(
          e.clientX - dragStart.current.x,
          e.clientY - dragStart.current.y,
        ) < DRAG_THRESHOLD
      )
        return
      if (!dragMoved.current) {
        dragMoved.current = true
        // Defer setPointerCapture to drag start so dblclick fires on correct element
        if (dragPointerId.current !== null) {
          containerRef.current?.setPointerCapture(dragPointerId.current)
        }
        setIsDragging(true)
        onDragStart?.(nodeId)
      }
      onMove(nodeId, dragStart.current.originX + dx, dragStart.current.originY + dy)
      onDragMove?.(nodeId, e.clientX, e.clientY)
    },
    [nodeId, zoom, onMove, onDragStart, onDragMove],
  )

  const handlePointerUp = useCallback(() => {
    if (dragging.current && dragMoved.current) {
      onDragEnd?.(nodeId)
    }
    dragging.current = false
    dragMoved.current = false
    setIsDragging(false)
  }, [nodeId, onDragEnd])

  // Resize handle (bottom-right corner)
  const handleResizeDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      e.stopPropagation()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      resizing.current = true
      resizeMoved.current = false
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        originW: layout.width,
        originH: layout.height,
      }
    },
    [layout.width, layout.height],
  )

  const handleResizeMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!resizing.current) return
      const dx = (e.clientX - resizeStart.current.x) / zoom
      const dy = (e.clientY - resizeStart.current.y) / zoom
      if (
        !resizeMoved.current &&
        Math.hypot(
          e.clientX - resizeStart.current.x,
          e.clientY - resizeStart.current.y,
        ) < DRAG_THRESHOLD
      )
        return
      resizeMoved.current = true
      onResize(
        nodeId,
        Math.max(minSize.width, resizeStart.current.originW + dx),
        Math.max(minSize.height, resizeStart.current.originH + dy),
      )
    },
    [nodeId, zoom, onResize, minSize],
  )

  const handleResizeUp = useCallback(() => {
    resizing.current = false
  }, [])

  const handleDoubleClick = useCallback(() => {
    onDoubleClickZoom?.(nodeId)
  }, [nodeId, onDoubleClickZoom])

  return (
    <div
      ref={containerRef}
      data-testid={`canvas-widget-${nodeId}`}
      data-selected={isSelected ? 'true' : undefined}
      className={`absolute ${frameClass}`}
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
    >
      <WidgetComponent
        data={data}
        zoom={zoom}
        isSelected={isSelected}
        isDragging={isDragging}
        isHovered={isHovered}
        isDropTarget={isDropTarget}
      />

      {/* Resize handle — bottom-right corner */}
      <div
        className="absolute right-0 bottom-0 w-3 h-3 cursor-se-resize z-10"
        style={{
          background:
            'linear-gradient(135deg, transparent 50%, rgba(0, 240, 255, 0.25) 50%)',
        }}
        onPointerDown={handleResizeDown}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeUp}
        onPointerCancel={handleResizeUp}
      />
    </div>
  )
}
