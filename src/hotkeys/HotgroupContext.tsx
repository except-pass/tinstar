// src/hotkeys/HotgroupContext.tsx
import { createContext, useContext, type ReactNode } from 'react'
import { useHotgroups } from '../hooks/useHotgroups'

type HotgroupsReturn = ReturnType<typeof useHotgroups>

const HotgroupContext = createContext<HotgroupsReturn | null>(null)

export function HotgroupProvider({
  spaceId,
  runIds,
  children,
}: {
  spaceId: string
  runIds: string[]
  children: ReactNode
}) {
  const hotgroups = useHotgroups(spaceId, runIds)
  return <HotgroupContext.Provider value={hotgroups}>{children}</HotgroupContext.Provider>
}

export function useHotgroupContext(): HotgroupsReturn {
  const ctx = useContext(HotgroupContext)
  if (!ctx) throw new Error('useHotgroupContext must be used inside HotgroupProvider')
  return ctx
}
