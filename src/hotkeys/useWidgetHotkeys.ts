// src/hotkeys/useWidgetHotkeys.ts
import { useEffect, type RefObject } from 'react'

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
  useEffect(() => {
    const el = rootRef.current
    if (!el) return

    function onKeyDown(e: KeyboardEvent) {
      // All widget hotkeys suspended when terminal has focus
      if (handlers.terminalFocused) return

      if (e.key === 'Tab') {
        e.preventDefault()
        if (e.shiftKey) handlers.onFocusPrev()
        else handlers.onFocusNext()
        return
      }

      if (e.key === 'ArrowDown') { e.preventDefault(); handlers.onFileDown(); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); handlers.onFileUp();   return }
      if (e.key === 'ArrowRight') { e.preventDefault(); handlers.onTabNext();  return }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); handlers.onTabPrev();  return }
      if (e.key === 'Enter') { e.preventDefault(); handlers.onActivate();      return }

      // Ctrl+Shift+\ — terminal dive (only when terminal is NOT focused)
      if (e.code === 'Backslash' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        handlers.onTerminalToggle()
        return
      }
    }

    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  // handlers object changes every render; use a ref or stable callbacks in practice
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRef, handlers.terminalFocused])
}
