// Composes markers + bubble + click/drag gestures for one node's pins. Self-contained:
// imports no host state/hooks — the shell passes pins + callbacks. The outer layer is
// pointer-transparent (so it doesn't block the widget beneath); each pin wrapper is
// pointer-active. The marker captures the pointer on down, so move/up retarget to it
// and bubble up to the layer's handlers — letting a drag continue off the marker.
import { useRef, useState } from 'react'
import type { Pin } from '../domain/pinSet'
import { PinMarker } from './PinMarker'
import { PinBubble } from './PinBubble'
import { clamp01, classifyPointerUp, localToNormalized } from './pinGestures'

export interface PinLayerProps {
  pins: Pin[]
  accent: string
  zoom: number
  canSubmit: boolean
  capture?: (nx: number, ny: number) => Pin['context'] | undefined
  onReposition: (id: string, nx: number, ny: number, context?: Pin['context']) => void
  onCommentChange: (id: string, comment: string) => void
  onDelete: (id: string) => void
  onSubmit: (id: string) => void
}

export function PinLayer(p: PinLayerProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)

  const onPointerDown = (pin: Pin) => (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { id: pin.id, startX: e.clientX, startY: e.clientY, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    if (classifyPointerUp({ dx: e.clientX - d.startX, dy: e.clientY - d.startY }) === 'drag') d.moved = true
    if (d.moved && layerRef.current) {
      const r = layerRef.current.getBoundingClientRect()
      const { nx, ny } = localToNormalized(e.clientX - r.left, e.clientY - r.top, r.width, r.height)
      p.onReposition(d.id, clamp01(nx), clamp01(ny), p.capture?.(clamp01(nx), clamp01(ny)))
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (classifyPointerUp({ dx: e.clientX - d.startX, dy: e.clientY - d.startY }) === 'click') {
      setOpenId(cur => (cur === d.id ? null : d.id))
    }
  }

  return (
    <div ref={layerRef} className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none' }}
      onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      {p.pins.map((pin, i) => (
        <div key={pin.id} className="absolute" style={{ left: `${pin.nx * 100}%`, top: `${pin.ny * 100}%`, pointerEvents: 'auto' }}>
          <PinMarker id={pin.id} index={i + 1} sent={!!pin.sentAt} accent={p.accent} comment={pin.comment}
            zoom={p.zoom} onPointerDown={onPointerDown(pin)} />
          {openId === pin.id && (
            <PinBubble id={pin.id} comment={pin.comment} sent={!!pin.sentAt} canSubmit={p.canSubmit}
              onCommentChange={c => p.onCommentChange(pin.id, c)} onDelete={() => p.onDelete(pin.id)}
              onSubmit={() => p.onSubmit(pin.id)} />
          )}
        </div>
      ))}
    </div>
  )
}
