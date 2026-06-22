// Composes markers + bubble + click/drag gestures for one node's pins. Self-contained:
// imports no host state/hooks — the shell passes pins + callbacks. The outer layer is
// pointer-transparent (so it doesn't block the widget beneath); each pin wrapper is
// pointer-active. The marker captures the pointer on down, so move/up retarget to it
// and bubble up to the layer's handlers — letting a drag continue off the marker.
import { useCallback, useRef, useState } from 'react'
import type { Pin } from '../domain/pinSet'
import { PinMarker } from './PinMarker'
import { PinBubble } from './PinBubble'
import { clamp01, classifyPointerUp, localToNormalized } from './pinGestures'
import { useAutoOpenNewPin } from './useAutoOpenNewPin'

export interface PinLayerProps {
  pins: Pin[]
  accent: string
  zoom: number
  canSubmit: boolean
  capture?: (nx: number, ny: number) => Pin['context'] | undefined
  onReposition: (id: string, nx: number, ny: number, context?: Pin['context']) => void
  onCommentChange: (id: string, comment: string) => void
  onDelete: (id: string) => void
  onSubmit: (id: string, comment: string) => void
  onReply: (id: string, text: string) => void
  onResolve: (id: string) => void
  onReopen: (id: string) => void
  /** Fires true when a marker drag begins (first move past threshold) and false on
   *  pointer up/cancel. The shell uses this to toggle the iframe pointer guard so a
   *  reposition drag over a browser/terminal widget isn't swallowed. */
  onDragActiveChange?: (active: boolean) => void
}

export function PinLayer(p: PinLayerProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  // The open pin's wrapper element, anchoring the portaled bubble to the marker's
  // screen position. A callback ref keeps it in sync as the open pin changes.
  const [openAnchor, setOpenAnchor] = useState<HTMLElement | null>(null)
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null)
  // Live drag position, rendered from LOCAL state so the marker tracks the cursor
  // without a store write per move. Persisted once on pointer-up (see onPointerUp).
  const [dragPos, setDragPos] = useState<{ id: string; nx: number; ny: number } | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  // Per-viewer read state: wall-clock when each pin's bubble was last opened. Unread =
  // a newer agent reply exists. Never persisted/synced (read state is per-viewer).
  const [seenAt, setSeenAt] = useState<Record<string, number>>({})

  // Open a pin's bubble and mark it read. Stable so the auto-open effect below
  // doesn't re-fire on every render.
  const openPin = useCallback((id: string) => {
    setOpenId(id)
    setSeenAt(s => ({ ...s, [id]: Date.now() }))
  }, [])
  // A just-dropped note opens immediately so the user can type without a click.
  useAutoOpenNewPin(p.pins, openPin)

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
      const r = layerRef.current.getBoundingClientRect()
      const { nx, ny } = localToNormalized(e.clientX - r.left, e.clientY - r.top, r.width, r.height)
      // Local-only: no onReposition (and thus no PUT) per move — see onPointerUp.
      setDragPos({ id: d.id, nx: clamp01(nx), ny: clamp01(ny) })
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
      let nx: number, ny: number
      if (dragPos && dragPos.id === d.id) {
        nx = dragPos.nx
        ny = dragPos.ny
      } else if (layerRef.current) {
        const r = layerRef.current.getBoundingClientRect()
        const n = localToNormalized(e.clientX - r.left, e.clientY - r.top, r.width, r.height)
        nx = clamp01(n.nx)
        ny = clamp01(n.ny)
      } else {
        setDragPos(null)
        p.onDragActiveChange?.(false)
        return
      }
      p.onReposition(d.id, nx, ny, p.capture?.(nx, ny))
      setDragPos(null)
      p.onDragActiveChange?.(false)
    } else if (classifyPointerUp({ dx: e.clientX - d.startX, dy: e.clientY - d.startY }) === 'click') {
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
    <div ref={layerRef} className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none' }}
      onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
      {p.pins.map((pin, i) => {
        const isOpen = openId === pin.id
        // Render the dragged marker from live local state so it tracks the cursor
        // without a store write; all other markers from their persisted nx/ny.
        const live = dragPos?.id === pin.id ? dragPos : null
        const nx = live ? live.nx : pin.nx
        const ny = live ? live.ny : pin.ny
        return (
          <div key={pin.id} className="absolute"
            ref={isOpen ? setOpenAnchor : undefined}
            style={{ left: `${nx * 100}%`, top: `${ny * 100}%`, pointerEvents: 'auto' }}>
            <PinMarker id={pin.id} index={i + 1} sent={!!pin.sentAt} accent={p.accent} comment={pin.comment}
              zoom={p.zoom}
              resolved={!!pin.resolvedAt}
              // Unread compares server reply time (createdAt) to client open time
              // (seenAt). A lagging client clock can leave a false-positive dot that
              // clears on the next open — acceptable for a per-viewer, unsynced cue.
              unread={!isOpen && latestAgentReplyAt(pin) > (seenAt[pin.id] ?? 0)}
              onPointerDown={onPointerDown(pin)} />
            {isOpen && (
              <PinBubble id={pin.id} comment={pin.comment} sent={!!pin.sentAt} canSubmit={p.canSubmit}
                anchorEl={openAnchor}
                replies={pin.replies ?? []}
                resolved={!!pin.resolvedAt}
                onCommentChange={c => p.onCommentChange(pin.id, c)} onDelete={() => p.onDelete(pin.id)}
                onSubmit={(comment) => p.onSubmit(pin.id, comment)}
                onReply={(text) => p.onReply(pin.id, text)}
                onResolve={() => p.onResolve(pin.id)}
                onReopen={() => p.onReopen(pin.id)} />
            )}
          </div>
        )
      })}
    </div>
  )
}
