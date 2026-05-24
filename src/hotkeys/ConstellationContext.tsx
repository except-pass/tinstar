// src/hotkeys/ConstellationContext.tsx
import { createContext, useContext, type ReactNode } from 'react'
import { useConstellations } from '../hooks/useConstellations'

type ConstellationsReturn = ReturnType<typeof useConstellations>

const ConstellationContext = createContext<ConstellationsReturn | null>(null)

export function ConstellationProvider({
  spaceId,
  nodeIds,
  children,
}: {
  spaceId: string
  nodeIds: string[]
  children: ReactNode
}) {
  const constellations = useConstellations(spaceId, nodeIds)
  return <ConstellationContext.Provider value={constellations}>{children}</ConstellationContext.Provider>
}

export function useConstellationContext(): ConstellationsReturn {
  const ctx = useContext(ConstellationContext)
  if (!ctx) throw new Error('useConstellationContext must be used inside ConstellationProvider')
  return ctx
}
