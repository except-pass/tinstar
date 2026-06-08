// src/hotkeys/ConstellationContext.tsx
import { createContext, useContext, type ReactNode } from 'react'
import { useConstellationGraph } from '../hooks/useConstellationGraph'

type ConstellationsReturn = ReturnType<typeof useConstellationGraph>

const ConstellationContext = createContext<ConstellationsReturn | null>(null)

export function ConstellationProvider({
  spaceId,
  // nodeIds: kept in signature for caller compatibility; pruning moved server-side in a later task
  nodeIds: _nodeIds,
  children,
}: {
  spaceId: string
  nodeIds: string[]
  children: ReactNode
}) {
  const constellations = useConstellationGraph(spaceId)
  return <ConstellationContext.Provider value={constellations}>{children}</ConstellationContext.Provider>
}

export function useConstellationContext(): ConstellationsReturn {
  const ctx = useContext(ConstellationContext)
  if (!ctx) throw new Error('useConstellationContext must be used inside ConstellationProvider')
  return ctx
}
