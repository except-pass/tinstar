// src/hotkeys/useGlobalHotkeys.ts
import { useEffect, useRef } from 'react'
import { isEditable } from './isEditable'

export interface GlobalHotkeyHandlers {
  onCycleReadyNext: () => void
  onCycleReadyPrev: () => void
  onCycleAllNext: () => void
  onCycleAllPrev: () => void
  onSessionNew: () => void
  onSessionQuick: () => void
  onPaletteOpen: () => void
}

export function useGlobalHotkeys(handlers: GlobalHotkeyHandlers) {
  const handlersRef = useRef(handlers)
  useEffect(() => { handlersRef.current = handlers })

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement
      const h = handlersRef.current

      // Palette: suppressed inside editable elements
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditable(active)) return
        e.preventDefault()
        h.onPaletteOpen()
        return
      }

      // Ctrl+Enter: suppressed inside editable elements AND iframes
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (isEditable(active) || active?.tagName === 'IFRAME') return
        e.preventDefault()
        h.onSessionNew()
        return
      }

      // S: quick new session — pre-fills task if a task is selected
      if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditable(active) || active?.tagName === 'IFRAME') return
        e.preventDefault()
        h.onSessionQuick()
        return
      }

      // Session cycling: fire even from iframe (steals focus)
      // Use e.code to distinguish [ from { (Shift+[)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.code === 'BracketRight' && !e.shiftKey) {
          if (isEditable(active)) return
          e.preventDefault()
          h.onCycleReadyNext()
          return
        }
        if (e.code === 'BracketLeft' && !e.shiftKey) {
          if (isEditable(active)) return
          e.preventDefault()
          h.onCycleReadyPrev()
          return
        }
        if (e.code === 'BracketRight' && e.shiftKey) {
          if (isEditable(active)) return
          e.preventDefault()
          h.onCycleAllNext()
          return
        }
        if (e.code === 'BracketLeft' && e.shiftKey) {
          if (isEditable(active)) return
          e.preventDefault()
          h.onCycleAllPrev()
          return
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
