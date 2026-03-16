// src/hotkeys/useFlourish.ts
import { useCallback, useRef, type RefObject } from 'react'

/**
 * Returns two triggers:
 * - triggerHollywoodHit: full bloom + scan + ripple (navigation/context change)
 * - triggerScanLine: scan only (chord action)
 *
 * Usage:
 *   const divRef = useRef<HTMLDivElement>(null)
 *   const { triggerHollywoodHit, triggerScanLine } = useFlourish(divRef)
 *
 * The target element needs:
 *   - overflow-hidden (for scan line)
 *   - position: relative (for ripple ring child)
 *   - a <div className="flourish-scan-line" /> child
 *   - a <div className="flourish-ripple-ring" /> child
 */
export function useFlourish(containerRef: RefObject<HTMLElement | null>) {
  // Track active cleanup to avoid double-add
  const cleanupRef = useRef<(() => void) | null>(null)

  const clear = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }
  }, [])

  const triggerHollywoodHit = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    clear()

    const scan = el.querySelector('.flourish-scan-line') as HTMLElement | null
    const ripple = el.querySelector('.flourish-ripple-ring') as HTMLElement | null

    // Force reflow to allow re-triggering
    el.classList.remove('flourish-ignite')
    scan?.classList.remove('flourish-scan-active')
    ripple?.classList.remove('flourish-ripple-active')
    void el.offsetWidth

    el.classList.add('flourish-ignite')
    scan?.classList.add('flourish-scan-active')
    ripple?.classList.add('flourish-ripple-active')

    const onEnd = (ev: AnimationEvent) => {
      if (ev.animationName !== 'ignite') return
      el.classList.remove('flourish-ignite')
      scan?.classList.remove('flourish-scan-active')
      ripple?.classList.remove('flourish-ripple-active')
      el.removeEventListener('animationend', onEnd)
      cleanupRef.current = null
    }
    el.addEventListener('animationend', onEnd)
    cleanupRef.current = () => {
      el.removeEventListener('animationend', onEnd)
      el.classList.remove('flourish-ignite')
      scan?.classList.remove('flourish-scan-active')
      ripple?.classList.remove('flourish-ripple-active')
    }
  }, [containerRef, clear])

  const triggerScanLine = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const scan = el.querySelector('.flourish-scan-line') as HTMLElement | null
    if (!scan) return

    scan.classList.remove('flourish-scan-active')
    void scan.offsetWidth
    scan.classList.add('flourish-scan-active')

    const onEnd = () => {
      scan.classList.remove('flourish-scan-active')
      scan.removeEventListener('animationend', onEnd)
    }
    scan.addEventListener('animationend', onEnd)
  }, [containerRef])

  return { triggerHollywoodHit, triggerScanLine }
}
