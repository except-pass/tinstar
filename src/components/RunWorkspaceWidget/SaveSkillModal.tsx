// src/components/RunWorkspaceWidget/SaveSkillModal.tsx
import { useState } from 'react'
import type { StoredProcedure } from '../../types'
import { useSkillsContext } from '../SkillsProvider'

interface Props {
  draftId: string
  skillName: string
  pendingSkillId: string
  sessionId: string  // used to derive projectRoot for repo-level saves
  onClose: () => void
}

export function SaveSkillModal({ draftId, skillName, pendingSkillId, sessionId, onClose }: Props) {
  const { resolvePendingSkill, errorPendingSkill, clearSavingDraft, removePendingSkill, pendingSkills } = useSkillsContext()
  const [saving, setSaving] = useState(false)
  const [conflictError, setConflictError] = useState<string | null>(null)

  const pendingSkill = pendingSkills.find(ps => ps.id === pendingSkillId)

  async function handleSave(location: 'system' | 'repo') {
    setSaving(true)
    setConflictError(null)
    try {
      const res = await fetch('/api/skills/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId, location, sessionId }),
      })
      if (res.status === 409) {
        const data = await res.json() as { error: string; existingPath: string }
        setConflictError(`A skill already exists at: ${data.existingPath}`)
        setSaving(false)
        return
      }
      if (!res.ok) throw new Error('save failed')

      // Add procedure to the entity from pendingSkill context
      if (pendingSkill) {
        const entityPath = pendingSkill.entityType === 'task' ? 'tasks'
          : pendingSkill.entityType === 'epic' ? 'epics' : 'initiatives'
        const entityRes = await fetch(`/api/${entityPath}/${pendingSkill.entityId}`)
        if (entityRes.ok) {
          const entity = await entityRes.json() as { settings?: { procedures?: StoredProcedure[] } }
          const existing = entity.settings?.procedures ?? []
          const newProcedure: StoredProcedure = { id: crypto.randomUUID(), skillName }
          await fetch(`/api/${entityPath}/${pendingSkill.entityId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { procedures: [...existing, newProcedure] } }),
          })
        }
      }

      resolvePendingSkill(pendingSkillId, skillName)
      clearSavingDraft()
      onClose()
    } catch {
      errorPendingSkill(pendingSkillId)
      clearSavingDraft()
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center">
      <div className="bg-surface-panel border border-yellow-400/30 rounded-lg p-5 w-80 shadow-xl">
        <h3 className="text-sm font-mono text-white mb-1">Save new skill</h3>
        <p className="text-2xs font-mono text-slate-500 mb-4">
          <span className="text-primary">{skillName}</span> — where should it live?
        </p>

        {conflictError && (
          <div className="mb-3 p-2 bg-accent-red/10 border border-accent-red/20 rounded text-2xs font-mono text-accent-red">
            {conflictError}
          </div>
        )}

        <div className="flex flex-col gap-2 mb-4">
          <button
            onClick={() => handleSave('system')}
            disabled={saving}
            className="flex items-center gap-2 p-3 border border-white/10 hover:border-primary/40 hover:bg-primary/5 rounded transition-colors disabled:opacity-40 text-left"
          >
            <span className="material-symbols-outlined text-base text-slate-500">home</span>
            <div>
              <div className="text-xs font-mono text-white">System</div>
              <div className="text-2xs font-mono text-slate-600">~/.claude/commands/</div>
            </div>
          </button>
          <button
            onClick={() => handleSave('repo')}
            disabled={saving}
            className="flex items-center gap-2 p-3 border border-white/10 hover:border-accent-green/40 hover:bg-accent-green/5 rounded transition-colors disabled:opacity-40 text-left"
          >
            <span className="material-symbols-outlined text-base text-slate-500">folder</span>
            <div>
              <div className="text-xs font-mono text-white">Repo</div>
              <div className="text-2xs font-mono text-slate-600">.claude/commands/</div>
            </div>
          </button>
        </div>

        <button
          onClick={async () => {
            await fetch('/api/skills/discard', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ draftId }),
            }).catch(() => {})
            removePendingSkill(pendingSkillId)
            clearSavingDraft()
            onClose()
          }}
          className="w-full text-2xs font-mono text-slate-600 hover:text-slate-400 transition-colors py-1"
        >
          Cancel — discard draft
        </button>
      </div>
    </div>
  )
}
