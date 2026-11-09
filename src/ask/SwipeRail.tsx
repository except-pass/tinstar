import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { placeSwipeRail, type GesturePointer } from './gesture'
import './swipeRail.css'

export function SwipeRail({ x, y, pointer, dx, phase }: { x: number; y: number; pointer: GesturePointer; dx: number; phase: 'neutral' | 'ask' | 'inspect' | 'returning' }) {
  const bounds = () => {
    const viewport = window.visualViewport
    return { width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight, left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0 }
  }
  const [viewport, setViewport] = useState(bounds)
  useEffect(() => {
    const update = () => setViewport(bounds())
    const visual = window.visualViewport
    window.addEventListener('resize', update)
    visual?.addEventListener('resize', update)
    visual?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      visual?.removeEventListener('resize', update)
      visual?.removeEventListener('scroll', update)
    }
  }, [])
  const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const place = placeSwipeRail({ x, y }, pointer, viewport)
  const travel = Math.max(-Math.min(90, place.width / 2 - 15), Math.min(Math.min(90, place.width / 2 - 15), dx))
  return createPortal(<div className={`swipe-rail swipe-rail-${phase}${still ? ' swipe-rail-still' : ''}`} style={{ left: place.left, top: place.top, width: place.width }} data-phase={phase}>
    <div className="swipe-rail-track"><i /><i className="is-center" /><i /></div>
    <div className="swipe-rail-thumb" style={{ transform: `translateX(${travel}px)`, ...(phase === 'returning' ? { animation: 'swipe-rail-return 220ms cubic-bezier(.2,.8,.3,1.15) forwards' } : {}) }} />
    {phase === 'ask' && <p>Release to compose</p>}
    {phase === 'inspect' && <p>Release to open Inspector</p>}
  </div>, document.body)
}
