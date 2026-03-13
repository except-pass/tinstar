// src/components/RunWorkspaceWidget/SkillPickerModal.tsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useSkillsContext } from '../SkillsProvider'
import { useTaxonomy } from '../TaxonomyContext'
import type { SkillDTO, PendingSkill, StoredProcedure } from '../../types'

interface Props {
  taskId: string
  sessionId: string
  onClose: () => void
}

type EntityLevel = { id: string; type: 'task' | 'epic' | 'initiative'; name: string }

export function SkillPickerModal({ taskId, sessionId, onClose }: Props) {
  const { skills, loading, fetchSkills, addPendingSkill, closePicker } = useSkillsContext()
  const taxRepo = useTaxonomy()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [starPopover, setStarPopover] = useState<{ skillName: string; index: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchSkills()
    inputRef.current?.focus()
  }, [fetchSkills])

  // Build entity levels for star popover
  const entityLevels = useCallback((): EntityLevel[] => {
    const levels: EntityLevel[] = []
    const task = taxRepo.getTaskById(taskId)
    if (task) levels.push({ id: task.id, type: 'task', name: task.name })
    if (task?.epicId) {
      const epic = taxRepo.getEpicById(task.epicId)
      if (epic) {
        levels.push({ id: epic.id, type: 'epic', name: epic.name })
        if (epic.initiativeId) {
          const init = taxRepo.getInitiativeById(epic.initiativeId)
          if (init) levels.push({ id: init.id, type: 'initiative', name: init.name })
        }
      }
    }
    return levels
  }, [taskId, taxRepo])

  // Filter skills
  const filtered = query.trim()
    ? skills.filter(s => s.name.toLowerCase().includes(query.toLowerCase()))
    : skills

  const exactMatch = skills.some(s => s.name.toLowerCase() === query.toLowerCase().trim())
  const showDefineRow = query.trim().length > 0 && !exactMatch
  const totalItems = filtered.length + (showDefineRow ? 1 : 0)

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { onClose(); closePicker(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, totalItems - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIndex === filtered.length && showDefineRow) {
        handleDefine()
      }
    }
  }

  async function addProcedureToEntity(skillName: string, entityId: string, entityType: 'task' | 'epic' | 'initiative') {
    setStarPopover(null)
    const entityPath = entityType === 'task' ? 'tasks' : entityType === 'epic' ? 'epics' : 'initiatives'
    const res = await fetch(`/api/${entityPath}/${entityId}`)
    if (!res.ok) return
    const entity = await res.json() as { settings?: { procedures?: StoredProcedure[] } }
    const existing = entity.settings?.procedures ?? []
    if (existing.some(p => p.skillName === skillName)) return
    const newProcedure: StoredProcedure = { id: crypto.randomUUID(), skillName }
    await fetch(`/api/${entityPath}/${entityId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { procedures: [...existing, newProcedure] } }),
    })
  }

  function handleDefine() {
    const description = query.trim()
    if (!description) return

    const draftId = crypto.randomUUID()
    const pending: PendingSkill = {
      id: draftId,
      placeholderName: description,
      status: 'defining',
      entityId: taskId,
      entityType: 'task',
    }

    onClose()
    closePicker()
    addPendingSkill(pending)

    fetch(`/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Define a new skill [draftId=${draftId}]: ${description}` }),
    }).catch(console.error)
  }

  const systemSkills = filtered.filter(s => s.source === 'system' || s.source === 'plugin')
  const repoSkills = filtered.filter(s => s.source === 'repo')

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={() => { onClose(); closePicker() }}
    >
      <div
        className="bg-surface-panel border border-primary/25 rounded-lg overflow-hidden shadow-[0_0_40px_rgba(0,240,255,0.08),0_8px_32px_rgba(0,0,0,0.6)] w-[480px] max-h-[70vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-white/[0.07]">
          <span className="material-symbols-outlined text-base text-slate-600">search</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIndex(0) }}
            onKeyDown={handleKeyDown}
            placeholder="Search or define skill…"
            className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder-slate-600 font-mono"
          />
          {loading && (
            <span className="material-symbols-outlined text-sm text-slate-600 animate-spin">progress_activity</span>
          )}
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {systemSkills.length > 0 && (
            <>
              <div className="px-3.5 pt-2 pb-1 text-2xs font-mono text-slate-600 uppercase tracking-widest">System</div>
              {systemSkills.map((skill, i) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  active={activeIndex === i}
                  showPopover={starPopover?.skillName === skill.name}
                  entityLevels={entityLevels()}
                  onMouseEnter={() => setActiveIndex(i)}
                  onStarClick={() => setStarPopover(prev => prev?.skillName === skill.name ? null : { skillName: skill.name, index: i })}
                  onEntitySelect={(entityId, entityType) => addProcedureToEntity(skill.name, entityId, entityType)}
                />
              ))}
            </>
          )}

          {repoSkills.length > 0 && (
            <>
              <div className="mx-3.5 my-1 h-px bg-white/5" />
              <div className="px-3.5 pt-1 pb-1 text-2xs font-mono text-slate-600 uppercase tracking-widest">Repo</div>
              {repoSkills.map((skill, i) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  active={activeIndex === systemSkills.length + i}
                  showPopover={starPopover?.skillName === skill.name}
                  entityLevels={entityLevels()}
                  onMouseEnter={() => setActiveIndex(systemSkills.length + i)}
                  onStarClick={() => setStarPopover(prev => prev?.skillName === skill.name ? null : { skillName: skill.name, index: i })}
                  onEntitySelect={(entityId, entityType) => addProcedureToEntity(skill.name, entityId, entityType)}
                />
              ))}
            </>
          )}

          {/* Define row */}
          {showDefineRow && (
            <>
              <div className="mx-3.5 my-1 h-px bg-white/5" />
              <div
                className={`flex items-center gap-2 px-3.5 py-2 cursor-pointer transition-colors ${activeIndex === filtered.length ? 'bg-accent-green/[0.07]' : 'hover:bg-accent-green/[0.05]'}`}
                onClick={handleDefine}
                onMouseEnter={() => setActiveIndex(filtered.length)}
              >
                <span className="material-symbols-outlined text-sm text-accent-green">add_circle</span>
                <span className="flex-1 text-xs font-mono text-accent-green">
                  Define <span className="text-white">"{query.trim()}"</span> as new skill…
                </span>
                <span className="text-2xs text-slate-600 bg-white/[0.08] rounded px-1 py-0.5">↵</span>
              </div>
            </>
          )}

          {!loading && skills.length === 0 && !showDefineRow && (
            <div className="px-3.5 py-4 text-xs text-slate-600 font-mono text-center">
              No skills found in ~/.claude/commands/
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-3.5 py-1.5 border-t border-white/[0.06] bg-black/20">
          <span className="text-2xs text-slate-600"><span className="bg-white/[0.08] rounded px-1">↑↓</span> navigate</span>
          <span className="text-2xs text-slate-600"><span className="bg-white/[0.08] rounded px-1">⭐</span> add to procedures</span>
          <span className="text-2xs text-slate-600"><span className="bg-white/[0.08] rounded px-1">esc</span> close</span>
        </div>
      </div>
    </div>
  )
}

function SkillRow({
  skill, active, showPopover, entityLevels, onMouseEnter, onStarClick, onEntitySelect,
}: {
  skill: SkillDTO
  active: boolean
  showPopover: boolean
  entityLevels: EntityLevel[]
  onMouseEnter: () => void
  onStarClick: () => void
  onEntitySelect: (entityId: string, entityType: 'task' | 'epic' | 'initiative') => void
}) {
  const isRepo = skill.source === 'repo'

  return (
    <div
      className={`relative group flex items-center gap-2 px-3.5 py-1.5 cursor-pointer transition-colors ${active ? 'bg-primary/[0.07]' : 'hover:bg-primary/[0.04]'}`}
      onMouseEnter={onMouseEnter}
    >
      <span className="material-symbols-outlined text-sm text-slate-600 w-5 text-center flex-shrink-0">
        {isRepo ? 'folder' : 'auto_awesome'}
      </span>
      <span className={`flex-1 text-xs font-mono ${active ? 'text-primary' : 'text-slate-300'}`}>{skill.name}</span>
      {skill.description && (
        <span className="text-2xs text-slate-600 truncate max-w-[140px]">{skill.description}</span>
      )}
      <span className={`text-2xs px-1 py-0.5 rounded font-bold uppercase tracking-widest flex-shrink-0 ${isRepo ? 'bg-accent-green/[0.12] text-accent-green' : 'bg-primary/[0.12] text-primary'}`}>
        {isRepo ? 'repo' : 'sys'}
      </span>
      <button
        onClick={e => { e.stopPropagation(); onStarClick() }}
        className={`w-6 h-6 flex items-center justify-center rounded transition-colors flex-shrink-0 ${showPopover ? 'text-yellow-400 bg-yellow-400/10' : 'text-slate-600 hover:text-yellow-400 hover:bg-yellow-400/10 opacity-0 group-hover:opacity-100'}`}
      >
        <span className="material-symbols-outlined text-sm">star</span>
      </button>

      {/* Entity popover */}
      {showPopover && (
        <div
          className="absolute right-0 top-full mt-0.5 z-10 bg-surface-panel border border-yellow-400/30 rounded-md w-48 shadow-lg overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-2xs font-mono text-slate-600 uppercase tracking-widest border-b border-white/[0.06]">
            Add to procedures for…
          </div>
          {entityLevels.map((level, i) => (
            <button
              key={level.id}
              onClick={() => onEntitySelect(level.id, level.type)}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-yellow-400/[0.07] transition-colors"
            >
              <span className="material-symbols-outlined text-xs text-slate-600">
                {level.type === 'task' ? 'task_alt' : level.type === 'epic' ? 'layers' : 'rocket_launch'}
              </span>
              <span className={`flex-1 text-xs font-mono text-left ${i === 0 ? 'text-primary' : 'text-slate-400'}`}>
                {level.type.charAt(0).toUpperCase() + level.type.slice(1)}
              </span>
              <span className="text-2xs text-slate-600 truncate max-w-[80px]">{level.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
