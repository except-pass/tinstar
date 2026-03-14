import { useState, useCallback, type PointerEvent as ReactPointerEvent } from 'react'
import type { RunData, SessionStatus } from '../../types'
import { useHotgroupContext } from '../../hotkeys/HotgroupContext'
import { HotgroupBadge } from '../HotgroupBadge'

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
  onRefreshTerminal?: () => void
}

export function RunWorkspaceHeader({ run, compact = false, onPointerDown, onPointerMove, onPointerUp, onRefreshTerminal }: Props) {
  const status = statusConfig[run.status]
  const [busy, setBusy] = useState(false)
  const { slotsForRun } = useHotgroupContext()

  const sessionAction = useCallback(async (action: 'stop' | 'delete' | 'start') => {
    setBusy(true)
    try {
      if (action === 'delete') {
        await fetch(`/api/sessions/${run.sessionId}`, { method: 'DELETE' })
      } else {
        await fetch(`/api/sessions/${run.sessionId}/${action}`, { method: 'POST' })
      }
    } catch { /* ignore */ }
    setBusy(false)
  }, [run.sessionId])

  const refreshTerminal = useCallback(() => {
    if (!run.sessionId) return
    fetch(`/api/sessions/${run.sessionId}/refresh-route`, { method: 'POST' })
      .finally(() => onRefreshTerminal?.())
  }, [run.sessionId, onRefreshTerminal])

  const isLive = run.status === 'running' || run.status === 'idle' || run.status === 'needs_attention' || run.status === 'creating'

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
            {run.backend === 'docker' ? 'deployed_code' : 'terminal'}
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

      {/* Right: actions + meta */}
      {!compact && (
        <div className="flex items-center gap-3 shrink-0 ml-2">
          {/* Hotgroup badge */}
          <HotgroupBadge slots={slotsForRun(run.id)} testId={`hotgroup-badge-${run.id}`} />
          {/* Session actions */}
          <div className="flex items-center gap-1" onPointerDown={e => e.stopPropagation()}>
            {isLive ? (
              <button
                onClick={() => sessionAction('stop')}
                disabled={busy}
                className="p-1 rounded text-slate-500 hover:text-accent-red transition-colors disabled:opacity-50"
                title="Stop session"
              >
                <span className="material-symbols-outlined text-sm">stop_circle</span>
              </button>
            ) : (
              <button
                onClick={() => sessionAction('start')}
                disabled={busy}
                className="p-1 rounded text-slate-500 hover:text-accent-green transition-colors disabled:opacity-50"
                title="Resume session"
              >
                <span className="material-symbols-outlined text-sm">play_circle</span>
              </button>
            )}
            {isLive && run.port && (
              <button
                onClick={refreshTerminal}
                className="p-1 rounded text-slate-500 hover:text-primary transition-colors"
                title="Refresh terminal (re-registers proxy route)"
              >
                <span className="material-symbols-outlined text-sm">refresh</span>
              </button>
            )}
            <button
              onClick={() => sessionAction('delete')}
              disabled={busy}
              className="p-1 rounded text-slate-500 hover:text-accent-red transition-colors disabled:opacity-50"
              title="Delete session"
            >
              <span className="material-symbols-outlined text-sm">delete</span>
            </button>
          </div>
          <div className="w-px h-5 bg-white/10" />
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
