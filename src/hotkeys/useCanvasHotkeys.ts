// src/hotkeys/useCanvasHotkeys.ts
import { useEffect, useRef } from 'react'
import { isEditable } from './isEditable'

export type HotgroupSlot = '1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'0'
const SLOTS: HotgroupSlot[] = ['1','2','3','4','5','6','7','8','9','0']

export interface CanvasHotkeyHandlers {
  /** Called once for single-tap, twice (isDoubleTap=true on second call) for double-tap */
  onHotgroupSelect: (slot: HotgroupSlot, isDoubleTap: boolean) => void
  onHotgroupAssign: (slot: HotgroupSlot) => void
  onHotgroupRemove: (slot: HotgroupSlot) => void
  onArrangeGrid: () => void
  onArrangeReset: () => void
}

export function useCanvasHotkeys(handlers: CanvasHotkeyHandlers) {
  const handlersRef = useRef(handlers)
  useEffect(() => { handlersRef.current = handlers })

  // Per-slot last-tap time for double-tap detection
  const lastTapRef = useRef<Record<string, number>>({})

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement
      if (isEditable(active) || active?.tagName === 'IFRAME') return
      const h = handlersRef.current

      // Ctrl+G — arrange grid (use e.code for layout-independence)
      if (e.code === 'KeyG' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        h.onArrangeGrid()
        return
      }

      // Ctrl+Shift+G — reset layout
      if (e.code === 'KeyG' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        e.preventDefault()
        h.onArrangeReset()
        return
      }

      // Hotgroup keys: 1-9, 0
      const digit = SLOTS.find(s => e.key === s)
      if (!digit || e.altKey) return

      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        h.onHotgroupRemove(digit)
        return
      }

      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        h.onHotgroupAssign(digit)
        return
      }

      // Bare digit: single or double tap
      if (!e.shiftKey) {
        e.preventDefault()
        const now = Date.now()
        const last = lastTapRef.current[digit] ?? 0
        const isDoubleTap = now - last <= 300
        lastTapRef.current[digit] = isDoubleTap ? 0 : now // reset after double-tap
        h.onHotgroupSelect(digit, isDoubleTap)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
