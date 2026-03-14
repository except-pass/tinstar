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
  // Per-slot last-tap time for double-tap detection
  const lastTapRef = useRef<Record<string, number>>({})

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement
      if (isEditable(active) || active?.tagName === 'IFRAME') return

      // Ctrl+G — arrange grid
      if (e.key === 'g' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        handlers.onArrangeGrid()
        return
      }

      // Ctrl+Shift+G — reset layout
      if (e.key === 'G' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        e.preventDefault()
        handlers.onArrangeReset()
        return
      }

      // Hotgroup keys: 1-9, 0
      const digit = SLOTS.find(s => e.key === s)
      if (!digit || e.altKey) return

      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        handlers.onHotgroupRemove(digit)
        return
      }

      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        handlers.onHotgroupAssign(digit)
        return
      }

      // Bare digit: single or double tap
      if (!e.shiftKey) {
        e.preventDefault()
        const now = Date.now()
        const last = lastTapRef.current[digit] ?? 0
        const isDoubleTap = now - last <= 300
        lastTapRef.current[digit] = isDoubleTap ? 0 : now // reset after double-tap
        handlers.onHotgroupSelect(digit, isDoubleTap)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handlers])
}
