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
    element.dataset.askGestureSurface = ''
    let gesture: Gesture | null = null, pointerId: number | null = null, suppressUntil = 0
    const start = (x: number, y: number) => { gesture = startAskGesture(x, y, canScrollLeftSwipe(element)); setHint(false) }
    const move = (x: number, y: number, event: Event) => {
      if (!gesture) return
      gesture = moveAskGesture(gesture, x, y)
      if (gesture.lock === 'text') {
        if (event.cancelable && event.type === 'touchmove') event.preventDefault()
        setHint(true)
      }
    }
    const hasSelection = () => {
      const selection = window.getSelection()
      return !!selection && !selection.isCollapsed && !!selection.anchorNode && element.contains(selection.anchorNode)
    }
    const end = () => {
      const ask = !hasSelection() && releaseAskGesture(gesture)
      if (gesture?.lock === 'text') suppressUntil = Date.now() + 700
      gesture = null; setHint(false)
      if (ask) openRef.current?.()
    }
    const cancel = () => { if (gesture?.lock === 'text') suppressUntil = Date.now() + 700; gesture = null; pointerId = null; setHint(false) }
    const elementAsk = () => { cancel(); suppressUntil = Date.now() + 1000 }
    const ignored = (event: Event) => event.target instanceof Element && (event.target.closest('[data-ask-gesture-surface]') !== element || ignoreControls && event.target !== element && !!event.target.closest('a,button,input,select,textarea'))
    const touchStart = (e: TouchEvent) => { if (ignored(e)) return; const t = e.touches[0]; if (e.touches.length === 1 && t) start(t.clientX, t.clientY); else cancel() }
    const touchMove = (e: TouchEvent) => { const t = e.touches[0]; if (e.touches.length === 1 && t) move(t.clientX, t.clientY, e); else cancel() }
    const pointerStart = (e: PointerEvent) => {
      if (ignored(e)) return
      if (e.pointerType === 'touch' || e.button !== 0 || e.target instanceof Element && e.target.closest('[data-ask-field]')) return
      pointerId = e.pointerId; start(e.clientX, e.clientY)
    }
    const pointerMove = (e: PointerEvent) => { if (e.pointerId === pointerId) { if (hasSelection()) cancel(); else move(e.clientX, e.clientY, e) } }
    const pointerEnd = (e: PointerEvent) => { if (e.pointerId === pointerId) { end(); pointerId = null } }
    const pointerCancel = (e: PointerEvent) => { if (e.pointerId === pointerId) cancel() }
    const click = (e: MouseEvent) => { if (e.target instanceof Element && e.target.closest('.ask-composer')) return; if (Date.now() < suppressUntil) { e.preventDefault(); e.stopImmediatePropagation() } }
    element.addEventListener('tinstar:element-ask', elementAsk)
    element.addEventListener('touchstart', touchStart, { passive: true })
    element.addEventListener('touchmove', touchMove, { passive: false })
    element.addEventListener('touchend', end)
    element.addEventListener('touchcancel', cancel)
    element.addEventListener('pointerdown', pointerStart)
    window.addEventListener('pointermove', pointerMove)
    window.addEventListener('pointerup', pointerEnd)
    window.addEventListener('pointercancel', pointerCancel)
    element.addEventListener('click', click, true)
    return () => {
      delete element.dataset.askGestureSurface
      element.removeEventListener('tinstar:element-ask', elementAsk)
      element.removeEventListener('touchstart', touchStart); element.removeEventListener('touchmove', touchMove)
      element.removeEventListener('touchend', end); element.removeEventListener('touchcancel', cancel)
      element.removeEventListener('pointerdown', pointerStart); window.removeEventListener('pointermove', pointerMove)
      window.removeEventListener('pointerup', pointerEnd); window.removeEventListener('pointercancel', pointerCancel)
      element.removeEventListener('click', click, true)
    }
  }, [!!open, ignoreControls])
  return { ref, hint }
}
