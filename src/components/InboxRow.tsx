import type { InboxRow as InboxRowData } from '../hooks/useInbox'
import type { AttentionLevel, SessionStatus } from '../domain/types'
import { AgentIcon } from './agentIcon'
import { resolveRunAccent, hexToRgba } from './runAccent'

// Status → upper-right dot. Colors mirror the canvas widget header (RunWorkspaceHeader)
// so a session looks the same in the inbox as it does on the canvas.
const STATUS_DOT: Record<SessionStatus, { dot: string; label: string; pulse?: boolean }> = {
  creating:        { dot: 'bg-blue-400',     label: 'Creating', pulse: true },
  running:         { dot: 'bg-accent-green', label: 'Running',  pulse: true },
  idle:            { dot: 'bg-accent-amber', label: 'Idle' },
  needs_attention: { dot: 'bg-orange-400',   label: 'Needs attention', pulse: true },
  stopped:         { dot: 'bg-slate-500',    label: 'Stopped' },
}

// Plugin-widget rows have no session status — fall back to the attention level for the dot.
const LEVEL_DOT: Record<AttentionLevel, string> = {
  urgent:    'bg-red-500',
  attention: 'bg-amber-500',
  info:      'bg-slate-400',
}

function relativeTime(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const d = Math.floor(hr / 24)
  return `${d}d`
}

export function InboxRow({
  row,
  selected = false,
  onClick,
  onClear,
}: {
  row: InboxRowData
  selected?: boolean
  onClick: (widgetId: string) => void
  onClear: (widgetId: string) => void
}) {
  const isRun = row.source === 'run'
  const accent = resolveRunAccent(row.color ?? undefined)
  const statusUi = row.status ? STATUS_DOT[row.status] : null
  const dotClass = statusUi?.dot ?? (row.attention ? LEVEL_DOT[row.attention.level] : 'bg-slate-600')
  const statusLabel = row.attention?.reason ?? statusUi?.label ?? 'Session'
  const time = row.attention?.setAt ?? row.createdAt
  const attentionReason = row.attention?.reason ?? null

  return (
    <div
      data-testid={`inbox-row-${row.widgetId}`}
      data-selected={selected ? 'true' : undefined}
      className={`group relative flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-surface-hover ${selected ? 'bg-primary/10' : ''}`}
      onClick={() => onClick(row.widgetId)}
    >
      {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: accent }} aria-hidden="true" />}

      {/* Avatar — the run's own session avatar (procedural, accent-tinted), matching the canvas widget. */}
      <div
        className="flex items-center justify-center w-7 h-7 rounded shrink-0 overflow-hidden border"
        style={{ borderColor: hexToRgba(accent, 0.5), backgroundColor: hexToRgba(accent, 0.08) }}
      >
        {isRun
          ? <AgentIcon seed={row.widgetId} color={accent} className="w-6 h-6" />
          : <span className="text-slate-400 text-sm" aria-hidden="true">⊞</span>}
      </div>

      {/* Name (the big thing) + where it lives */}
      <div className="min-w-0 flex-1">
        <div className={`truncate text-sm ${row.unread ? 'font-semibold text-slate-100' : 'font-medium text-slate-300'}`}>
          {row.sourceLabel}
        </div>
        <div className="flex items-center gap-1.5 text-2xs text-slate-500">
          {attentionReason && <span className="truncate text-slate-400">{attentionReason}</span>}
          {row.taskPath.length > 0 && <span className="truncate">{row.taskPath.join(' › ')}</span>}
          {row.worktree && (<>
            <span className="text-slate-700">·</span>
            <span className="truncate">⎇ {row.worktree}</span>
          </>)}
        </div>
      </div>

      {/* Upper-right: status dot + relative time */}
      <div className="flex flex-col items-end gap-1 shrink-0 self-start pt-0.5">
        <span
          data-testid={`inbox-row-dot-${row.widgetId}`}
          className={`w-2 h-2 rounded-full ${dotClass} ${statusUi?.pulse ? 'animate-pulse-glow' : ''}`}
          title={statusLabel}
          aria-label={statusLabel}
        />
        {time && <span className="text-2xs text-slate-500">{relativeTime(time)}</span>}
      </div>

      {row.attention && (
        <button
          data-testid={`inbox-row-clear-${row.widgetId}`}
          className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 text-xs leading-none px-1"
          onClick={(e) => { e.stopPropagation(); onClear(row.widgetId) }}
          aria-label="Dismiss"
          title="Clear attention"
        >
          ×
        </button>
      )}
    </div>
  )
}
