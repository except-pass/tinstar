import type { InboxRow as InboxRowData } from '../hooks/useInbox'

const LEVEL_TONE: Record<InboxRowData['attention']['level'], { dotFilled: string; dotHollow: string; text: string }> = {
  urgent:    { dotFilled: 'bg-red-500',    dotHollow: 'border border-red-500/60',    text: 'text-red-400' },
  attention: { dotFilled: 'bg-amber-500',  dotHollow: 'border border-amber-500/60',  text: 'text-amber-400' },
  info:      { dotFilled: 'bg-slate-400',  dotHollow: 'border border-slate-500/60',  text: 'text-slate-400' },
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
  onClick,
  onClear,
  onToggleRead,
}: {
  row: InboxRowData
  onClick: (widgetId: string) => void
  onClear: (widgetId: string) => void
  onToggleRead: (widgetId: string) => void
}) {
  const tone = LEVEL_TONE[row.attention.level]
  return (
    <div
      data-testid={`inbox-row-${row.widgetId}`}
      className={`group flex flex-col gap-0.5 px-3 py-2 cursor-pointer text-xs hover:bg-surface-hover ${row.unread ? 'font-medium' : 'opacity-70'}`}
      onClick={() => onClick(row.widgetId)}
    >
      <div className="flex items-center gap-2">
        <button
          data-testid={`inbox-row-dot-${row.widgetId}`}
          className={`w-2 h-2 rounded-full flex-shrink-0 ${row.unread ? tone.dotFilled : tone.dotHollow}`}
          onClick={(e) => { e.stopPropagation(); onToggleRead(row.widgetId) }}
          aria-label={row.unread ? 'Mark read' : 'Mark unread'}
        />
        <span className={`flex-1 truncate ${row.unread ? tone.text : 'text-slate-400'}`}>{row.attention.reason}</span>
        <span className="text-2xs text-slate-500 flex-shrink-0">{relativeTime(row.attention.setAt)}</span>
        <button
          data-testid={`inbox-row-clear-${row.widgetId}`}
          className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 text-xs flex-shrink-0"
          onClick={(e) => { e.stopPropagation(); onClear(row.widgetId) }}
          aria-label="Dismiss"
          title="Clear attention"
        >
          ×
        </button>
      </div>
      <div className="flex items-center gap-2 text-2xs text-slate-500 pl-4">
        {row.taskPath.length > 0 && (
          <span className="truncate">⌂ {row.taskPath.join(' › ')}</span>
        )}
        {row.sessionName && (<>
          <span className="text-slate-700">·</span>
          <span className="truncate">{row.source === 'run' ? '🤖' : '⊙'} {row.sessionName}</span>
        </>)}
        {row.worktree && (<>
          <span className="text-slate-700">·</span>
          <span className="truncate">⎇ {row.worktree}</span>
        </>)}
      </div>
    </div>
  )
}
