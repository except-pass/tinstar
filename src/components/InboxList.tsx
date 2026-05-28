import { useState, useMemo } from 'react'
import { apiFetch } from '../apiClient'
import { useInbox, type InboxRow as InboxRowData } from '../hooks/useInbox'
import { InboxRow } from './InboxRow'
import { markInboxRead, markInboxUnread } from '../lib/uiPrefs'
import { dispatchFlashFocus } from '../canvas/flashAndFocus'

const LEVELS = ['all', 'urgent', 'attention', 'info'] as const
type Filter = typeof LEVELS[number]

interface Props {
  activeSpaceId: string | null
  searchQuery?: string
}

export function InboxList({ activeSpaceId, searchQuery = '' }: Props) {
  const { rows } = useInbox(activeSpaceId)
  const [filter, setFilter] = useState<Filter>('all')
  const [unreadOnly, setUnreadOnly] = useState(false)
  // Local tick to force re-render after read/unread toggles (since uiPrefs is outside React state).
  const [readTick, setReadTick] = useState(0)

  const visible = useMemo<InboxRowData[]>(() => {
    void readTick
    const q = searchQuery.trim().toLowerCase()
    return rows.filter(r => {
      if (filter !== 'all' && r.attention.level !== filter) return false
      if (unreadOnly && !r.unread) return false
      if (q) {
        const hay = `${r.attention.reason} ${r.sourceLabel} ${r.taskPath.join(' ')} ${r.sessionName ?? ''} ${r.worktree ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, filter, unreadOnly, searchQuery, readTick])

  function handleClick(widgetId: string) {
    const row = rows.find(r => r.widgetId === widgetId)
    if (!row) return
    markInboxRead(`${widgetId}:${row.attention.setAt}`)
    setReadTick(t => t + 1)
    dispatchFlashFocus({ widgetId, source: row.source })
  }

  function handleClear(widgetId: string) {
    const row = rows.find(r => r.widgetId === widgetId)
    if (!row) return
    const endpoint = row.source === 'plugin'
      ? `/api/plugin-widgets/${widgetId}`
      : `/api/runs/${widgetId}`
    apiFetch(endpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attention: null }),
    }).then(res => {
      if (res.status === 404 && row.source === 'run') {
        // eslint-disable-next-line no-console
        console.warn('[inbox] run-attention clear not supported by server; will auto-clear on next status transition')
      }
    }).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[inbox] clear failed:', err)
    })
  }

  function handleToggleRead(widgetId: string) {
    const row = rows.find(r => r.widgetId === widgetId)
    if (!row) return
    const key = `${widgetId}:${row.attention.setAt}`
    if (row.unread) markInboxRead(key)
    else markInboxUnread(key)
    setReadTick(t => t + 1)
  }

  return (
    <div className="flex flex-col h-full" data-testid="inbox-list">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-white/5 text-2xs">
        {LEVELS.map(lvl => (
          <button
            key={lvl}
            data-testid={`inbox-filter-${lvl}`}
            className={`px-2 py-0.5 rounded-full uppercase tracking-wider ${filter === lvl ? 'bg-primary/20 text-primary' : 'text-slate-500 hover:text-slate-300'}`}
            onClick={() => setFilter(lvl)}
          >
            {lvl}
          </button>
        ))}
        <span className="flex-1" />
        <button
          data-testid="inbox-filter-unread-only"
          className={`px-2 py-0.5 rounded ${unreadOnly ? 'bg-primary/20 text-primary' : 'text-slate-500 hover:text-slate-300'}`}
          onClick={() => setUnreadOnly(v => !v)}
        >
          Unread only
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {visible.length === 0 ? (
          <div className="px-3 py-8 text-xs text-slate-500 text-center" data-testid="inbox-empty">
            Nothing needs your attention.
          </div>
        ) : (
          visible.map(row => (
            <InboxRow
              key={row.widgetId}
              row={row}
              onClick={handleClick}
              onClear={handleClear}
              onToggleRead={handleToggleRead}
            />
          ))
        )}
      </div>
    </div>
  )
}
