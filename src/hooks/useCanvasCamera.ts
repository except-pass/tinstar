import { useState, useCallback, useRef, useEffect } from 'react'

export interface Camera {
  x: number
  y: number
  zoom: number
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 4.0
const ZOOM_SENSITIVITY = 0.003

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

/**
 * Can a native-scroll element actually consume this wheel delta — i.e. does it overflow
 * in the requested direction and isn't already pinned at that edge? Used to decide whether
 * to hand the wheel to a scroll container (an iframe's inner element, a data-scrollable
 * panel) or let the canvas pan instead. Pure so it's unit-testable.
 */
export function canConsumeWheel(m: ScrollMetrics, deltaX: number, deltaY: number): boolean {
  const vMax = m.scrollHeight - m.clientHeight
  const canV = vMax > 1 && deltaY !== 0 &&
    !(deltaY < 0 && m.scrollTop <= 0) && !(deltaY > 0 && m.scrollTop >= vMax - 1)
  const hMax = m.scrollWidth - m.clientWidth
  const canH = hMax > 1 && deltaX !== 0 &&
    !(deltaX < 0 && m.scrollLeft <= 0) && !(deltaX > 0 && m.scrollLeft >= hMax - 1)
  return canV || canH
}

/** Walk up from `el` to find the nearest ancestor that can consume the wheel delta, or null. */
function findScrollableAncestor(el: Element | null, deltaX: number, deltaY: number): HTMLElement | null {
  let cur: Element | null = el
  while (cur && cur instanceof HTMLElement) {
    if (canConsumeWheel(cur, deltaX, deltaY)) return cur
    cur = cur.parentElement
  }
  return null
}

export function useCanvasCamera() {
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 })
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const isPanning = useRef(false)
  const panStart = useRef({ x: 0, y: 0 })
  const spaceHeld = useRef(false)

  // Reactive cursor state (refs don't trigger re-renders, so mirror to state)
  const [cursorStyle, setCursorStyle] = useState<'default' | 'grab' | 'grabbing'>('default')

  function updateCursor() {
    if (spaceHeld.current) {
      setCursorStyle(isPanning.current ? 'grabbing' : 'grab')
    } else {
      setCursorStyle('default')
    }
  }

  // Track space key for space+drag panning, Alt+Z for reset zoom
  useEffect(() => {
    const isEditable = (el: EventTarget | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !isEditable(e.target)) {
        e.preventDefault()
        spaceHeld.current = true
        updateCursor()
      }
      // Alt+Z → reset zoom to 100%, keep current view center
      if (e.code === 'KeyZ' && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        setCamera(prev => {
          if (prev.zoom === 1) return prev
          // Keep the center of the viewport fixed
          const vw = window.innerWidth
          const vh = window.innerHeight
          const cx = vw / 2
          const cy = vh / 2
          const ratio = 1 / prev.zoom
          return {
            x: Math.round(cx - (cx - prev.x) * ratio),
            y: Math.round(cy - (cy - prev.y) * ratio),
            zoom: 1,
          }
        })
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeld.current = false
        isPanning.current = false
        updateCursor()
      }
    }
    // Global safety net: end pan on pointer cancel/leave
    const onPointerCancel = () => {
      isPanning.current = false
      updateCursor()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('pointerup', onPointerCancel)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('pointerup', onPointerCancel)
    }
  }, [])

  const handleWheel = useCallback((e: WheelEvent) => {
    const target = e.target as HTMLElement | null
    const isZoomGesture = e.ctrlKey || e.metaKey

    // Embedded browser iframes scroll their own (same-origin, proxied) document, but because
    // they sit inside the canvas's CSS transform the wheel can be delivered to the canvas
    // instead of the iframe. When the target IS the iframe, forward the scroll to the element
    // actually under the pointer inside it — not just the root window, which leaves SPAs/docs
    // viewers that keep their scroll in an inner container unscrolled. If nothing inside can
    // consume the wheel (or it's cross-origin), DON'T preventDefault — fall through to canvas
    // pan, so the iframe is never a dead zone.
    if (!isZoomGesture) {
      const iframe = (target?.tagName === 'IFRAME' ? target : target?.closest('iframe')) as HTMLIFrameElement | null
      if (iframe) {
        try {
          const doc = iframe.contentDocument
          if (doc) {
            const rect = iframe.getBoundingClientRect()
            const inner = doc.elementFromPoint(e.clientX - rect.left, e.clientY - rect.top)
            const root = doc.scrollingElement as HTMLElement | null
            const scrollable = findScrollableAncestor(inner, e.deltaX, e.deltaY)
              ?? (root && canConsumeWheel(root, e.deltaX, e.deltaY) ? root : null)
            if (scrollable) {
              scrollable.scrollBy({ left: e.deltaX, top: e.deltaY })
              e.preventDefault()
              return
            }
            // Nothing inside can scroll further → let the canvas pan.
          }
        } catch { /* cross-origin — let the canvas handle it */ }
      }
    }

    // Monaco code editor (file widget) manages its own wheel scroll; don't let the canvas hijack it.
    if (!isZoomGesture && target?.closest('.monaco-editor')) return

    // Let scrollable children handle their own scroll — but only if they can actually scroll
    const scrollable = target?.closest('[data-scrollable]') as HTMLElement | null
    if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) {
      const atTop = scrollable.scrollTop <= 0 && e.deltaY < 0
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1 && e.deltaY > 0
      if (!atTop && !atBottom) return
    }

    e.preventDefault()
    const cam = cameraRef.current

    // Ctrl+scroll or trackpad pinch → zoom toward cursor
    if (e.ctrlKey || e.metaKey) {
      const newZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, cam.zoom * (1 - e.deltaY * ZOOM_SENSITIVITY)),
      )
      const ratio = newZoom / cam.zoom
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setCamera({
        x: Math.round(cx - (cx - cam.x) * ratio),
        y: Math.round(cy - (cy - cam.y) * ratio),
        zoom: newZoom,
      })
    } else {
      // Plain scroll / two-finger swipe → pan
      setCamera(prev => ({
        ...prev,
        x: Math.round(prev.x - e.deltaX),
        y: Math.round(prev.y - e.deltaY),
      }))
    }
  }, [])

  const startPan = useCallback((e: PointerEvent) => {
    // Middle-click or space+click
    if (e.button === 1 || spaceHeld.current) {
      isPanning.current = true
      panStart.current = { x: e.clientX - cameraRef.current.x, y: e.clientY - cameraRef.current.y }
      updateCursor()
    }
  }, [])

  const movePan = useCallback((e: PointerEvent) => {
    if (!isPanning.current) return
    setCamera(prev => ({
      ...prev,
      x: Math.round(e.clientX - panStart.current.x),
      y: Math.round(e.clientY - panStart.current.y),
    }))
  }, [])

  const endPan = useCallback(() => {
    isPanning.current = false
    updateCursor()
  }, [])

  // Zoom-to-fit a world-space rectangle in the viewport with padding
  const centerOn = useCallback(
    (wx: number, wy: number, ww: number, wh: number, viewportW: number, viewportH: number, padding = 40) => {
      const fitZoom = Math.min(
        (viewportW - padding * 2) / ww,
        (viewportH - padding * 2) / wh,
      )
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom))
      setCamera({
        x: Math.round(viewportW / 2 - (wx + ww / 2) * zoom),
        y: Math.round(viewportH / 2 - (wy + wh / 2) * zoom),
        zoom,
      })
    },
    [],
  )

  return {
    camera,
    setCamera,
    cursorStyle,
    spaceHeld,
    handleWheel,
    startPan,
    movePan,
    endPan,
    centerOn,
  }
}
