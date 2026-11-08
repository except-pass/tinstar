import { useEffect, useRef, useState } from 'react'
import { moveAskGesture, releaseAskGesture, startAskGesture, type Gesture } from './gesture'

function canScrollLeftSwipe(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(node).overflowX) && node.scrollWidth - node.clientWidth - node.scrollLeft > 1) return true
  }
  return false
}
export function useAskGesture<T extends HTMLElement = HTMLButtonElement>(open: (() => void) | undefined, ignoreControls = false) {
  const ref = useRef<T>(null)
  const openRef = useRef(open); openRef.current = open
  const [hint, setHint] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || !openRef.current) return
    let gesture: Gesture | null = null, pointerId: number | null = null, suppressUntil = 0
    const start = (x: number, y: number) => { gesture = startAskGesture(x, y, canScrollLeftSwipe(element)); setHint(false) }
    const move = (x: number, y: number, event: Event) => {
      if (!gesture) return
      gesture = moveAskGesture(gesture, x, y)
      if (gesture.lock === 'text') {
        if (event.cancelable) event.preventDefault()
        setHint(true)
      }
    }
    const end = () => {
      const ask = releaseAskGesture(gesture)
      if (gesture?.lock === 'text') suppressUntil = Date.now() + 700
      gesture = null; setHint(false)
      if (ask) openRef.current?.()
    }
    const cancel = () => { if (gesture?.lock === 'text') suppressUntil = Date.now() + 700; gesture = null; pointerId = null; setHint(false) }
    const ignored = (event: Event) => ignoreControls && event.target instanceof Element && event.target !== element && !!event.target.closest('a,button,input,select,textarea')
    const touchStart = (e: TouchEvent) => { if (ignored(e)) return; const t = e.touches[0]; if (e.touches.length === 1 && t) start(t.clientX, t.clientY); else cancel() }
    const touchMove = (e: TouchEvent) => { const t = e.touches[0]; if (e.touches.length === 1 && t) move(t.clientX, t.clientY, e); else cancel() }
    const pointerStart = (e: PointerEvent) => {
      if (ignored(e)) return
      if (e.pointerType === 'touch' || e.button !== 0) return
      pointerId = e.pointerId; start(e.clientX, e.clientY)
      element.setPointerCapture?.(e.pointerId)
    }
    const pointerMove = (e: PointerEvent) => { if (e.pointerId === pointerId) move(e.clientX, e.clientY, e) }
    const pointerEnd = (e: PointerEvent) => { if (e.pointerId === pointerId) { end(); pointerId = null } }
    // Touch has its own cancellation lifecycle; implicit touch capture release
    // must not discard the gesture before touchend.
    const pointerCancel = (e: PointerEvent) => { if (e.pointerId === pointerId) cancel() }
    const click = (e: MouseEvent) => { if (Date.now() < suppressUntil) { e.preventDefault(); e.stopImmediatePropagation() } }
    element.addEventListener('touchstart', touchStart, { passive: true })
    element.addEventListener('touchmove', touchMove, { passive: false })
    element.addEventListener('touchend', end)
    element.addEventListener('touchcancel', cancel)
    element.addEventListener('pointerdown', pointerStart)
    element.addEventListener('pointermove', pointerMove)
    element.addEventListener('pointerup', pointerEnd)
    element.addEventListener('pointercancel', pointerCancel)
    element.addEventListener('lostpointercapture', pointerCancel)
    element.addEventListener('click', click, true)
    return () => {
      element.removeEventListener('touchstart', touchStart); element.removeEventListener('touchmove', touchMove)
      element.removeEventListener('touchend', end); element.removeEventListener('touchcancel', cancel)
      element.removeEventListener('pointerdown', pointerStart); element.removeEventListener('pointermove', pointerMove)
      element.removeEventListener('pointerup', pointerEnd); element.removeEventListener('pointercancel', pointerCancel)
      element.removeEventListener('lostpointercapture', pointerCancel); element.removeEventListener('click', click, true)
    }
  }, [!!open, ignoreControls])
  return { ref, hint }
}
