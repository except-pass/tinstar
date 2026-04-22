import { useState, useRef, useCallback, useEffect, useMemo, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { RunData, SessionStatus } from '../../types'
import { useHotgroupContext } from '../../hotkeys/HotgroupContext'
import { useBackendState } from '../../hooks/useBackendState'
import { HotgroupBadge } from '../HotgroupBadge'
import { hexToRgba, resolveRunAccent } from '../runAccent'
import { ColorPalette } from '../ColorPalette'
import { AgentIcon } from '../agentIcon'

type StatusUi = { label: string; color: string; dot: string; pulse?: boolean }

const statusConfig: Record<SessionStatus, StatusUi> = {
  creating: { label: 'CREATING', color: 'text-blue-400', dot: 'bg-blue-400 shadow-[0_0_6px_#818cf8]', pulse: true },
  running: { label: 'RUNNING', color: 'text-accent-green', dot: 'bg-accent-green shadow-[0_0_6px_#00ff88]', pulse: true },
  idle: { label: 'IDLE', color: 'text-accent-amber', dot: 'bg-accent-amber shadow-[0_0_6px_#ffaa00]' },
  needs_attention: { label: 'ATTENTION', color: 'text-orange-400', dot: 'bg-orange-400 shadow-[0_0_6px_#f97316]', pulse: true },
  stopped: { label: 'STOPPED', color: 'text-slate-400', dot: 'bg-slate-500' },
}

function statusUi(status: SessionStatus | string | undefined): StatusUi {
  if (status && status in statusConfig) return statusConfig[status as SessionStatus]
  return {
    label: (status && String(status)) || 'UNKNOWN',
    color: 'text-slate-400',
    dot: 'bg-slate-500',
  }
}

interface Props {
  run: RunData
  compact?: boolean
  onPointerDown?: (e: ReactPointerEvent) => void
  onPointerMove?: (e: ReactPointerEvent) => void
  onPointerUp?: (e: ReactPointerEvent) => void
  onRefreshTerminal?: () => void
  activeTab?: 'recap' | 'terminal'
  onActiveTabChange?: (tab: 'recap' | 'terminal') => void
}

export function RunWorkspaceHeader({ run, compact = false, onPointerDown, onPointerMove, onPointerUp, onRefreshTerminal, activeTab, onActiveTabChange }: Props) {
  const status = statusUi(run.status)
  const runAccent = resolveRunAccent(run.color)
  const [busy, setBusy] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [palettePos, setPalettePos] = useState<{ top: number; right: number } | null>(null)
  const paletteRef = useRef<HTMLDivElement>(null)
  const paletteButtonRef = useRef<HTMLButtonElement>(null)
  const { slotsForNode } = useHotgroupContext()
  const { taxRepo } = useBackendState()

  // Resolve entity hierarchy names from IDs for the breadcrumb
  const breadcrumb = useMemo(() => {
    const initiative = taxRepo.getInitiativeForRun(run as import('../../domain/types').Run)
    const epic = taxRepo.getEpicForRun(run as import('../../domain/types').Run)
    const task = taxRepo.getTaskForRun(run as import('../../domain/types').Run)
    return [initiative?.name, epic?.name, task?.name].filter((s): s is string => !!s)
  }, [taxRepo, run])

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

  const [actionError, setActionError] = useState<string | null>(null)
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null)

  const sessionAction = useCallback(async (action: 'stop' | 'delete' | 'start') => {
    setBusy(true)
    setActionError(null)
    try {
      const url = action === 'delete'
        ? `/api/sessions/${run.sessionId}`
        : `/api/sessions/${run.sessionId}/${action}`
      const res = await fetch(url, { method: action === 'delete' ? 'DELETE' : 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok || (data && !data.ok)) {
        const msg = data?.error?.message ?? data?.error?.code ?? `${action} failed (${res.status})`
        setActionError(msg)
      }
    } catch (err) {
      setActionError((err as Error).message ?? `${action} failed`)
    } finally {
      setBusy(false)
    }
  }, [run.sessionId])

  const refreshTerminal = useCallback(() => {
    onRefreshTerminal?.()
  }, [onRefreshTerminal])

  const isLive = run.status === 'running' || run.status === 'idle' || run.status === 'needs_attention' || run.status === 'creating'

  return (
    <header
      className="widget-drag-handle flex items-center justify-between bg-surface-panel overflow-hidden cursor-grab active:cursor-grabbing select-none min-h-[44px]"
      style={{ borderBottom: `1px solid ${hexToRgba(runAccent, 0.25)}` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragStart={e => e.preventDefault()}
    >
      {/* Left: identity */}
      <div className="flex items-center gap-2 min-w-0 pl-3">
        <div
          className="flex items-center justify-center w-6 h-6 border shrink-0 overflow-hidden"
          style={{ borderColor: hexToRgba(runAccent, 0.6), backgroundColor: hexToRgba(runAccent, 0.1) }}
          title={run.backendInfo ?? (run.backend ?? 'unknown')}
        >
          <AgentIcon seed={run.id} color={runAccent} className="w-5 h-5" />
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
          {!compact && breadcrumb.length > 0 && (
            <nav className="flex items-center gap-1 mt-0.5">
              {breadcrumb.map((segment, i, arr) => (
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
        <div className="flex items-stretch shrink-0 ml-2 h-full" onPointerDown={e => { if (e.button === 0) e.stopPropagation() }}>

          {/* Hotgroup badge */}
          <div className="flex items-center px-2">
            <HotgroupBadge slots={slotsForNode(`run-${run.id}`)} testId={`hotgroup-badge-${run.id}`} />
          </div>

          {/* Error banner — shown inline before buttons when present */}
          {actionError && (
            <div
              className="flex items-center gap-1 px-2 my-auto bg-accent-red/10 border border-accent-red/30 rounded text-accent-red text-2xs font-mono max-w-[180px] cursor-pointer"
              title={actionError}
              onClick={() => setActionError(null)}
            >
              <span className="material-symbols-outlined text-xs">error</span>
              <span className="truncate">{actionError}</span>
            </div>
          )}

          {/* Recap / Terminal toggle */}
          {activeTab && onActiveTabChange && (
            <div className="flex items-center px-2">
              <div className="flex rounded-sm overflow-hidden border" style={{ borderColor: hexToRgba(runAccent, 0.25) }}>
                {([
                  { key: 'recap' as const, label: 'Recap' },
                  { key: 'terminal' as const, label: run.port ? 'Terminal' : 'Logs' },
                ] as const).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => onActiveTabChange(key)}
                    className="px-3 py-0.5 text-2xs font-bold font-display tracking-[0.12em] uppercase transition-all"
                    style={activeTab === key
                      ? { background: runAccent, color: 'var(--surface-base)' }
                      : { color: hexToRgba(runAccent, 0.5) }
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* WORKTREE / REPO meta */}
          <div className="flex items-center gap-4 px-3 border-l border-white/[0.06]">
            <div className="text-right">
              <div className="text-2xs font-mono text-slate-500 tracking-wide">WORKTREE</div>
              <div className="text-2xs font-mono truncate max-w-[80px]" style={{ color: hexToRgba(runAccent, 0.7) }}>{run.worktree}</div>
            </div>
            <div className="text-right">
              <div className="text-2xs font-mono text-slate-500 tracking-wide">REPO</div>
              <div className="text-2xs font-mono truncate max-w-[80px]" style={{ color: hexToRgba(runAccent, 0.7) }}>{run.repo}</div>
            </div>
          </div>

          {/* Separator */}
          <div className="w-px self-stretch bg-white/[0.07]" />

          {/* Color palette */}
          <div className="relative" ref={paletteRef}>
            <button
              ref={paletteButtonRef}
              onClick={() => {
                if (!paletteOpen && paletteButtonRef.current) {
                  const rect = paletteButtonRef.current.getBoundingClientRect()
                  setPalettePos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
                }
                setPaletteOpen(o => !o)
              }}
              onMouseEnter={() => setHoveredBtn('color')}
              onMouseLeave={() => setHoveredBtn(null)}
              className="flex flex-col items-center justify-center gap-0.5 h-full px-3 transition-colors"
              style={{
                color: (paletteOpen || hoveredBtn === 'color') ? runAccent : hexToRgba(runAccent, 0.55),
                background: hoveredBtn === 'color' ? hexToRgba(runAccent, 0.06) : undefined,
              }}
              title="Change run color"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px', fontVariationSettings: "'FILL' 0" }}>palette</span>
              <span className="text-[8px] font-bold tracking-wide leading-none">COLOR</span>
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

          {/* Browser drag chip */}
          <div
            draggable
            onMouseEnter={() => setHoveredBtn('browser')}
            onMouseLeave={() => setHoveredBtn(null)}
            onDragStart={e => {
              e.stopPropagation()
              e.dataTransfer.setData('application/tinstar-browser', JSON.stringify({ sessionId: run.sessionId }))
              e.dataTransfer.effectAllowed = 'copy'
            }}
            className="flex flex-col items-center justify-center gap-0.5 h-full px-3 cursor-grab active:cursor-grabbing transition-colors"
            style={{
              color: hoveredBtn === 'browser' ? runAccent : hexToRgba(runAccent, 0.55),
              background: hoveredBtn === 'browser' ? hexToRgba(runAccent, 0.06) : undefined,
            }}
            title="Drag to canvas to create a browser widget"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>language</span>
            <span className="text-[8px] font-bold tracking-wide leading-none">BROWSER</span>
          </div>

          {/* NATS drag chip — grayed out when not NATS enabled */}
          <div
            draggable={!!run.natsEnabled}
            onMouseEnter={() => setHoveredBtn('nats')}
            onMouseLeave={() => setHoveredBtn(null)}
            onDragStart={e => {
              if (!run.natsEnabled) {
                e.preventDefault()
                return
              }
              e.stopPropagation()
              e.dataTransfer.setData('application/tinstar-nats', JSON.stringify({
                sessionId: run.sessionId,
                natsSubject: run.natsSubject,
                color: run.color,
              }))
              e.dataTransfer.effectAllowed = 'copy'
            }}
            className={`flex flex-col items-center justify-center gap-0.5 h-full px-3 transition-colors ${run.natsEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed'}`}
            style={{
              color: !run.natsEnabled
                ? 'rgb(100 116 139 / 0.35)'  // slate-500 at 35% — grayed out
                : hoveredBtn === 'nats' ? runAccent : hexToRgba(runAccent, 0.55),
              background: run.natsEnabled && hoveredBtn === 'nats' ? hexToRgba(runAccent, 0.06) : undefined,
            }}
            title={run.natsEnabled
              ? `NATS subscriptions:\n${(run.natsSubscriptions ?? [run.natsSubject]).filter(Boolean).join('\n')}\n\nDrag to canvas to monitor traffic`
              : 'NATS not enabled for this session'}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px', fontVariationSettings: "'FILL' 1" }}>cell_tower</span>
            <span className="text-[8px] font-bold tracking-wide leading-none">NATS</span>
          </div>

          {isLive && run.port && (
            <>
              {/* Separator before Refresh */}
              <div className="w-px self-stretch bg-white/[0.07]" />
              <button
                onClick={refreshTerminal}
                onMouseEnter={() => setHoveredBtn('refresh')}
                onMouseLeave={() => setHoveredBtn(null)}
                className="flex flex-col items-center justify-center gap-0.5 h-full px-3 transition-colors"
                style={{
                  color: runAccent,
                  background: hoveredBtn === 'refresh' ? hexToRgba(runAccent, 0.06) : undefined,
                }}
                title="Refresh — re-registers the proxy route so the browser widget can reach this session's port"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>refresh</span>
                <span className="text-[8px] font-bold tracking-wide leading-none">REFRESH</span>
              </button>
            </>
          )}

          {/* Separator before danger group */}
          <div className="w-px self-stretch bg-white/[0.07]" />

          {/* Stop / Resume */}
          {isLive ? (
            <button
              onClick={() => sessionAction('stop')}
              disabled={busy}
              className="flex flex-col items-center justify-center gap-0.5 h-full px-3 text-slate-500 transition-colors hover:bg-accent-red/[0.08] hover:text-accent-red disabled:opacity-50"
              title="Stop session"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>stop_circle</span>
              <span className="text-[8px] font-bold tracking-wide leading-none">STOP</span>
            </button>
          ) : (
            <button
              onClick={() => sessionAction('start')}
              disabled={busy}
              className="flex flex-col items-center justify-center gap-0.5 h-full px-3 text-slate-500 transition-colors hover:bg-accent-green/[0.08] hover:text-accent-green disabled:opacity-50"
              title="Resume session"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_circle</span>
              <span className="text-[8px] font-bold tracking-wide leading-none">RESUME</span>
            </button>
          )}

          {/* Delete — adjacent to Stop with no separator */}
          <button
            onClick={() => sessionAction('delete')}
            disabled={busy}
            className="flex flex-col items-center justify-center gap-0.5 h-full px-3 text-slate-500 transition-colors hover:bg-accent-red/[0.08] hover:text-accent-red disabled:opacity-50"
            title="Delete session"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
            <span className="text-[8px] font-bold tracking-wide leading-none">DELETE</span>
          </button>
        </div>
      )}
    </header>
  )
}
