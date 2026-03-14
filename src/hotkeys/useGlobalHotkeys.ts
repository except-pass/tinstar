// src/hotkeys/useGlobalHotkeys.ts
import { useEffect } from 'react'
import { isEditable } from './isEditable'

export interface GlobalHotkeyHandlers {
  onCycleReadyNext: () => void
  onCycleReadyPrev: () => void
  onCycleAllNext: () => void
  onCycleAllPrev: () => void
  onSessionNew: () => void
  onPaletteOpen: () => void
}

export function useGlobalHotkeys(handlers: GlobalHotkeyHandlers) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement

      // Palette: suppressed inside editable elements
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditable(active)) return
        e.preventDefault()
        handlers.onPaletteOpen()
        return
      }

      // Ctrl+Enter: suppressed inside editable elements AND iframes
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (isEditable(active) || active?.tagName === 'IFRAME') return
        e.preventDefault()
        handlers.onSessionNew()
        return
      }

      // Session cycling: fire even from iframe (steals focus)
      // Use e.code to distinguish [ from { (Shift+[)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.code === 'BracketRight' && !e.shiftKey) {
          if (isEditable(active)) return
          e.preventDefault()
          handlers.onCycleReadyNext()
          return
        }
        if (e.code === 'BracketLeft' && !e.shiftKey) {
          if (isEditable(active)) return
          e.preventDefault()
          handlers.onCycleReadyPrev()
          return
        }
        if (e.code === 'BracketRight' && e.shiftKey) {
          if (isEditable(active)) return
          e.preventDefault()
          handlers.onCycleAllNext()
          return
        }
        if (e.code === 'BracketLeft' && e.shiftKey) {
          if (isEditable(active)) return
          e.preventDefault()
          handlers.onCycleAllPrev()
          return
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handlers])
}
