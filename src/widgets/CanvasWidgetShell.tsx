import { useRef, useState, useCallback, useEffect, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import type { WidgetRegistration } from './widgetComponentRegistry'
import { isSnappable } from './widgetComponentRegistry'
import type { WidgetLayout } from '../hooks/useWidgetLayouts'
import { WidgetIdProvider } from '../core/pluginApi/widgetIdContext'
import { PinLayer } from '../pins/PinLayer'
import { clamp01 } from '../pins/pinGestures'
import type { Pin } from '../domain/pinSet'

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
  /** Bare entity id (run id sans `run-` prefix, or plugin widget id). Used as
   *  the value of `data-widget-id` so window-event handlers (e.g. the inbox
   *  flash-focus dispatcher) can locate the widget's DOM element. */
  widgetId?: string
  data: unknown
  layout: WidgetLayout
  zoom: number
  isSelected: boolean
  isFocused?: boolean
  isDimmed?: boolean
  isDropTarget?: boolean
  isSpawning?: boolean
  spawnColor?: string
  spaceHeldRef: RefObject<boolean>
  onSelect: (id: string, additive: boolean) => void
  onDoubleClickZoom?: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  /** Resize gesture started (pointer down on the resize handle) — snapshot state for re-snap. */
  onResizeStart?: (id: string) => void
  /** Resize gesture finished (after an actual resize) — re-snap the constellation. */
  onResizeEnd?: (id: string, width: number, height: number) => void
  onDragStart?: (id: string) => void
  onDragMove?: (id: string, clientX: number, clientY: number) => void
  onDragEnd?: (id: string) => void
  /** Open the add-widget picker for an edge of this widget. `anchor` is screen-space. */
  onAddWidget?: (nodeId: string, edge: 'left' | 'right' | 'top' | 'bottom', anchor: { x: number; y: number }) => void
  /** Edges that already have a snapped neighbor (a break-link sits there) — the add-widget
   *  [+] is suppressed on these so it only shows on exposed edges. */
  occupiedEdges?: ReadonlySet<'left' | 'right' | 'top' | 'bottom'>
  /** Pins anchored to this node (normalized coords). When provided alongside the pin
   *  callbacks the shell renders the default PinLayer (unless the widget renders its
   *  own markers) plus the drag-to-place hover affordance. */
  pins?: Pin[]
  pinAccent?: string
  pinCanSubmit?: boolean
  onCreatePin?: (nodeId: string, nx: number, ny: number) => void
  onRepositionPin?: (id: string, nx: number, ny: number) => void
  onPinCommentChange?: (id: string, comment: string) => void
  onDeletePin?: (id: string) => void
  onSubmitPin?: (id: string) => void
  /** Toggles the canvas-level iframe pointer guard during place/reposition drags so
   *  the drag stream isn't swallowed by browser/terminal iframe widgets. */
  onPinDragActive?: (active: boolean) => void
}

