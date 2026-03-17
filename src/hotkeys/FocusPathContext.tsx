// src/hotkeys/FocusPathContext.tsx
import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'
import { getWidget } from './widgetRegistry'
import type { WidgetDefinition } from './widgetTypes'

export interface FocusNode {
  id: string
  type: string
  label: string
}

interface FocusPathState {
  path: FocusNode[]
  chordState: { contextId: string } | null
}

interface FocusPathContextValue extends FocusPathState {
  pushFocus: (node: FocusNode) => void
  popFocus: () => void
  clearFocus: () => void
  setChord: (contextId: string) => void
  clearChord: () => void
}

const FocusPathContext = createContext<FocusPathContextValue>({
  path: [],
  chordState: null,
  pushFocus: () => {},
  popFocus: () => {},
  clearFocus: () => {},
  setChord: () => {},
  clearChord: () => {},
})

export function FocusPathProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState<FocusNode[]>([])
  const [chordState, setChordState] = useState<{ contextId: string } | null>(null)

  const pushFocus = useCallback((node: FocusNode) => {
    setPath(prev => [...prev, node])
  }, [])

  const popFocus = useCallback(() => {
    setPath(prev => prev.slice(0, -1))
  }, [])

  const clearFocus = useCallback(() => {
    setPath([])
    setChordState(null)
  }, [])

  const setChord = useCallback((contextId: string) => {
    setChordState({ contextId })
  }, [])

  const clearChord = useCallback(() => {
    setChordState(null)
  }, [])

  return (
    <FocusPathContext.Provider value={{ path, chordState, pushFocus, popFocus, clearFocus, setChord, clearChord }}>
      {children}
    </FocusPathContext.Provider>
  )
}

export function useFocusPath() {
  return useContext(FocusPathContext)
}

/**
 * Per-widget hook: returns the active sub-context key for this widget instance,
 * or null if not focused or no sub-context active.
 * Usage: const { activeContextKey } = useWidgetFocus(run.id)
 */
export function useWidgetFocus(widgetId: string): { activeContextKey: string | null } {
  const { path } = useFocusPath()
  const activeContextKey = useMemo(() => {
    const myIdx = path.findIndex(n => n.id === widgetId)
    if (myIdx === -1) return null
    const subNode = path[myIdx + 1]
    return subNode?.type ?? null
  }, [path, widgetId])
  return { activeContextKey }
}

/**
 * Composite hook for HotkeysSidebar: returns focus path, chord state,
 * and the active WidgetDefinition (canvas def when path is empty).
 */
export function useHotkeyContext(): {
  path: FocusNode[]
  chordState: { contextId: string } | null
  activeDefinition: WidgetDefinition | null
} {
  const { path, chordState } = useFocusPath()
  const activeDefinition = useMemo(() => {
    if (path.length === 0) return getWidget('canvas') ?? null
    const tail = path[path.length - 1]!
    return getWidget(tail.type) ?? null
  }, [path])
  return { path, chordState, activeDefinition }
}
