import type { SlashCommand } from '../../lib/slashMatching'
import { hexToRgba } from '../runAccent'

interface Props {
  candidates: SlashCommand[]
  activeIndex: number
  accent: string
  onSelect: (index: number) => void
}

export function SlashChips({ candidates, activeIndex, accent, onSelect }: Props) {
  if (candidates.length === 0) return null
  return (
    <div className="flex items-center gap-1.5 text-2xs font-mono overflow-hidden">
      <span className="text-slate-600 shrink-0">tab:</span>
      {candidates.map((cmd, i) => {
        const active = i === activeIndex
        return (
          <button
            key={cmd.name}
            type="button"
            onClick={() => onSelect(i)}
            title={cmd.description}
            className="px-1.5 py-0.5 rounded transition-colors shrink-0 truncate"
            style={{
              background: active ? hexToRgba(accent, 0.2) : 'transparent',
              color: active ? accent : hexToRgba(accent, 0.45),
              border: `1px solid ${active ? hexToRgba(accent, 0.5) : 'transparent'}`,
            }}
          >
            /{cmd.name}
          </button>
        )
      })}
    </div>
  )
}
