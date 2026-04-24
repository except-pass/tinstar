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
  onHotgroupNavigate: (slot: HotgroupSlot) => void
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

      // Quick Draw: Ctrl-modified digits only. Bare digits are free for the composer.
      const digit = SLOT_CODES[e.code]
      if (!digit) return

      const hasCtrl = e.ctrlKey || e.metaKey
      if (!hasCtrl) return

      if (e.altKey && !e.shiftKey) {
        e.preventDefault()
        h.onHotgroupAssign(digit)
        emitBindingFired('Ctrl+Alt+1–9')
        return
      }

      if (e.shiftKey && !e.altKey) {
        e.preventDefault()
        h.onHotgroupRemove(digit)
        emitBindingFired('Ctrl+Shift+1–9')
        return
      }

      if (!e.altKey && !e.shiftKey) {
        e.preventDefault()
        h.onHotgroupNavigate(digit)
        emitBindingFired('Ctrl+1–9')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
