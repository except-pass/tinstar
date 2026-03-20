import { useState, useRef, useCallback, useEffect, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { RunData, SessionStatus } from '../../types'
import { useHotgroupContext } from '../../hotkeys/HotgroupContext'
import { HotgroupBadge } from '../HotgroupBadge'
import { hexToRgba, resolveRunAccent } from '../runAccent'
import { ColorPalette } from '../ColorPalette'

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
  const runAccent = resolveRunAccent(run.color)
  const [busy, setBusy] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [palettePos, setPalettePos] = useState<{ top: number; right: number } | null>(null)
  const paletteRef = useRef<HTMLDivElement>(null)
  const paletteButtonRef = useRef<HTMLButtonElement>(null)
  const { slotsForNode } = useHotgroupContext()

  // Close palette when clicking outside both the dropdown and the toggle button
  useEffect(() => {
    if (!paletteOpen) return
    function onDown(e: MouseEvent) {
      const target = e.target as Node
      const inPalette = paletteRef.current?.contains(target)
      const inButton = paletteButtonRef.current?.contains(target)
      if (!inPalette && !inButton) setPaletteOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [paletteOpen])

  const handleColorChange = useCallback(async (color: string) => {
    setPaletteOpen(false)
    await fetch(`/api/runs/${run.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
    })
  }, [run.id])

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
    onRefreshTerminal?.()
  }, [onRefreshTerminal])

  const isLive = run.status === 'running' || run.status === 'idle' || run.status === 'needs_attention' || run.status === 'creating'

  return (
    <header
      className="widget-drag-handle flex items-center justify-between bg-surface-panel px-3 py-1.5 overflow-hidden cursor-grab active:cursor-grabbing select-none"
      style={{ borderBottom: `1px solid ${hexToRgba(runAccent, 0.25)}` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragStart={e => e.preventDefault()}
    >
      {/* Left: identity */}
      <div className="flex items-center gap-2 min-w-0">
        <div
          className="flex items-center justify-center w-6 h-6 border shrink-0"
          style={{ borderColor: hexToRgba(runAccent, 0.6), backgroundColor: hexToRgba(runAccent, 0.1) }}
        >
          <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1", color: runAccent }}>
            {run.backend === 'docker' ? 'deployed_code' : 'terminal'}
          </span>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1
              className="text-2xs font-bold tracking-[0.15em] uppercase font-display leading-none truncate"
              style={{ color: runAccent }}
            >
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
                  <span
                    className={`text-2xs font-mono tracking-wide truncate ${i === arr.length - 1 ? '' : 'text-slate-500'}`}
                    style={i === arr.length - 1 ? { color: hexToRgba(runAccent, 0.8) } : undefined}
                  >
                    {segment}
                  </span>
                  {i < arr.length - 1 && (
                    <span className="text-2xs" style={{ color: hexToRgba(runAccent, 0.2) }}>&gt;</span>
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
          <HotgroupBadge slots={slotsForNode(`run-${run.id}`)} testId={`hotgroup-badge-${run.id}`} />
          {/* Color palette */}
          <div className="relative" ref={paletteRef} onPointerDown={e => e.stopPropagation()}>
            <button
              ref={paletteButtonRef}
              onClick={() => {
                if (!paletteOpen && paletteButtonRef.current) {
                  const rect = paletteButtonRef.current.getBoundingClientRect()
                  setPalettePos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
                }
                setPaletteOpen(o => !o)
              }}
              className="p-1 rounded transition-colors"
              style={{ color: paletteOpen ? runAccent : undefined }}
              title="Change run color"
            >
              <span className="material-symbols-outlined text-sm text-slate-500 hover:text-slate-300 transition-colors" style={paletteOpen ? { color: runAccent } : undefined}>palette</span>
            </button>
            {paletteOpen && palettePos && createPortal(
              <div
                className="fixed z-[9999] p-2 bg-surface-panel border border-white/10 rounded shadow-xl"
                style={{ top: palettePos.top, right: palettePos.right, minWidth: 160 }}
                ref={paletteRef}
              >
                <ColorPalette value={run.color ?? ''} onChange={handleColorChange} />
              </div>,
              document.body,
            )}
          </div>
          {/* Browser widget drag chip */}
          <div
            draggable
            onPointerDown={e => e.stopPropagation()}
            onDragStart={e => {
              e.stopPropagation()
              e.dataTransfer.setData('application/tinstar-browser', JSON.stringify({ sessionId: run.sessionId }))
              e.dataTransfer.effectAllowed = 'copy'
            }}
            className="p-1 rounded cursor-grab active:cursor-grabbing text-slate-500 hover:text-slate-300 transition-colors"
            title="Drag to canvas to create a browser widget"
          >
            <span className="material-symbols-outlined text-sm">language</span>
          </div>
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
                className="p-1 rounded text-slate-500 transition-colors"
                style={{ color: runAccent }}
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
            <div className="text-2xs font-mono truncate max-w-[100px]" style={{ color: hexToRgba(runAccent, 0.7) }}>{run.worktree}</div>
          </div>
          <div className="text-right">
            <div className="text-2xs font-mono text-slate-500 tracking-wide">REPO</div>
            <div className="text-2xs font-mono truncate max-w-[100px]" style={{ color: hexToRgba(runAccent, 0.7) }}>{run.repo}</div>
          </div>
        </div>
      )}
    </header>
  )
}
