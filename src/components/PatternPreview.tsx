// src/components/PatternPreview.tsx

import { PATTERNS, type PatternType } from '../domain/patterns'

interface Props {
  pattern: PatternType
}

export function PatternPreview({ pattern }: Props) {
  const def = PATTERNS[pattern]

  if (pattern === 'single' || def.sessions.length === 0) {
    return (
      <div className="text-xs text-slate-500 italic">
        Standard single-agent session
      </div>
    )
  }

  return (
    <div className="bg-surface-base border border-white/10 rounded p-3 mt-2">
      {/* Mini diagram */}
      <div className="relative h-20 mb-3">
        {def.layout.positions.map((pos, i) => {
          const session = def.sessions.find(s => s.nameSuffix === pos.nameSuffix)
          if (!session) return null
          const isCoordinator = pos.nameSuffix === 'coordinator'
          return (
            <div
              key={pos.nameSuffix}
              className={`absolute px-2 py-1 text-2xs rounded border transform -translate-x-1/2 -translate-y-1/2 ${
                isCoordinator
                  ? 'bg-primary/20 border-primary/40 text-primary'
                  : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
              }`}
              style={{
                left: `${pos.x * 100}%`,
                top: `${pos.y * 100}%`,
              }}
            >
              {pos.nameSuffix}
            </div>
          )
        })}
      </div>

      {/* Description */}
      <div className="text-xs text-slate-400 mb-2">{def.description}</div>

      {/* Sessions list */}
      <div className="text-2xs text-slate-500">
        <span className="text-slate-400">Creates:</span>{' '}
        {def.sessions.map(s => s.nameSuffix).join(', ')}
      </div>
    </div>
  )
}
