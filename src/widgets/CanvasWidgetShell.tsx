import { useRef, useState, useCallback, useEffect, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import type { WidgetRegistration } from './widgetComponentRegistry'
import type { WidgetLayout } from '../hooks/useWidgetLayouts'

const DRAG_THRESHOLD = 5

/** Convert a hex color (#rrggbb or #rgb) to an rgba() CSS string */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(b)) return `rgba(0,240,255,${alpha})`
  return `rgba(${r},${g},${b},${alpha})`
}

/** Build CSS custom properties for the spawn glow animation */
function spawnGlowVars(color: string): React.CSSProperties {
  return {
    '--spawn-glow-0': hexToRgba(color, 0),
    '--spawn-glow-strong': hexToRgba(color, 0.8),
    '--spawn-glow-mid': hexToRgba(color, 0.45),
    '--spawn-glow-subtle': hexToRgba(color, 0.35),
    '--spawn-glow-faint': hexToRgba(color, 0.2),
  } as React.CSSProperties
}

interface CanvasWidgetShellProps {
  registration: WidgetRegistration
  nodeId: string
  data: unknown
  layout: WidgetLayout
  zoom: number
  isSelected: boolean
  isDimmed?: boolean
  isDropTarget?: boolean
  isSpawning?: boolean
  spawnColor?: string
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
  isDimmed = false,
  isDropTarget = false,
  isSpawning = false,
  spawnColor,
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
      // Prevent canvas from treating this as an empty-canvas click (would deselect)
      e.stopPropagation()
      onSelect(nodeId, e.ctrlKey || e.metaKey)

      const target = e.target as Element
      if (target.closest(dragHandleSelector)) {
        dragging.current = true
        dragMoved.current = false
        dragPointerId.current = e.pointerId
        dragStart.current = {
          x: e.clientX,
          y: e.clientY,
          originX: layout.x,
          originY: layout.y,
        }
        // Capture immediately so fast mouse movement never escapes the widget
        // before the drag threshold is reached
        containerRef.current?.setPointerCapture(e.pointerId)
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
        setIsDragging(true)
        onDragStart?.(nodeId)
      }
      onMove(nodeId, Math.round(dragStart.current.originX + dx), Math.round(dragStart.current.originY + dy))
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
        Math.round(Math.max(minSize.width, resizeStart.current.originW + dx)),
        Math.round(Math.max(minSize.height, resizeStart.current.originH + dy)),
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

  // Escape cancels any in-progress drag or resize
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (!dragging.current && !resizing.current) return
      dragging.current = false
      dragMoved.current = false
      resizing.current = false
      resizeMoved.current = false
      setIsDragging(false)
      if (dragPointerId.current !== null) {
        containerRef.current?.releasePointerCapture(dragPointerId.current)
        dragPointerId.current = null
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      ref={containerRef}
      data-testid={`canvas-widget-${nodeId}`}
      data-selected={isSelected ? 'true' : undefined}
      data-widget-type={registration.type}
      className={`absolute ${frameClass} ${isSpawning ? 'widget-spawning' : 'transition-opacity duration-150'} ${isDimmed ? 'opacity-40' : 'opacity-100'}`}
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
        zIndex: registration.isContainer ? undefined
          : isDragging ? 30 : isSelected ? 20 : isHovered ? 10 : undefined,
        ...(isSpawning && spawnColor ? spawnGlowVars(spawnColor) : {}),
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
