interface Props {
  focusMode: boolean
  onChange: (focusMode: boolean) => void
  className?: string
}

export function FocusModeToggle({ focusMode, onChange, className = '' }: Props) {
  return (
    <button
      type="button"
      aria-pressed={focusMode}
      aria-label={focusMode ? 'Return to Canvas view' : 'Switch to Focus view'}
      title={focusMode ? 'Return to Canvas view' : 'Switch to Focus view'}
      data-testid="focus-mode-toggle"
      onClick={() => onChange(!focusMode)}
      className={`inline-flex h-8 items-center gap-1.5 rounded border border-white/15 bg-surface-panel/95 px-2.5 text-2xs font-mono uppercase tracking-wider text-slate-300 shadow-lg backdrop-blur hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
    >
      <span className="material-symbols-outlined text-sm" aria-hidden="true">
        {focusMode ? 'grid_view' : 'center_focus_strong'}
      </span>
      <span>{focusMode ? 'Canvas' : 'Focus'}</span>
    </button>
  )
}
