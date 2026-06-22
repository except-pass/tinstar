import { useState, useEffect } from 'react'

interface Props {
  /** Current value as an integer percentage (e.g. 60 for 60%). */
  value: number
  min?: number
  max?: number
  /** Called with the clamped integer percentage on commit (blur or Enter). */
  onCommit: (pct: number) => void
}

const inputClass =
  'w-20 px-2 py-1 text-xs font-mono bg-surface-base border border-white/20 rounded text-slate-200 focus:outline-none focus:border-primary/60'

/** Number input that keeps a free-typing draft and only clamps + commits on
 *  blur/Enter — so typing a value that briefly passes through an out-of-range
 *  prefix (e.g. "1" on the way to "10") doesn't snap mid-keystroke. */
export function PercentField({ value, min = 5, max = 100, onCommit }: Props) {
  const [draft, setDraft] = useState(() => String(value))

  // Re-seed when the upstream value changes (external edit / reset).
  useEffect(() => { setDraft(String(value)) }, [value])

  const commit = () => {
    const n = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(n)) { setDraft(String(value)); return }
    const clamped = Math.max(min, Math.min(max, Math.round(n)))
    setDraft(String(clamped))
    onCommit(clamped)
  }

  return (
    <input
      type="number" min={min} max={max} value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit() }}
      className={inputClass}
    />
  )
}
