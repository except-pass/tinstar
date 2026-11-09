import { useEffect, useRef, useState } from 'react'
import { moveAskGesture, releaseAskGesture, startAskGesture, type Gesture, type GesturePointer } from './gesture'
import { SwipeRail } from './SwipeRail'

function scrollRoom(element: Element) {
  let scrollsLeft = false, scrollsRight = false
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(node).overflowX)) continue
    if (node.scrollWidth - node.clientWidth - node.scrollLeft > 1) scrollsLeft = true
    if (node.scrollLeft > 1) scrollsRight = true
  }
  return { scrollsLeft, scrollsRight }
}
function blockingModal(element: Element) {
  const dialog = document.querySelector('dialog[open]')
  return !!dialog && !dialog.contains(element)
}
type Rail = { x: number; y: number; pointer: GesturePointer; dx: number; phase: 'neutral' | 'ask' | 'inspect' }
export function useAskGesture<T extends HTMLElement | SVGElement = HTMLButtonElement>(open: (() => void) | undefined, ignoreControls = false, inspect?: () => void) {
  const ref = useRef<T>(null)
  const openRef = useRef(open); openRef.current = open
  const inspectRef = useRef(inspect); inspectRef.current = inspect
  const [rail, setRail] = useState<Rail | null>(null)
  useEffect(() => {
    const element = ref.current
    if (!element || !openRef.current && !inspectRef.current) return
    element.dataset.askGestureSurface = ''
    let gesture: Gesture | null = null, pointerId: number | null = null, suppressUntil = 0, pointer: GesturePointer = 'mouse', ignoreLoss = false, alive = true
    const shown = (value: Rail | null) => { if (alive) setRail(value) }
    const publish = () => {
      if (!gesture || gesture.phase === 'tracking' || gesture.phase === 'native') { shown(null); return }
      shown({ x: gesture.x, y: gesture.y, pointer, dx: gesture.dx, phase: gesture.phase })
    }
    const start = (x: number, y: number, kind: GesturePointer) => {
      if (blockingModal(element)) return
      const room = scrollRoom(element)
      pointer = kind
      ignoreLoss = false
      gesture = startAskGesture(x, y, room.scrollsLeft, room.scrollsRight, !!inspectRef.current)
      shown(null)
    }
    const move = (x: number, y: number, event: Event) => {
      if (!gesture) return
      gesture = moveAskGesture(gesture, x, y)
      if (gesture.phase !== 'tracking' && gesture.phase !== 'native' && event.cancelable && event.type === 'touchmove') event.preventDefault()
      if (pointerId != null && gesture.phase !== 'tracking' && gesture.phase !== 'native') {
        try { element.setPointerCapture(pointerId) } catch { /* jsdom and a pointer that already ended */ }
      }
      publish()
    }
    const hasSelection = () => {
      const selection = window.getSelection()
      return !!selection && !selection.isCollapsed && !!selection.anchorNode && element.contains(selection.anchorNode)
    }
    const end = () => {
      if (!gesture) return
      const action = hasSelection() || blockingModal(element) ? null : releaseAskGesture(gesture)
      if (gesture.phase !== 'tracking' && gesture.phase !== 'native') suppressUntil = Date.now() + 700
      gesture = null
      shown(null)
      if (action === 'ask') openRef.current?.()
      else if (action === 'inspect') inspectRef.current?.()
    }
    const cancel = () => {
      if (gesture && gesture.phase !== 'tracking' && gesture.phase !== 'native') suppressUntil = Date.now() + 700
      gesture = null
      pointerId = null
      shown(null)
    }
    const elementAsk = () => { cancel(); suppressUntil = Date.now() + 1000 }
    const ignored = (event: Event) => event.target instanceof Element && (event.target.closest('[data-ask-gesture-surface]') !== element || ignoreControls && event.target !== element && !!event.target.closest('a,button,input,select,textarea'))
    const touchStart = (event: TouchEvent) => {
      if (ignored(event)) return
      const touch = event.touches[0]
      if (event.touches.length === 1 && touch) start(touch.clientX, touch.clientY, 'touch')
      else cancel()
    }
    const touchMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (event.touches.length === 1 && touch) move(touch.clientX, touch.clientY, event)
      else cancel()
    }
    const pointerStart = (event: PointerEvent) => {
      if (ignored(event)) return
      if (event.pointerType === 'touch' || event.button !== 0 || event.target instanceof Element && event.target.closest('[data-ask-field]')) return
      pointerId = event.pointerId
      start(event.clientX, event.clientY, event.pointerType === 'pen' ? 'pen' : 'mouse')
    }
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      if (hasSelection()) cancel()
      else move(event.clientX, event.clientY, event)
    }
    const pointerEnd = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      ignoreLoss = true
      end()
      pointerId = null
    }
    // Chrome emits lostpointercapture just before a normal touchend. Only a mouse
    // capture that is not followed by pointerup is an abandoned gesture.
    const lostCapture = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || pointerId == null) return
      const id = pointerId
      queueMicrotask(() => { if (!ignoreLoss && pointerId === id) cancel() })
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    const scrolled = () => { if (gesture) cancel() }
    const click = (event: MouseEvent) => { if (event.target instanceof Element && event.target.closest('.ask-composer')) return; if (Date.now() < suppressUntil) { event.preventDefault(); event.stopImmediatePropagation() } }
    const pointerCancel = (event: PointerEvent) => { if (event.pointerId === pointerId) cancel() }
    const bind = (target: EventTarget, type: string, listener: (event: never) => void, options?: boolean | AddEventListenerOptions) => {
      const wrapped = listener as EventListener
      target.addEventListener(type, wrapped, options)
      return () => target.removeEventListener(type, wrapped, options)
    }
    const unbind = [
      bind(element, 'tinstar:element-ask', elementAsk),
      bind(element, 'touchstart', touchStart, { passive: true }),
      bind(window, 'touchmove', touchMove, { passive: false }),
      bind(window, 'touchend', end),
      bind(window, 'touchcancel', cancel),
      bind(element, 'pointerdown', pointerStart),
      bind(window, 'pointermove', pointerMove),
      bind(window, 'pointerup', pointerEnd),
      bind(window, 'pointercancel', pointerCancel),
      bind(element, 'lostpointercapture', lostCapture),
      bind(element, 'click', click, true),
      bind(window, 'keydown', key, true),
      bind(window, 'scroll', scrolled, true),
    ]
    return () => {
      alive = false
      delete element.dataset.askGestureSurface
      unbind.forEach(remove => remove())
    }
  }, [!!open, !!inspect, ignoreControls])
  const overlay = rail ? <SwipeRail x={rail.x} y={rail.y} pointer={rail.pointer} dx={rail.dx} phase={rail.phase} /> : null
  return { ref, overlay }
}
