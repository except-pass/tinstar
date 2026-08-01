import type { FocusCycleDirection } from '../focusMode/focusCanvas'

interface Props {
  direction: FocusCycleDirection | null
  modifier: 'Ctrl' | '⌘'
}

export function FocusCycleHint({ direction, modifier }: Props) {
  if (!direction) return null
  const shortcut = direction === 'next'
    ? `${modifier} + ]`
    : `${modifier} + [`
  const allShortcut = direction === 'next'
    ? `${modifier} + Shift + ]`
    : `${modifier} + Shift + [`
  const label = direction === 'next' ? 'next' : 'previous'

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute bottom-5 left-1/2 z-50 -translate-x-1/2 rounded border border-primary/30 bg-slate-950/95 px-3 py-2 font-mono text-xs text-slate-200 shadow-xl"
    >
      Use <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-primary">{shortcut}</kbd> for the {label} ready run
      <span className="ml-2 text-slate-500">({allShortcut} for all)</span>
    </div>
  )
}
