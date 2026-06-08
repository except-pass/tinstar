import { useEffect } from 'react'
import type { TrafficEvent } from './types'

interface Props {
  event: TrafficEvent
  onClose: () => void
}

function prettyData(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function formatTs(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

export function MessageDetailModal({ event, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      data-testid="saloon-msg-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        className="bg-surface-panel border border-white/10 rounded shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col font-mono"
        onClick={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-white/10">
          <div className="flex-1 min-w-0">
            <div
              className="text-sm font-semibold truncate text-cyan-400"
              title={event.subject}
            >
              {event.subject}
            </div>
            <div className="text-2xs text-slate-500 truncate">
              {formatTs(event.timestamp)}
              {event.sender ? ` · from ${event.sender}` : ''}
              {` · ${event.direction}`}
            </div>
          </div>
          <button
            onClick={onClose}
            onPointerDown={e => e.stopPropagation()}
            className="text-slate-400 hover:text-slate-200"
            title="Close (Esc)"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>

        {/* Body — pretty-printed data */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-sm text-slate-200 whitespace-pre-wrap break-words">
          {prettyData(event.data)}
        </div>
      </div>
    </div>
  )
}
