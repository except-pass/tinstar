// src/hotkeys/useWidgetHotkeys.ts
import { useEffect, useRef, type RefObject } from 'react'

export type FocusZone = 'left-tab' | 'file-list' | 'center-tabs' | 'right-panel'

export interface WidgetHotkeyHandlers {
  onFocusNext: () => void
  onFocusPrev: () => void
  onFileDown: () => void
  onFileUp: () => void
  onTabNext: () => void
  onTabPrev: () => void
  onActivate: () => void
  onTerminalToggle: () => void
  terminalFocused: boolean
}

export function useWidgetHotkeys(
  rootRef: RefObject<HTMLElement | null>,
  handlers: WidgetHotkeyHandlers,
) {
  const handlersRef = useRef(handlers)
  useEffect(() => { handlersRef.current = handlers })

  useEffect(() => {
    const el = rootRef.current
    if (!el) return

    function onKeyDown(e: KeyboardEvent) {
      const h = handlersRef.current

      // All widget hotkeys suspended when terminal has focus
      if (h.terminalFocused) return

      if (e.key === 'Tab') {
        e.preventDefault()
        if (e.shiftKey) h.onFocusPrev()
        else h.onFocusNext()
        return
      }

      if (e.key === 'ArrowDown') { e.preventDefault(); h.onFileDown(); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); h.onFileUp();   return }
      if (e.key === 'ArrowRight') { e.preventDefault(); h.onTabNext();  return }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); h.onTabPrev();  return }
      if (e.key === 'Enter') { e.preventDefault(); h.onActivate();      return }

      // Ctrl+Shift+\ — terminal dive (only when terminal is NOT focused)
      if (e.code === 'Backslash' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        h.onTerminalToggle()
        return
      }
    }

    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [rootRef])
}
