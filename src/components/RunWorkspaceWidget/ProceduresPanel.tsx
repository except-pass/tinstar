interface Props {
  onCollapse?: () => void
}

export function ProceduresPanel({ onCollapse }: Props) {
  return (
    <section className="w-40 flex flex-col bg-surface-panel">
      {/* Header */}
      <div className="panel-header">
        <h3 className="panel-label">Procedures</h3>
        <div className="flex items-center gap-1.5">
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

      {/* Placeholder — will be rewritten in a later task */}
      <div data-scrollable className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1.5">
        <button className="w-full flex items-center justify-center gap-1.5 py-2 border border-dashed border-primary/20 text-primary/30 hover:text-primary/60 hover:border-primary/40 transition-all rounded-sm">
          <span className="material-symbols-outlined text-sm">add</span>
          <span className="text-2xs font-bold font-display tracking-[0.12em] uppercase">New_Procedure</span>
        </button>
      </div>
    </section>
  )
}
