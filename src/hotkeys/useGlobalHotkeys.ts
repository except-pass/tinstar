// src/hotkeys/useGlobalHotkeys.ts
import { useEffect, useRef } from 'react'
import { isEditable } from './isEditable'
import { emitBindingFired } from './bindingFiredBus'

export interface GlobalHotkeyHandlers {
  onCycleReadyNext: () => void
  onCycleReadyPrev: () => void
  onCycleAllNext: () => void
  onCycleAllPrev: () => void
  onSessionQuick: () => void
  onEntitySettings: () => void
  onCreateChild: () => void
  onToggleEmptyEntities: () => void
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
        emitBindingFired('?')
        return
      }

      // S: new session — pre-fills task settings if a task is selected
      if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditable(active) || active?.tagName === 'IFRAME') return
        e.preventDefault()
        h.onSessionQuick()
        emitBindingFired('S')
        return
      }

      // E: entity settings — opens settings for the selected entity
      if ((e.key === 'e' || e.key === 'E') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditable(active) || active?.tagName === 'IFRAME') return
        e.preventDefault()
        h.onEntitySettings()
        emitBindingFired('E')
        return
      }

      // +: create child entity under the selected entity
      if (e.key === '+' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditable(active) || active?.tagName === 'IFRAME') return
        e.preventDefault()
        h.onCreateChild()
        emitBindingFired('+')
        return
      }

      // H: toggle show/hide empty entity containers (fires even from iframe)
      if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditable(active)) return
        e.preventDefault()
        h.onToggleEmptyEntities()
        emitBindingFired('H')
        return
      }

      // Session cycling: fire even from iframe (steals focus)
      // Use e.code to distinguish [ from { (Shift+[)
      // Bare brackets blocked in editable; Ctrl+brackets work everywhere (for prompt composer)
      if (e.code === 'BracketRight' && !e.shiftKey && !e.altKey) {
        const hasCtrl = e.ctrlKey || e.metaKey
        if (!hasCtrl && isEditable(active)) return
        e.preventDefault()
        h.onCycleReadyNext()
        emitBindingFired(hasCtrl ? 'Ctrl+]' : ']')
        return
      }
      if (e.code === 'BracketLeft' && !e.shiftKey && !e.altKey) {
        const hasCtrl = e.ctrlKey || e.metaKey
        if (!hasCtrl && isEditable(active)) return
        e.preventDefault()
        h.onCycleReadyPrev()
        emitBindingFired(hasCtrl ? 'Ctrl+[' : '[')
        return
      }
      if (e.code === 'BracketRight' && e.shiftKey && !e.altKey) {
        const hasCtrl = e.ctrlKey || e.metaKey
        if (!hasCtrl && isEditable(active)) return
        e.preventDefault()
        h.onCycleAllNext()
        emitBindingFired(hasCtrl ? 'Ctrl+Shift+]' : 'Shift+]')
        return
      }
      if (e.code === 'BracketLeft' && e.shiftKey && !e.altKey) {
        const hasCtrl = e.ctrlKey || e.metaKey
        if (!hasCtrl && isEditable(active)) return
        e.preventDefault()
        h.onCycleAllPrev()
        emitBindingFired(hasCtrl ? 'Ctrl+Shift+[' : 'Shift+[')
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
