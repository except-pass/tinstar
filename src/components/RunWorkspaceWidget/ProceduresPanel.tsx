import { useRef, useState } from 'react'
import { useTaxonomy } from '../TaxonomyContext'
import { useSkillsContext } from '../SkillsProvider'
import { resolveEntityProcedures } from '../../domain/procedures'
import type { SessionStatus } from '../../types'

interface Props {
  taskId: string
  sessionId: string
  sessionStatus: SessionStatus
  onCollapse?: () => void
}

export function ProceduresPanel({ taskId, sessionId, sessionStatus, onCollapse }: Props) {
  const taxRepo = useTaxonomy()
  const { pendingSkills, openPicker, optimisticProcedures } = useSkillsContext()
  const resolved = resolveEntityProcedures(taskId, taxRepo)

  // Collect entity IDs in scope for this task (task + epic + initiative)
  const task = taxRepo.getTaskById(taskId)
  const epic = task?.epicId ? taxRepo.getEpicById(task.epicId) : undefined
  const entityIds = new Set<string>([taskId, task?.epicId, epic?.initiativeId].filter(Boolean) as string[])

  // Optimistic procedures not yet confirmed by SSE delta
  const resolvedSkillNames = new Set(resolved.map(p => p.skillName))
  const pendingOptimistic = optimisticProcedures.filter(
    op => entityIds.has(op.entityId) && !resolvedSkillNames.has(op.skillName)
  )

  const taskProcs = resolved.filter(p => p.entityType === 'task')
  const inheritedProcs = resolved.filter(p => p.entityType !== 'task')

  const isBusy = sessionStatus === 'running'

  async function runProcedure(skillName: string, args?: string) {
    if (isBusy) return
    const text = args ? `/${skillName} ${args}` : `/${skillName}`
    await fetch(`/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  }

  // Group inherited by entity
  const inheritedByEntity: Map<string, { name: string; type: string; procs: typeof inheritedProcs }> = new Map()
  for (const p of inheritedProcs) {
    if (!inheritedByEntity.has(p.entityId)) {
      const entity = p.entityType === 'epic'
        ? taxRepo.getEpicById(p.entityId)
        : taxRepo.getInitiativeById(p.entityId)
      inheritedByEntity.set(p.entityId, {
        name: entity?.name ?? p.entityType,
        type: p.entityType,
        procs: [],
      })
    }
    inheritedByEntity.get(p.entityId)!.procs.push(p)
  }

  const taskPendingSkills = pendingSkills.filter(ps => ps.entityId === taskId)

  return (
    <section className="w-40 flex flex-col bg-surface-panel">
      <div className="panel-header">
        <h3 className="panel-label">Procedures</h3>
        <div className="flex items-center gap-1.5">
          <span className="text-2xs font-mono text-slate-600">{resolved.length + pendingOptimistic.length}</span>
          {onCollapse && (
            <button
              data-testid="collapse-procedures"
              onClick={onCollapse}
              className="text-slate-500 hover:text-primary ml-1"
            >
              <span className="material-symbols-outlined text-sm">chevron_right</span>
            </button>
          )}
        </div>
      </div>

      <div data-scrollable className="flex-1 overflow-y-auto scrollbar-thin">
        {/* Inherited procedures */}
        {inheritedByEntity.size > 0 && (
          <>
            {Array.from(inheritedByEntity.values()).map(({ name, procs }) => (
              <div key={name}>
                <div className="px-2 pt-2 pb-0.5 text-2xs font-mono text-slate-600 uppercase tracking-widest truncate" title={name}>
                  {name}
                </div>
                {procs.map(proc => (
                  <ProcedureRow
                    key={proc.id}
                    name={proc.skillName}
                    isBusy={isBusy}
                    onRun={(args) => runProcedure(proc.skillName, args)}
                  />
                ))}
              </div>
            ))}
            {taskProcs.length > 0 && (
              <div className="mx-2 my-1 h-px bg-primary/10" />
            )}
          </>
        )}

        {/* Task-own procedures */}
        {taskProcs.map(proc => (
          <ProcedureRow
            key={proc.id}
            name={proc.skillName}
            isBusy={isBusy}
            onRun={(args) => runProcedure(proc.skillName, args)}
          />
        ))}

        {/* Optimistically added — show immediately before SSE confirms */}
        {pendingOptimistic.map(op => (
          <ProcedureRow
            key={op.id}
            name={op.skillName}
            isBusy={isBusy}
            onRun={(args) => runProcedure(op.skillName, args)}
          />
        ))}

        {/* Shimmer rows for pending skills */}
        {taskPendingSkills.map(ps => (
          <PendingRow key={ps.id} skill={ps} />
        ))}

        {/* Empty state */}
        {resolved.length === 0 && taskPendingSkills.length === 0 && pendingOptimistic.length === 0 && (
          <div className="px-2 py-3 text-2xs font-mono text-slate-700 text-center">
            No procedures yet
          </div>
        )}
      </div>

      <button
        data-testid="new-procedure-btn"
        onClick={() => openPicker(taskId, sessionId)}
        className="m-2 flex items-center justify-center gap-1.5 py-1.5 border border-dashed border-primary/20 text-primary/40 hover:text-primary/70 hover:border-primary/40 transition-all rounded-sm"
      >
        <span className="material-symbols-outlined text-sm">add</span>
        <span className="text-2xs font-bold font-display tracking-[0.12em] uppercase">Add / Remove</span>
      </button>
    </section>
  )
}

function ProcedureRow({ name, isBusy, onRun }: { name: string; isBusy: boolean; onRun: (args?: string) => void }) {
  const [argsMode, setArgsMode] = useState(false)
  const [args, setArgs] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function startArgsMode() {
    setArgsMode(true)
    setArgs('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function submit() {
    onRun(args.trim() || undefined)
    setArgsMode(false)
    setArgs('')
  }

  function cancel() {
    setArgsMode(false)
    setArgs('')
  }

  if (argsMode) {
    return (
      <div className="px-2 py-1.5 bg-primary/5">
        <div className="text-2xs font-mono text-slate-600 mb-1 truncate">/{name}</div>
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            value={args}
            onChange={e => setArgs(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); submit() }
              if (e.key === 'Escape') { e.preventDefault(); cancel() }
            }}
            placeholder="args…"
            className="min-w-0 flex-1 bg-black/30 border border-primary/20 rounded-sm px-1.5 py-0.5 text-2xs font-mono text-white placeholder-slate-600 outline-none focus:border-primary/40"
          />
          <button onClick={submit} title="Send" className="text-primary hover:text-primary/70 flex-shrink-0">
            <span className="material-symbols-outlined text-sm">send</span>
          </button>
          <button onClick={cancel} title="Cancel" className="text-slate-600 hover:text-slate-400 flex-shrink-0">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="group flex items-center gap-1.5 px-2 py-1.5 hover:bg-primary/5 transition-colors">
      <span className="material-symbols-outlined text-xs text-slate-600">terminal</span>
      <span className="flex-1 text-2xs font-mono text-slate-400 truncate" title={name}>
        {name}
      </span>
      <button
        onClick={startArgsMode}
        disabled={isBusy}
        title={isBusy ? 'Session is busy' : `Run /${name}`}
        className="opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-20 disabled:cursor-not-allowed text-primary hover:text-primary/70"
      >
        <span className="material-symbols-outlined text-sm">play_arrow</span>
      </button>
    </div>
  )
}

function PendingRow({ skill }: { skill: import('../../types').PendingSkill }) {
  const { removePendingSkill } = useSkillsContext()
  const isError = skill.status === 'error'

  return (
    <div className={`group flex items-center gap-1.5 px-2 py-1.5 transition-colors ${isError ? 'bg-accent-red/5' : ''}`}>
      <span className={`material-symbols-outlined text-xs ${isError ? 'text-accent-red/60' : 'text-slate-600'}`}>
        {isError ? 'error' : 'hourglass_empty'}
      </span>
      <span className={`flex-1 text-2xs font-mono truncate ${isError ? 'text-accent-red/70' : 'text-slate-600 animate-pulse'}`} title={skill.placeholderName}>
        {skill.placeholderName}
      </span>
      {isError && (
        <button
          onClick={() => removePendingSkill(skill.id)}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-600 hover:text-slate-400"
          title="Dismiss"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      )}
    </div>
  )
}
