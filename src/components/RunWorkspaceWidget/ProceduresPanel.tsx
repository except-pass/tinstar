import { useTaxonomy } from '../TaxonomyContext'
import { useSkillsContext } from '../SkillsProvider'
import { resolveEntityProcedures } from '../../domain/procedures'
import type { SessionStatus } from '../../types'

interface Props {
  taskId: string
  sessionId: string
  sessionStatus: SessionStatus
  onCollapse?: () => void
  onFocusTerminal?: () => void
}

export function ProceduresPanel({ taskId, sessionId, sessionStatus, onCollapse, onFocusTerminal }: Props) {
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

  async function sendToTerminal(skillName: string) {
    if (isBusy) return
    await fetch(`/api/sessions/${sessionId}/send-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [`/${skillName} `] }),
    })
    onFocusTerminal?.()
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
                    onRun={() => sendToTerminal(proc.skillName)}
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
            onRun={() => sendToTerminal(proc.skillName)}
          />
        ))}

        {/* Optimistically added — show immediately before SSE confirms */}
        {pendingOptimistic.map(op => (
          <ProcedureRow
            key={op.id}
            name={op.skillName}
            isBusy={isBusy}
            onRun={() => sendToTerminal(op.skillName)}
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

function ProcedureRow({ name, isBusy, onRun }: { name: string; isBusy: boolean; onRun: () => void }) {
  return (
    <div
      className="group flex items-center gap-1.5 px-2 py-1.5 hover:bg-primary/5 transition-colors cursor-pointer"
      onClick={() => !isBusy && onRun()}
      title={isBusy ? 'Session is busy' : `Send /${name} to terminal`}
    >
      <span className="material-symbols-outlined text-xs text-slate-600">terminal</span>
      <span className="flex-1 text-2xs font-mono text-slate-400 group-hover:text-slate-300 truncate transition-colors" title={name}>
        {name}
      </span>
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
