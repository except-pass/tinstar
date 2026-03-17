import { useState, useCallback, useRef, useEffect } from 'react'

export interface Camera {
  x: number
  y: number
  zoom: number
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 4.0

// Quantized zoom levels — rational fractions so (zoom × DPR) is integer on
// 1×, 2×, and 3× displays, keeping terminal text crisp.
const ZOOM_LEVELS = [
  0.1, 0.125, 0.167, 0.25, 0.333,
  0.5, 0.667, 0.75,
  1.0, 1.25, 1.333, 1.5,
  2.0, 3.0, 4.0,
]

/** Step to the next zoom level in the given direction (±1). */
function stepZoom(current: number, dir: 1 | -1): number {
  if (dir === 1) {
    return ZOOM_LEVELS.find(z => z > current + 0.001) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!
  }
  return [...ZOOM_LEVELS].reverse().find(z => z < current - 0.001) ?? ZOOM_LEVELS[0]!
}

/** Snap z down to the largest zoom level that is ≤ z (for zoom-to-fit). */
function snapZoomDown(z: number): number {
  return [...ZOOM_LEVELS].reverse().find(l => l <= z + 0.001) ?? ZOOM_LEVELS[0]!
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
            x: cx - (cx - prev.x) * ratio,
            y: cy - (cy - prev.y) * ratio,
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
    // Let scrollable children handle their own scroll — but only if they can actually scroll
    const target = e.target as HTMLElement | null
    const scrollable = target?.closest('[data-scrollable]') as HTMLElement | null
    if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) {
      const atTop = scrollable.scrollTop <= 0 && e.deltaY < 0
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1 && e.deltaY > 0
      if (!atTop && !atBottom) return
    }

    e.preventDefault()
    const cam = cameraRef.current

    // Ctrl+scroll or trackpad pinch → step through quantized zoom levels toward cursor
    if (e.ctrlKey || e.metaKey) {
      const dir = e.deltaY > 0 ? -1 : 1
      const newZoom = stepZoom(cam.zoom, dir)
      const ratio = newZoom / cam.zoom
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setCamera({
        x: cx - (cx - cam.x) * ratio,
        y: cy - (cy - cam.y) * ratio,
        zoom: newZoom,
      })
    } else {
      // Plain scroll / two-finger swipe → pan
      setCamera(prev => ({
        ...prev,
        x: prev.x - e.deltaX,
        y: prev.y - e.deltaY,
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
      x: e.clientX - panStart.current.x,
      y: e.clientY - panStart.current.y,
    }))
  }, [])

  const endPan = useCallback(() => {
    isPanning.current = false
    updateCursor()
  }, [])

  // Zoom-to-fit a world-space rectangle in the viewport with padding
  const centerOn = useCallback(
    (wx: number, wy: number, ww: number, wh: number, viewportW: number, viewportH: number) => {
      const PADDING = 40 // px padding on each side
      const fitZoom = Math.min(
        (viewportW - PADDING * 2) / ww,
        (viewportH - PADDING * 2) / wh,
      )
      const zoom = snapZoomDown(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom)))
      setCamera({
        x: viewportW / 2 - (wx + ww / 2) * zoom,
        y: viewportH / 2 - (wy + wh / 2) * zoom,
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
