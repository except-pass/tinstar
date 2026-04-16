// src/hotkeys/useCanvasHotkeys.ts
import { useEffect, useRef } from 'react'
import { isEditable } from './isEditable'
import { emitBindingFired } from './bindingFiredBus'

export type HotgroupSlot = '1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'0'
const SLOT_CODES: Record<string, HotgroupSlot> = {
  Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
  Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9', Digit0: '0',
  Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4', Numpad5: '5',
  Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9', Numpad0: '0',
}

export interface CanvasHotkeyHandlers {
  /** Called once for single-tap, twice (isDoubleTap=true on second call) for double-tap */
  onHotgroupSelect: (slot: HotgroupSlot, isDoubleTap: boolean) => void
  onHotgroupAssign: (slot: HotgroupSlot) => void
  onHotgroupRemove: (slot: HotgroupSlot) => void
  onArrangeGrid: () => void
  onArrangeReset: () => void
  onArrangeSwimlanes: () => void
  onToggleMinimap: () => void
  onToggleHud: () => void
}

export function useCanvasHotkeys(handlers: CanvasHotkeyHandlers) {
  const handlersRef = useRef(handlers)
  useEffect(() => { handlersRef.current = handlers })

  // Per-slot last-tap time for double-tap detection
  const lastTapRef = useRef<Record<string, number>>({})

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement
      const inEditable = isEditable(active) || active?.tagName === 'IFRAME'
      const h = handlersRef.current

      // Ctrl+G — arrange grid (use e.code for layout-independence)
      if (e.code === 'KeyG' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (inEditable) return
        e.preventDefault()
        h.onArrangeGrid()
        emitBindingFired('Ctrl+G')
        return
      }

      // Ctrl+Shift+G — reset layout
      if (e.code === 'KeyG' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        if (inEditable) return
        e.preventDefault()
        h.onArrangeReset()
        return
      }

      // Ctrl+L — swim lanes
      if (e.code === 'KeyL' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (inEditable) return
        e.preventDefault()
        h.onArrangeSwimlanes()
        emitBindingFired('Ctrl+L')
        return
      }

      // M — toggle minimap
      if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        if (inEditable) return
        e.preventDefault()
        h.onToggleMinimap()
        return
      }

      // T — toggle telemetry HUD
      if (e.code === 'KeyT' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        if (inEditable) return
        e.preventDefault()
        h.onToggleHud()
        return
      }

      // Hotgroup keys: 1-9, 0 — use e.code so Ctrl+Shift+1 works regardless of e.key value
      // Ctrl+digit works even from editable (prompt composer) for quick switching
      const digit = SLOT_CODES[e.code]
      if (!digit || e.altKey) return

      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        h.onHotgroupRemove(digit)
        return
      }

      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        h.onHotgroupAssign(digit)
        emitBindingFired('Ctrl+1–9')
        return
      }

      // Bare digit: single or double tap (blocked in editable)
      if (!e.shiftKey && !inEditable) {
        e.preventDefault()
        const now = Date.now()
        const last = lastTapRef.current[digit] ?? 0
        const isDoubleTap = now - last <= 300
        lastTapRef.current[digit] = isDoubleTap ? 0 : now // reset after double-tap
        h.onHotgroupSelect(digit, isDoubleTap)
        emitBindingFired('1–9')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
