import { createContext, useContext, type ReactNode } from 'react'
import { useSkills, type SkillsState, type SkillsActions } from '../hooks/useSkills'

type SkillsContextValue = SkillsState & SkillsActions

const SkillsContext = createContext<SkillsContextValue | null>(null)

export function SkillsProvider({ children }: { children: ReactNode }) {
  const skills = useSkills()
  return <SkillsContext.Provider value={skills}>{children}</SkillsContext.Provider>
}

export function useSkillsContext(): SkillsContextValue {
  const ctx = useContext(SkillsContext)
  if (!ctx) throw new Error('useSkillsContext must be used inside SkillsProvider')
  return ctx
}
