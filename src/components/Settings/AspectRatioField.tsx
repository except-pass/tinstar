import { useState, useEffect } from 'react'

interface Props {
  /** Current aspect (width / height). */
  value: number
  /** Called with the new aspect (W/H) on commit (blur or Enter). */
  onChange: (aspect: number) => void
}

const inputClass =
  'w-14 px-1 py-0.5 text-2xs font-mono bg-surface-base border border-white/20 rounded text-slate-200 focus:outline-none focus:border-primary/60'

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Two-input W:H control. Displays the aspect as `value : 1` and emits W/H. */
export function AspectRatioField({ value, onChange }: Props) {
  const [w, setW] = useState(() => String(round2(value)))
  const [h, setH] = useState('1')

  // Re-seed when the upstream value changes (e.g. reset-to-default).
  useEffect(() => { setW(String(round2(value))); setH('1') }, [value])

  const commit = () => {
    const wn = Number(w)
    const hn = Number(h)
    if (wn > 0 && hn > 0) onChange(wn / hn)
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number" min={0.1} step={0.1} value={w}
        onChange={e => setW(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit() }}
        className={inputClass}
      />
      <span className="text-2xs text-slate-500">:</span>
      <input
        type="number" min={0.1} step={0.1} value={h}
        onChange={e => setH(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit() }}
        className={inputClass}
      />
    </span>
  )
}
