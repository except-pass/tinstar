import { type ReactNode } from 'react'
import { useSkills } from '../hooks/useSkills'
import { SkillsContext } from './SkillsContext'
import { SaveSkillModal } from './RunWorkspaceWidget/SaveSkillModal'
import { SkillPickerModal } from './RunWorkspaceWidget/SkillPickerModal'

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
