// Pin overlay rendered OVER the rendered-markdown body so pins glue to scrolling
// content. Modeled on the browser's BrowserPinLayer (which solved the same drift
// for the iframe): each marker is positioned in DOCUMENT/content coords minus the
// scroll-container's scroll offset, so when the markdown scrolls the markers track
// the text instead of staying glued to the widget frame. The host shell owns
// placement (the corner affordance → onCreatePin); this layer only renders + edits
// existing pins. Unlike the browser there is no URL/page scoping — a file-editor
// shows one document, so every pin on the node belongs here.
//
// The layer is pointer-transparent; each pin wrapper is pointer-active. Uses the
// shared PinMarker/PinBubble so pins match every other widget's pins.
import { useCallback, useRef, useState } from 'react'
import type { Pin } from '../../../domain/pinSet'
import { PinMarker } from '../../../pins/PinMarker'
import { PinBubble } from '../../../pins/PinBubble'
import { classifyPointerUp } from '../../../pins/pinGestures'
import { useAutoOpenNewPin } from '../../../pins/useAutoOpenNewPin'

export interface FileEditorPinLayerProps {
  /** Pins for THIS node (caller passes api.pins.useNodePins(widget.id)). */
  pins: Pin[]
  /** Scroll-container scroll offset — pins are stored in content coords. Markdown
   *  only scrolls vertically (x stays 0), but the generic {x,y} shape mirrors the
   *  browser so the math is identical. */
  scroll: { x: number; y: number }
  /** Content box size, used to place not-yet-enriched (fresh) pins whose only
   *  coords are nx/ny normalized to the body box. */
  contentWidth: number
  contentHeight: number
  accent: string
  /** Whether the Send button is enabled (a backing session exists). */
  canSubmit: boolean
  onCommentChange: (id: string, comment: string) => void
  onDelete: (id: string) => void
  onSubmit: (id: string, comment: string) => void
  onReply: (id: string, text: string) => void
  onResolve: (id: string) => void
  onReopen: (id: string) => void
  /** Drag-to-reposition: fires with the new CONTENT coords (docX/docY) as the
   *  marker is dragged. Caller persists into the pin's context. */
  onReposition: (id: string, docX: number, docY: number) => void
  /** Fires true on the first drag move past threshold, false on up/cancel. */
  onDragActiveChange?: (active: boolean) => void
}

/** Content-space anchor for a marker. Enriched pins carry docX/docY (glued to
 *  content via scroll); fresh pins fall back to their box-normalized coords. */
function docPoint(pin: Pin, contentWidth: number, contentHeight: number): { x: number; y: number } {
  const ctx = pin.context
  const x = typeof ctx?.docX === 'number' ? ctx.docX : pin.nx * contentWidth
  const y = typeof ctx?.docY === 'number' ? ctx.docY : pin.ny * contentHeight
  return { x, y }
}

export function FileEditorPinLayer(p: FileEditorPinLayerProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  // The open pin's wrapper element anchors the portaled bubble (see PinBubble).
  const [openAnchor, setOpenAnchor] = useState<HTMLElement | null>(null)
  // In-flight marker drag. `moved` flips once past the click→drag threshold; a
  // sub-threshold release is treated as a click (toggles the bubble).
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null)
  // Live drag position in CONTENT coords, rendered from LOCAL state so the marker
  // tracks the cursor without a store write per move. Persisted once on pointer-up.
  const [dragPos, setDragPos] = useState<{ id: string; docX: number; docY: number } | null>(null)
  // The overlay div — its bounding box is the docX/docY origin (markers are
  // positioned at docX - scroll.x within it), so reposition math reuses it.
  const layerRef = useRef<HTMLDivElement>(null)
  // Per-viewer read state: wall-clock when each pin's bubble was last opened. Unread =
  // a newer agent reply exists. Never persisted/synced (read state is per-viewer).
  const [seenAt, setSeenAt] = useState<Record<string, number>>({})
  const pins = p.pins

  // Open a pin's bubble and mark it read. Stable so the auto-open effect doesn't
  // re-fire every render.
  const openPin = useCallback((id: string) => {
    setOpenId(id)
    setSeenAt(s => ({ ...s, [id]: Date.now() }))
  }, [])
  // A just-dropped note opens immediately so the user can type without a click.
  useAutoOpenNewPin(pins, openPin)

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
      const r = layerRef.current.getBoundingClientRect()
      const docX = (e.clientX - r.left) + p.scroll.x
      const docY = (e.clientY - r.top) + p.scroll.y
      // Local-only: no onReposition (and thus no PUT) per move — see onPointerUp.
      setDragPos({ id: d.id, docX, docY })
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) {
      setDragPos(null)
      return
    }
    if (d.moved) {
      // Persist the final position exactly once (one PUT per completed reposition).
      // Prefer the live dragPos; fall back to recomputing from the event if absent.
      if (dragPos && dragPos.id === d.id) {
        p.onReposition(d.id, dragPos.docX, dragPos.docY)
      } else if (layerRef.current) {
        const r = layerRef.current.getBoundingClientRect()
        p.onReposition(d.id, (e.clientX - r.left) + p.scroll.x, (e.clientY - r.top) + p.scroll.y)
      }
      setDragPos(null)
      p.onDragActiveChange?.(false)
    } else {
      setOpenId(cur => {
        const next = cur === d.id ? null : d.id
        if (next) setSeenAt(s => ({ ...s, [next]: Date.now() }))
        return next
      })
    }
  }
  const onPointerCancel = () => {
    const d = dragRef.current
    dragRef.current = null
    setDragPos(null) // cancel == no move: discard without persisting
    if (d?.moved) p.onDragActiveChange?.(false)
  }

  const latestAgentReplyAt = (pin: Pin): number => {
    const agent = (pin.replies ?? []).filter(r => r.author === 'agent')
    return agent.length ? agent[agent.length - 1]!.createdAt : 0
  }

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 overflow-hidden"
      style={{ pointerEvents: 'none' }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {pins.map((pin, i) => {
        // Render the dragged marker from live local content-coords so it tracks the
        // cursor without a store write; others from their persisted/derived coords.
        const live = dragPos?.id === pin.id ? dragPos : null
        const { x, y } = live ? { x: live.docX, y: live.docY } : docPoint(pin, p.contentWidth, p.contentHeight)
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
              resolved={!!pin.resolvedAt}
              unread={!isOpen && latestAgentReplyAt(pin) > (seenAt[pin.id] ?? 0)}
              onPointerDown={onPointerDown(pin)}
            />
            {isOpen && (
              <PinBubble
                id={pin.id}
                comment={pin.comment}
                sent={!!pin.sentAt}
                canSubmit={p.canSubmit}
                anchorEl={openAnchor}
                replies={pin.replies ?? []}
                resolved={!!pin.resolvedAt}
                onCommentChange={c => p.onCommentChange(pin.id, c)}
                onDelete={() => { p.onDelete(pin.id); setOpenId(null) }}
                onSubmit={(comment) => p.onSubmit(pin.id, comment)}
                onReply={(text) => p.onReply(pin.id, text)}
                onResolve={() => p.onResolve(pin.id)}
                onReopen={() => p.onReopen(pin.id)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
