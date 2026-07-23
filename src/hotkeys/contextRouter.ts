// src/hotkeys/contextRouter.ts
import { useEffect, useRef } from 'react'
import { isEditable } from './isEditable'
import { getWidget } from './widgetRegistry'
import { dispatchAction } from './actionHandlerRegistry'
import { emitBindingFired } from './bindingFiredBus'
import type { FocusNode } from './FocusPathContext'

/** Normalise a KeyboardEvent to the canonical "Modifier+Code" string format */
export function normalizeKey(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(e.code)
  return parts.join('+')
}

interface RouterHandlers {
  path: FocusNode[]
  chordState: { contextId: string } | null
  pushFocus: (node: FocusNode) => void
  clearFocus: () => void
  setChord: (contextId: string) => void
  clearChord: () => void
  /** Called when a context navigation or widget selection fires (triggers Hollywood Hit) */
  onNavigate?: (targetId: string) => void
  /** Called when a chord binding fires (triggers Scan Line) */
  onChordAction?: (targetId: string) => void
}

export function useContextRouter(handlers: RouterHandlers) {
  const ref = useRef(handlers)
  useEffect(() => { ref.current = handlers })

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const h = ref.current
      const active = document.activeElement
      const key = normalizeKey(e)

      // When an iframe has focus, keypresses go to the iframe — skip all bindings
      // (terminal escape is handled via postMessage from terminal-wrapper.html)
      if (active?.tagName === 'IFRAME') return

      // --- Backtick: root key (tier-1 reserved, but handled here for focus path) ---
      if (e.code === 'Backquote' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (isEditable(active)) return
        e.preventDefault()
        h.clearFocus()
        emitBindingFired('`')
        return
      }

      // --- Chord state active ---
      if (h.chordState) {
        const chordDef = getWidget(h.chordState.contextId)
        if (chordDef) {
          const binding = chordDef.bindings.find(b => b.key === key && b.chord)
          if (binding) {
            e.preventDefault()
            const tailId = h.path[h.path.length - 1]?.id
            if (tailId) {
              h.onChordAction?.(tailId)
              dispatchAction(tailId, binding.action)
            }
            emitBindingFired(binding.key)
            h.clearChord()
            return
          }
        }
        // No match in chord → ignore (don't fall through)
        return
      }

      // --- Tier-2: look up current focus tail ---
      const tail = h.path[h.path.length - 1]
      const def = tail ? getWidget(tail.type) : getWidget('canvas')
      if (!def) return

      // Check contexts (navigation)
      const ctx = def.contexts.find(c => c.key === key)
      if (ctx) {
        e.preventDefault()
        if (ctx.transient) {
          h.setChord(ctx.type)
        } else {
          const newNode: FocusNode = { id: tail?.id ?? 'canvas', type: ctx.type, label: ctx.label }
          h.pushFocus(newNode)
          h.onNavigate?.(tail?.id ?? 'canvas')
        }
        return
      }

      // Check direct bindings
      const binding = def.bindings.find(b => b.key === key && !b.chord)
      if (binding) {
        if (isEditable(active)) return
        // Dispatch FIRST. A widget can decline an action that its current state makes
        // meaningless (the Slate's j/k/x/r/c// while another zone holds focus), and a
        // declined key must fall through untouched: no preventDefault, and no
        // confirmation flash — the flash is the acknowledgement that the key DID the
        // thing, so firing it on a no-op inverts its meaning.
        const handled = tail ? dispatchAction(tail.id, binding.action) : true
        if (!handled) return
        e.preventDefault()
        if (tail) h.onChordAction?.(tail.id)
        emitBindingFired(binding.key)
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
