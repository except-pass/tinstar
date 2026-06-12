// Pin overlay rendered OVER the iframe (never injected into the page — page CSS
// can't break pins, pins can't break the page). The browser self-renders its
// pins (registration.rendersOwnPinMarkers) so they glue to scrolling page
// content: each marker is positioned in DOCUMENT coords minus the iframe scroll
// offset. Placement is owned by the HOST shell's drag affordance (which calls
// onCreatePin → api.pins.create); this layer only renders + edits existing pins.
//
// The layer is pointer-transparent; each pin wrapper is pointer-active. Uses the
// shared PinMarker/PinBubble so it matches every other widget's pins.
import { useState } from 'react'
import type { Pin } from '../../../../domain/pinSet'
import { PinMarker } from '../../../../pins/PinMarker'
import { PinBubble } from '../../../../pins/PinBubble'

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
  onSubmit: (id: string) => void
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
  const pins = p.pins.filter(pin => onCurrentPage(pin, p.url))

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none' }}>
      {pins.map((pin, i) => {
        const { x, y } = docPoint(pin, p.iframeWidth, p.iframeHeight)
        return (
          <div
            key={pin.id}
            className="absolute"
            style={{ left: x - p.scroll.x, top: y - p.scroll.y, pointerEvents: 'auto' }}
          >
            <PinMarker
              id={pin.id}
              index={i + 1}
              sent={!!pin.sentAt}
              accent={p.accent}
              comment={pin.comment}
              zoom={1}
              onPointerDown={e => { e.stopPropagation(); setOpenId(cur => (cur === pin.id ? null : pin.id)) }}
            />
            {openId === pin.id && (
              <PinBubble
                id={pin.id}
                comment={pin.comment}
                sent={!!pin.sentAt}
                canSubmit={p.canSubmit}
                onCommentChange={c => p.onCommentChange(pin.id, c)}
                onDelete={() => { p.onDelete(pin.id); setOpenId(null) }}
                onSubmit={() => p.onSubmit(pin.id)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
