import { createContext, useContext } from 'react'
import type { SkillsState, SkillsActions } from '../hooks/useSkills'

export type SkillsContextValue = SkillsState & SkillsActions

export const SkillsContext = createContext<SkillsContextValue | null>(null)

export function useSkillsContext(): SkillsContextValue {
  const ctx = useContext(SkillsContext)
  if (!ctx) throw new Error('useSkillsContext must be used inside SkillsProvider')
  return ctx
}