export function CanvasWidgetShell({
  registration,
  nodeId,
  widgetId,
  data,
  layout,
  zoom,
  isSelected,
  isFocused = false,
  isDimmed = false,
  isDropTarget = false,
  isSpawning = false,
  spawnColor,
  spaceHeldRef,
  onSelect,
  onDoubleClickZoom,
  onMove,
  onResize,
  onResizeStart,
  onResizeEnd,
  onDragStart,
  onDragMove,
  onDragEnd,
  onAddWidget,
  occupiedEdges,
  pins,
  pinAccent,
  pinCanSubmit,
  onCreatePin,
  onRepositionPin,
  onPinCommentChange,
  onDeletePin,
  onSubmitPin,
  onPinDragActive,
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
  // Last size emitted during the active resize. onResize only queues a React state
  // update, so reading layout state at resize-end can lag a frame; carry the final
  // dimensions here so onResizeEnd reflows from the actual last size, not stale state.
  const lastResizeSize = useRef({ width: 0, height: 0 })
  const dragMoved = useRef(false)
  const resizeMoved = useRef(false)
  const dragPointerId = useRef<number | null>(null)

  const frameClass =
    getFrameClass?.({ isDragging, isSelected, isHovered, isDropTarget }) ?? ''

  const pinnable = registration.pinnable !== false
  // Active placement-drag pointer id; non-null while dragging the pin affordance
  // onto the widget body. setPointerCapture keeps the stream on the affordance,
  // but the iframe guard (onPinDragActive) is what makes it survive iframe widgets.
  const pinPlacePointerId = useRef<number | null>(null)

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
      onResizeStart?.(nodeId)
    },
    [layout.width, layout.height, nodeId, onResizeStart],
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
      const width = Math.round(Math.max(minSize.width, resizeStart.current.originW + dx))
      const height = Math.round(Math.max(minSize.height, resizeStart.current.originH + dy))
      lastResizeSize.current = { width, height }
      onResize(nodeId, width, height)
    },
    [nodeId, zoom, onResize, minSize],
  )

  const handleResizeUp = useCallback(() => {
    resizing.current = false
    if (resizeMoved.current) onResizeEnd?.(nodeId, lastResizeSize.current.width, lastResizeSize.current.height)
  }, [nodeId, onResizeEnd])

  const handleDoubleClick = useCallback(() => {
    onDoubleClickZoom?.(nodeId)
  }, [nodeId, onDoubleClickZoom])

  // Shared teardown for pin place-drag — clears the placing ref and lowers the
  // iframe guard. Called from pointer-up, onPointerCancel, onLostPointerCapture,
  // and the unmount effect. Does NOT do pin placement (that stays in pointer-up
  // only, so lostpointercapture/cancel can't double-place).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally stable; onPinDragActive identity change shouldn't retrigger unmount guard
  const onPinDragActiveRef = useRef(onPinDragActive)
  useEffect(() => { onPinDragActiveRef.current = onPinDragActive })

  const endPinPlace = useCallback(() => {
    if (pinPlacePointerId.current === null) return
    pinPlacePointerId.current = null
    onPinDragActiveRef.current?.(false)
  }, [])

  // Pin drag-to-place: capture the pointer on the affordance, raise the iframe
  // guard, and on pointer-up drop a pin at the cursor's normalized position
  // within the widget body (cancel if released outside the widget).
  const handlePinPlaceDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      e.stopPropagation()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      pinPlacePointerId.current = e.pointerId
      onPinDragActive?.(true)
    },
    [onPinDragActive],
  )

  const handlePinPlaceUp = useCallback(
    (e: ReactPointerEvent) => {
      if (pinPlacePointerId.current === null) return
      // Teardown first (clears ref + lowers guard), then place the pin.
      endPinPlace()
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0 || rect.height === 0) return
      const rawX = (e.clientX - rect.left) / rect.width
      const rawY = (e.clientY - rect.top) / rect.height
      // Only place when released over the widget body; otherwise treat as cancel.
      if (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1) return
      onCreatePin?.(nodeId, clamp01(rawX), clamp01(rawY))
    },
    [nodeId, onCreatePin, endPinPlace],
  )

  // Unmount guard: if the affordance button unmounts while a place-drag is active
  // (hover-only button, hover drops before pointerup), clear the iframe guard so
  // all iframes don't stay frozen. Deps are [] — pure unmount effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { endPinPlace() }, [])

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

  // Clicking inside an iframe body (browser/terminal primitives) does not bubble
  // a pointer event to the shell, so the widget would never select. Detect focus
  // moving into an inner iframe (window blur + activeElement is our iframe) and
  // fire the normal selection. Generic across all iframe-backed widgets.
  useEffect(() => {
    function onWindowBlur() {
      if (isSelected) return
      if (!document.hasFocus()) return // OS-level blur (tab/app switch), not an in-page iframe focus grab
      const active = document.activeElement
      if (
        active &&
        active.tagName === 'IFRAME' &&
        containerRef.current?.contains(active)
      ) {
        onSelect(nodeId, false)
      }
    }
    window.addEventListener('blur', onWindowBlur)
    return () => window.removeEventListener('blur', onWindowBlur)
  }, [isSelected, nodeId, onSelect])

  return (
    <div
      ref={containerRef}
      data-testid={`canvas-widget-${nodeId}`}
      data-widget-id={widgetId}
      data-selected={isSelected ? 'true' : undefined}
      data-focused={isFocused ? 'true' : undefined}
      data-widget-type={registration.type}
      className={`absolute ${frameClass} ${isSpawning ? 'widget-spawning' : 'transition-opacity duration-150'} ${isDimmed ? 'opacity-40' : 'opacity-100'} ${isFocused ? 'ring-2 ring-primary' : ''}`}
      style={{
        left: Math.round(layout.x),
        top: Math.round(layout.y),
        width: Math.round(layout.width),
        height: Math.round(layout.height),
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
      <WidgetIdProvider id={nodeId}>
        <WidgetComponent
          data={data}
          zoom={zoom}
          isSelected={isSelected}
          isDragging={isDragging}
          isHovered={isHovered}
          isDropTarget={isDropTarget}
        />
      </WidgetIdProvider>

      {pinnable && !registration.rendersOwnPinMarkers && pins && onRepositionPin && (
        <PinLayer
          pins={pins}
          accent={pinAccent ?? '#00f0ff'}
          zoom={zoom}
          canSubmit={!!pinCanSubmit}
          onReposition={(id, nx, ny) => onRepositionPin(id, nx, ny)}
          onCommentChange={(id, c) => onPinCommentChange?.(id, c)}
          onDelete={(id) => onDeletePin?.(id)}
          onSubmit={(id) => onSubmitPin?.(id)}
          onDragActiveChange={onPinDragActive}
        />
      )}

      {pinnable && (isHovered || isSelected) && onCreatePin && (
        <button
          data-testid="pin-drop-affordance"
          className="pointer-events-auto absolute right-1 top-1 z-20 flex h-5 w-5 items-center justify-center rounded-full border border-primary/40 bg-slate-900/90 text-primary opacity-70 transition-opacity hover:opacity-100"
          style={{ transform: `scale(${1 / zoom})`, transformOrigin: 'top right' }}
          onPointerDown={handlePinPlaceDown}
          onPointerUp={handlePinPlaceUp}
          onPointerCancel={endPinPlace}
          onLostPointerCapture={endPinPlace}
          onClick={e => e.stopPropagation()}
          title="Drag onto the widget to drop a pin"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>push_pin</span>
        </button>
      )}

      {onAddWidget && isSnappable(registration) && (isHovered || isSelected) && (
        <div className="pointer-events-none absolute inset-0">
          {(['left','right','top','bottom'] as const).filter(edge => !occupiedEdges?.has(edge)).map(edge => {
            const posStyle: React.CSSProperties =
              edge === 'left'   ? { left: 0,  top: '50%', transform: `translate(-50%,-50%) scale(${1/zoom})` }
            : edge === 'right'  ? { right: 0, top: '50%', transform: `translate(50%,-50%) scale(${1/zoom})` }
            : edge === 'top'    ? { top: 0,  left: '50%', transform: `translate(-50%,-50%) scale(${1/zoom})` }
            :                     { bottom: 0, left: '50%', transform: `translate(-50%,50%) scale(${1/zoom})` }
            return (
              <button
                key={edge}
                data-testid={`add-widget-btn-${edge}`}
                className="pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border border-primary/40 bg-slate-900/90 text-primary opacity-70 transition-opacity hover:opacity-100"
                style={posStyle}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => {
                  e.stopPropagation()
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  onAddWidget(nodeId, edge, { x: r.right + 4, y: r.top })
                }}
                title="Add widget"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              </button>
            )
          })}
        </div>
      )}

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
