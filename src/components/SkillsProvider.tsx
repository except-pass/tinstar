import { createContext, useContext, type ReactNode } from 'react'
import { useSkills, type SkillsState, type SkillsActions } from '../hooks/useSkills'
import { SaveSkillModal } from './RunWorkspaceWidget/SaveSkillModal'
import { SkillPickerModal } from './RunWorkspaceWidget/SkillPickerModal'

type SkillsContextValue = SkillsState & SkillsActions

const SkillsContext = createContext<SkillsContextValue | null>(null)

export function SkillsProvider({ children }: { children: ReactNode }) {
  const skillsState = useSkills()
  return (
    <SkillsContext.Provider value={skillsState}>
      {children}
      {skillsState.pickerContext && (
        <SkillPickerModal
          taskId={skillsState.pickerContext.taskId}
          sessionId={skillsState.pickerContext.sessionId}
          onClose={skillsState.closePicker}
        />
      )}
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
