import { useEffect, useRef, useState } from 'react'
import type { ConstellationLink } from './constellationLinkGeometry'

interface Props {
  links: ConstellationLink[]
  /** Canvas zoom — stars counter-scale by 1/zoom so they stay a constant screen size. */
  zoom: number
}

// Keep a removed link mounted long enough to play its break (retract) animation.
const EXIT_MS = 360

/** A 4-point sparkle, sized in screen px (the wrapper counter-scales for zoom). */
function Star({ x, y, zoom, active, phase }: { x: number; y: number; zoom: number; active: boolean; phase: 'enter' | 'exit' }) {
  return (
    <div
      className={`constellation-star ${active ? 'is-active' : ''} ${phase === 'exit' ? 'is-exiting' : ''}`}
      style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
    >
      <svg width="22" height="22" viewBox="-11 -11 22 22" aria-hidden>
        <path
          className="constellation-star__shape"
          d="M0,-10 Q1.4,-1.4 10,0 Q1.4,1.4 0,10 Q-1.4,1.4 -10,0 Q-1.4,-1.4 0,-10 Z"
        />
        <circle className="constellation-star__core" r="1.6" />
      </svg>
    </div>
  )
}

function LinkShape({ link, zoom, phase }: { link: ConstellationLink; zoom: number; phase: 'enter' | 'exit' }) {
  const { a, b, active } = link
  return (
    <div
      className={`constellation-link ${active ? 'is-active' : ''} ${phase === 'exit' ? 'is-exiting' : ''}`}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
    >
      <svg style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, overflow: 'visible' }} aria-hidden>
        {/* Soft underglow + crisp core; non-scaling stroke keeps width constant across zoom. */}
        <line className="constellation-link__glow" x1={a.x} y1={a.y} x2={b.x} y2={b.y} vectorEffect="non-scaling-stroke" />
        <line
          className="constellation-link__core"
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          pathLength={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <Star x={a.x} y={a.y} zoom={zoom} active={active} phase={phase} />
      <Star x={b.x} y={b.y} zoom={zoom} active={active} phase={phase} />
    </div>
  )
}

/**
 * Decorative overlay that draws each constellation link — a star on both anchor
 * points and a connecting line, constellation-chart style — with juice on form
 * (line draws in, stars pop) and break (line retracts, stars fade). Removed
 * links stay mounted briefly so the break animation can play out.
 */
export function ConstellationLinks({ links, zoom }: Props) {
  const [exiting, setExiting] = useState<ConstellationLink[]>([])
  const prevRef = useRef<Map<string, ConstellationLink>>(new Map())
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const current = new Map(links.map(l => [l.id, l]))

    // A link that vanished from the graph → animate it out, then drop it.
    for (const [id, link] of prevRef.current) {
      if (!current.has(id) && !timersRef.current.has(id)) {
        setExiting(prev => [...prev, link])
        const t = setTimeout(() => {
          setExiting(prev => prev.filter(e => e.id !== id))
          timersRef.current.delete(id)
        }, EXIT_MS)
        timersRef.current.set(id, t)
      }
    }
    // A link that reappeared while mid-exit → cancel its exit.
    for (const id of current.keys()) {
      const t = timersRef.current.get(id)
      if (t) {
        clearTimeout(t)
        timersRef.current.delete(id)
        setExiting(prev => prev.filter(e => e.id !== id))
      }
    }
    prevRef.current = current
  }, [links])

  useEffect(() => () => { for (const t of timersRef.current.values()) clearTimeout(t) }, [])

  return (
    <div style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} data-testid="constellation-links">
      {links.map(link => (
        <LinkShape key={link.id} link={link} zoom={zoom} phase="enter" />
      ))}
      {exiting.map(link => (
        <LinkShape key={`exit-${link.id}`} link={link} zoom={zoom} phase="exit" />
      ))}
    </div>
  )
}
