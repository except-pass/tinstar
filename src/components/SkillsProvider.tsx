import { createContext, useContext, type ReactNode } from 'react'
import { useSkills, type SkillsState, type SkillsActions } from '../hooks/useSkills'
import { SaveSkillModal } from './RunWorkspaceWidget/SaveSkillModal'

type SkillsContextValue = SkillsState & SkillsActions

const SkillsContext = createContext<SkillsContextValue | null>(null)

export function SkillsProvider({ children }: { children: ReactNode }) {
  const skillsState = useSkills()
  return (
    <SkillsContext.Provider value={skillsState}>
      {children}
      {skillsState.savingDraft && (
        <SaveSkillModal
          draftId={skillsState.savingDraft.draftId}
          skillName={skillsState.savingDraft.skillName}
          pendingSkillId={skillsState.savingDraft.pendingSkillId}
          sessionId={skillsState.savingDraft.sessionId}
          onClose={skillsState.clearSavingDraft}
        />
      )}
    </SkillsContext.Provider>
  )
}

export function useSkillsContext(): SkillsContextValue {
  const ctx = useContext(SkillsContext)
  if (!ctx) throw new Error('useSkillsContext must be used inside SkillsProvider')
  return ctx
}
