import type { PointerEvent as ReactPointerEvent } from 'react'
import type { RunData, SessionStatus } from '../../types'

const statusConfig: Record<SessionStatus, { label: string; color: string; dot: string; pulse?: boolean }> = {
  creating: { label: 'CREATING', color: 'text-blue-400', dot: 'bg-blue-400 shadow-[0_0_6px_#818cf8]', pulse: true },
  running: { label: 'RUNNING', color: 'text-accent-green', dot: 'bg-accent-green shadow-[0_0_6px_#00ff88]', pulse: true },
  idle: { label: 'IDLE', color: 'text-accent-amber', dot: 'bg-accent-amber shadow-[0_0_6px_#ffaa00]' },
  needs_attention: { label: 'ATTENTION', color: 'text-orange-400', dot: 'bg-orange-400 shadow-[0_0_6px_#f97316]', pulse: true },
  stopped: { label: 'STOPPED', color: 'text-slate-400', dot: 'bg-slate-500' },
}

interface Props {
  run: RunData
  compact?: boolean
  onPointerDown?: (e: ReactPointerEvent) => void
  onPointerMove?: (e: ReactPointerEvent) => void
  onPointerUp?: (e: ReactPointerEvent) => void
}

export function RunWorkspaceHeader({ run, compact = false, onPointerDown, onPointerMove, onPointerUp }: Props) {
  const status = statusConfig[run.status]

  return (
    <header
      className="flex items-center justify-between border-b border-primary/25 bg-surface-panel px-3 py-1.5 overflow-hidden cursor-grab active:cursor-grabbing select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Left: identity */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center justify-center w-6 h-6 border border-primary/60 bg-primary/10 shrink-0">
          <span className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>
            terminal
          </span>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-2xs font-bold text-primary tracking-[0.15em] uppercase font-display neon-text leading-none truncate">
              Run_{run.id}
            </h1>
            <div className={`flex items-center gap-1 ${status.color} shrink-0`}>
              <span className={`w-1.5 h-1.5 rounded-full ${status.dot} ${status.pulse ? 'animate-pulse-glow' : ''}`} />
              <span className="text-2xs font-bold tracking-[0.1em] font-mono uppercase">{status.label}</span>
            </div>
          </div>
          {!compact && (
            <nav className="flex items-center gap-1 mt-0.5">
              {[run.initiative, run.epic, run.task].map((segment, i, arr) => (
                <span key={i} className="flex items-center gap-1">
                  <span className={`text-2xs font-mono tracking-wide truncate ${i === arr.length - 1 ? 'text-primary/80' : 'text-slate-500'}`}>
                    {segment}
                  </span>
                  {i < arr.length - 1 && (
                    <span className="text-primary/20 text-2xs">&gt;</span>
                  )}
                </span>
              ))}
            </nav>
          )}
        </div>
      </div>

      {/* Right: meta — hidden in compact tile mode */}
      {!compact && (
        <div className="flex items-center gap-3 shrink-0 ml-2">
          <div className="text-right">
            <div className="text-2xs font-mono text-slate-500 tracking-wide">WORKTREE</div>
            <div className="text-2xs font-mono text-primary/70 truncate max-w-[100px]">{run.worktree}</div>
          </div>
          <div className="text-right">
            <div className="text-2xs font-mono text-slate-500 tracking-wide">REPO</div>
            <div className="text-2xs font-mono text-primary/70 truncate max-w-[100px]">{run.repo}</div>
          </div>
        </div>
      )}
    </header>
  )
}
