// Pin overlay rendered OVER the iframe (never injected into the page — page CSS
// can't break pins, pins can't break the page). The browser self-renders its
// pins (registration.rendersOwnPinMarkers) so they glue to scrolling page
// content: each marker is positioned in DOCUMENT coords minus the iframe scroll
// offset. Placement is owned by the HOST shell's drag affordance (which calls
// onCreatePin → api.pins.create); this layer only renders + edits existing pins.
//
// The layer is pointer-transparent; each pin wrapper is pointer-active. Uses the
// shared PinMarker/PinBubble so it matches every other widget's pins.
import { useRef, useState } from 'react'
import type { Pin } from '../../../../domain/pinSet'
import { PinMarker } from '../../../../pins/PinMarker'
import { PinBubble } from '../../../../pins/PinBubble'
import { classifyPointerUp } from '../../../../pins/pinGestures'

export interface BrowserPinLayerProps {
  /** Pins for THIS node (caller passes api.pins.useNodePins(nodeId) — already
   *  filtered to the node, NOT yet filtered to the current page). */
  pins: Pin[]
  /** The currently-loaded page URL; pins are scoped to it. */
  url: string
  /** Iframe document scroll offset — pins are stored in document coords. */
  scroll: { x: number; y: number }
  /** Iframe content box size, used to place not-yet-enriched (fresh) pins whose
   *  only coords are nx/ny normalized to the viewport box. */
  iframeWidth: number
  iframeHeight: number
  accent: string
  /** Whether the Send button is enabled (a backing session exists). */
  canSubmit: boolean
  onCommentChange: (id: string, comment: string) => void
  onDelete: (id: string) => void
  onSubmit: (id: string, comment: string) => void
  /** Drag-to-reposition: fires with the new DOCUMENT coords (docX/docY) as the
   *  marker is dragged. Caller persists into the pin's context. */
  onReposition: (id: string, docX: number, docY: number) => void
  /** Fires true on the first drag move past threshold, false on up/cancel. The
   *  host plugin toggles the iframe's pointer-events so a marker drag over the
   *  iframe isn't swallowed (setPointerCapture doesn't hold over iframes). */
  onDragActiveChange?: (active: boolean) => void
}

/** A pin belongs to the current page if its enriched context url matches, OR it
 *  is freshly placed and not yet enriched (no context) — a pin placed on this
 *  node always belongs to the page loaded at placement time. */
function onCurrentPage(pin: Pin, url: string): boolean {
  if (!pin.context) return true
  return pin.context.url === url
}

/** Document-space anchor for a marker. Enriched pins carry docX/docY (glued to
 *  content via scroll); fresh pins fall back to their viewport-normalized coords. */
function docPoint(pin: Pin, iframeWidth: number, iframeHeight: number): { x: number; y: number } {
  const ctx = pin.context
  const x = typeof ctx?.docX === 'number' ? ctx.docX : pin.nx * iframeWidth
  const y = typeof ctx?.docY === 'number' ? ctx.docY : pin.ny * iframeHeight
  return { x, y }
}

export function BrowserPinLayer(p: BrowserPinLayerProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  // The open pin's wrapper element anchors the portaled bubble (see PinBubble).
  const [openAnchor, setOpenAnchor] = useState<HTMLElement | null>(null)
  // In-flight marker drag. `moved` flips once past the click→drag threshold; a
  // sub-threshold release is treated as a click (toggles the bubble). The marker
  // captures the pointer on down, so move/up retarget to it and bubble up here.
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null)
  // The overlay div — its bounding box is the docX/docY origin (markers are
  // positioned at docX - scroll.x within it), so reposition math reuses it.
  const layerRef = useRef<HTMLDivElement>(null)
  const pins = p.pins.filter(pin => onCurrentPage(pin, p.url))

  const onPointerDown = (pin: Pin) => (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { id: pin.id, startX: e.clientX, startY: e.clientY, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    if (classifyPointerUp({ dx: e.clientX - d.startX, dy: e.clientY - d.startY }) === 'drag') {
      if (!d.moved) p.onDragActiveChange?.(true)
      d.moved = true
    }
    if (d.moved && layerRef.current) {
      // Invert the marker layout (left = docX - scroll.x): docX = (clientX - rect.left) + scroll.x.
      // No clamping — document coords can be anywhere in the page.
      const r = layerRef.current.getBoundingClientRect()
      const docX = (e.clientX - r.left) + p.scroll.x
      const docY = (e.clientY - r.top) + p.scroll.y
      p.onReposition(d.id, docX, docY)
    }
  }
  const onPointerUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.moved) p.onDragActiveChange?.(false)
    else setOpenId(cur => (cur === d.id ? null : d.id)) // sub-threshold release == click
  }

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 overflow-hidden"
      style={{ pointerEvents: 'none' }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {pins.map((pin, i) => {
        const { x, y } = docPoint(pin, p.iframeWidth, p.iframeHeight)
        const isOpen = openId === pin.id
        return (
          <div
            key={pin.id}
            className="absolute"
            ref={isOpen ? setOpenAnchor : undefined}
            style={{ left: x - p.scroll.x, top: y - p.scroll.y, pointerEvents: 'auto' }}
          >
            <PinMarker
              id={pin.id}
              index={i + 1}
              sent={!!pin.sentAt}
              accent={p.accent}
              comment={pin.comment}
              zoom={1}
              onPointerDown={onPointerDown(pin)}
            />
            {isOpen && (
              <PinBubble
                id={pin.id}
                comment={pin.comment}
                sent={!!pin.sentAt}
                canSubmit={p.canSubmit}
                anchorEl={openAnchor}
                onCommentChange={c => p.onCommentChange(pin.id, c)}
                onDelete={() => { p.onDelete(pin.id); setOpenId(null) }}
                onSubmit={(comment) => p.onSubmit(pin.id, comment)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
