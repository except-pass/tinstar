import { useCallback } from 'react'

interface Props {
  runId: string
  targetLabel: string
  targetType: string
  onConfirm: () => void
  onCancel: () => void
}

export function ReassignDialog({ runId, targetLabel, targetType, onConfirm, onCancel }: Props) {
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onCancel()
    if (e.key === 'Enter') onConfirm()
  }, [onConfirm, onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-surface-panel border border-white/10 rounded-lg p-5 w-[360px] shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-display uppercase tracking-wider text-primary mb-3">
          Reassign Session
        </h3>
        <p className="text-xs text-slate-300 mb-4">
          Move <span className="text-primary font-mono">{runId}</span> into{' '}
          <span className="text-primary font-mono">{targetType}</span>{' '}
          <span className="text-slate-200 font-semibold">{targetLabel}</span>?
        </p>
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-xs bg-primary/20 text-primary border border-primary/40 rounded hover:bg-primary/30"
            onClick={onConfirm}
            autoFocus
          >
            Move
          </button>
        </div>
      </div>
    </div>
  )
}
