import { useState, useMemo, useEffect } from 'react'
import { apiFetch } from '../apiClient'
import { useInbox, type InboxRow as InboxRowData } from '../hooks/useInbox'
import { InboxRow } from './InboxRow'
import { markInboxRead } from '../lib/uiPrefs'
import { dispatchFlashFocus } from '../canvas/flashAndFocus'
import { useSelection } from './SelectionProvider'

// Canvas selection stores runs under a `run-` prefix; plugin widgets use their bare id.
function selectionId(row: InboxRowData): string {
  return row.source === 'run' ? `run-${row.widgetId}` : row.widgetId
}

const LEVELS = ['all', 'urgent', 'attention', 'info'] as const
type Filter = typeof LEVELS[number]

interface Props {
  activeSpaceId: string | null
  searchQuery?: string
  /** Reports run ids in the inbox's filtered top-to-bottom order, so
   *  bracket-cycling follows exactly what the inbox is showing. */
  onVisibleRunOrder?: (runIds: string[]) => void
}

export function InboxList({ activeSpaceId, searchQuery = '', onVisibleRunOrder }: Props) {
  const { rows } = useInbox(activeSpaceId)
  const { isSelected } = useSelection()
  const [filter, setFilter] = useState<Filter>('all')
  const [unreadOnly, setUnreadOnly] = useState(false)
  // Local tick to force re-render after read/unread toggles (since uiPrefs is outside React state).
  const [readTick, setReadTick] = useState(0)

  const visible = useMemo<InboxRowData[]>(() => {
    void readTick
    const q = searchQuery.trim().toLowerCase()
    return rows.filter(r => {
      if (filter !== 'all' && r.attention?.level !== filter) return false
      if (unreadOnly && !r.unread) return false
      if (q) {
        const headline = r.attention?.reason ?? r.status ?? ''
        const hay = `${headline} ${r.sourceLabel} ${r.taskPath.join(' ')} ${r.sessionName ?? ''} ${r.worktree ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, filter, unreadOnly, searchQuery, readTick])

  const visibleRunIds = useMemo(
    () => visible.filter(r => r.source === 'run').map(r => r.widgetId),
    [visible],
  )
  useEffect(() => { onVisibleRunOrder?.(visibleRunIds) }, [visibleRunIds, onVisibleRunOrder])

  function handleClick(widgetId: string) {
    const row = rows.find(r => r.widgetId === widgetId)
    if (!row) return
    if (row.attention) {
      markInboxRead(row.readKey)
      setReadTick(t => t + 1)
    }
    dispatchFlashFocus({ widgetId, source: row.source })
  }

  function handleClose(widgetId: string) {
    const row = rows.find(r => r.widgetId === widgetId)
    if (!row || row.source !== 'run') return
    // The × only shows on a stopped agent (see InboxRow). Closing it deletes the
    // dead session — same terminate-and-remove the canvas widget's Delete uses.
    apiFetch(`/api/sessions/${widgetId}`, { method: 'DELETE' }).then((res) => {
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(`[inbox] close failed: HTTP ${res.status}`)
      }
    }).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[inbox] close failed:', err)
    })
  }

  return (
    <div className="flex flex-col flex-1 min-h-0" data-testid="inbox-list">
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
            No sessions to show.
          </div>
        ) : (
          visible.map(row => (
            <InboxRow
              key={row.widgetId}
              row={row}
              selected={isSelected(selectionId(row))}
              onClick={handleClick}
              onClose={handleClose}
            />
          ))
        )}
      </div>
    </div>
  )
}
