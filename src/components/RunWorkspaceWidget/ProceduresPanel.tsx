import type { Procedure, ProcedureStatus } from '../../types'

const statusDisplay: Record<ProcedureStatus, { icon: string; label?: string; btnClass: string; iconClass: string }> = {
  idle: {
    icon: 'play_arrow',
    btnClass: 'bg-primary/15 text-primary hover:bg-primary hover:text-surface-base',
    iconClass: '',
  },
  queued: {
    icon: 'hourglass_empty',
    label: 'In Queue...',
    btnClass: 'bg-primary text-surface-base',
    iconClass: 'animate-spin',
  },
  running: {
    icon: 'stop',
    label: 'Running...',
    btnClass: 'bg-accent-amber text-surface-base',
    iconClass: '',
  },
  complete: {
    icon: 'check',
    label: 'Done',
    btnClass: 'bg-accent-green/20 text-accent-green',
    iconClass: '',
  },
  failed: {
    icon: 'close',
    label: 'Failed',
    btnClass: 'bg-accent-red/20 text-accent-red',
    iconClass: '',
  },
}

interface Props {
  procedures: Procedure[]
  onCollapse?: () => void
}

export function ProceduresPanel({ procedures, onCollapse }: Props) {
  return (
    <section className="w-40 flex flex-col bg-surface-panel">
      {/* Header */}
      <div className="panel-header">
        <h3 className="panel-label">Procedures</h3>
        <div className="flex items-center gap-1.5">
          <span className="text-2xs font-mono text-slate-600">{procedures.length}</span>
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

      {/* Procedure list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1.5">
        {procedures.map((proc) => {
          const display = statusDisplay[proc.status]
          const isActive = proc.status === 'queued' || proc.status === 'running'

          return (
            <div
              key={proc.id}
              className={`
                group relative p-2 rounded-sm transition-all cursor-pointer
                ${isActive
                  ? 'bg-primary/10 border border-primary/50 shadow-neon'
                  : 'bg-surface-base border border-primary/15 hover:border-primary/40 hover:shadow-neon'
                }
              `}
            >
              {/* Active indicator bar */}
              {isActive && (
                <div className="absolute inset-y-0 left-0 w-0.5 bg-primary rounded-l-sm" />
              )}

              {/* Name */}
              <div className="flex items-center justify-between mb-1.5">
                <span className={`text-2xs font-bold font-display tracking-[0.12em] uppercase ${isActive ? 'text-primary neon-text' : 'text-primary/80 group-hover:text-primary'}`}>
                  {proc.name}
                </span>
              </div>

              {/* Command + action */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  {display.label && (
                    <>
                      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-primary animate-pulse-glow shadow-[0_0_4px_#00f0ff]' : proc.status === 'complete' ? 'bg-accent-green' : 'bg-accent-red'}`} />
                      <span className={`text-2xs font-mono uppercase ${isActive ? 'text-primary/80' : proc.status === 'complete' ? 'text-accent-green/70' : 'text-accent-red/70'}`}>
                        {display.label}
                      </span>
                    </>
                  )}
                  {!display.label && (
                    <span className="text-2xs font-mono text-slate-600 truncate uppercase">
                      {proc.command}
                    </span>
                  )}
                </div>
                <button
                  className={`shrink-0 w-5 h-5 flex items-center justify-center rounded-sm transition-colors ${display.btnClass}`}
                >
                  <span className={`material-symbols-outlined text-sm ${display.iconClass}`}>
                    {display.icon}
                  </span>
                </button>
              </div>
            </div>
          )
        })}

        {/* Add new */}
        <button className="w-full flex items-center justify-center gap-1.5 py-2 border border-dashed border-primary/20 text-primary/30 hover:text-primary/60 hover:border-primary/40 transition-all rounded-sm">
          <span className="material-symbols-outlined text-sm">add</span>
          <span className="text-2xs font-bold font-display tracking-[0.12em] uppercase">New_Procedure</span>
        </button>
      </div>

    </section>
  )
}
