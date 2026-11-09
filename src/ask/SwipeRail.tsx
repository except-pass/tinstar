import { createPortal } from 'react-dom'
import { placeSwipeRail, type GesturePointer } from './gesture'
import './swipeRail.css'

export function SwipeRail({ x, y, pointer, dx, phase }: { x: number; y: number; pointer: GesturePointer; dx: number; phase: 'neutral' | 'ask' | 'inspect' }) {
  const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const place = placeSwipeRail({ x, y }, pointer, { width: window.innerWidth, height: window.innerHeight })
  const travel = Math.max(-90, Math.min(90, dx))
  return createPortal(<div className={`swipe-rail swipe-rail-${phase}${still ? ' swipe-rail-still' : ''}`} style={{ left: place.left, top: place.top }} data-phase={phase}>
    <div className="swipe-rail-track"><i /><i className="is-center" /><i /></div>
    <div className="swipe-rail-thumb" style={{ transform: `translateX(${travel}px)` }} />
    {phase === 'ask' && <p>Release to compose</p>}
    {phase === 'inspect' && <p>Release to open Inspector</p>}
  </div>, document.body)
}
