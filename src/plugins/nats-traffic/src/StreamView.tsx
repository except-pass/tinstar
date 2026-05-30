import { useMemo, useState } from 'react'
import type { TrafficEvent } from './types'
import { MessageDetailModal } from './MessageDetailModal'

interface Props {
  events: TrafficEvent[]
  filter: string
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
  catch { return iso }
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len) + '...' : s
}

/**
 * Returns a shape-preview string for the data column.
 * JSON objects → `{…}`, arrays → `[…]`, other → first 60 chars.
 * This keeps the modal as the single source of actual content.
 */
function dataPreview(s: string): string {
  const trimmed = s.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return '{…}'
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return '[…]'
  return truncate(s, 60)
}

export function StreamView({ events, filter }: Props): JSX.Element {
  const [selected, setSelected] = useState<TrafficEvent | null>(null)
  const needle = filter.trim().toLowerCase()

  const visible = useMemo(() => {
    if (!needle) return events
    return events.filter(e =>
      e.subject.toLowerCase().includes(needle) ||
      e.data.toLowerCase().includes(needle)
    )
  }, [events, needle])

  return (
    <div className="flex flex-col h-full bg-surface-base text-slate-300 overflow-hidden">
      {/* Event list */}
      <div className="flex-1 min-h-0 overflow-y-auto font-mono text-2xs">
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500">
            Waiting for NATS traffic…
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500">
            No matching events
          </div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-surface-panel text-slate-400">
              <tr>
                <th className="px-2 py-1 text-left w-16">Time</th>
                <th className="px-2 py-1 text-left w-24">From</th>
                <th className="px-2 py-1 text-left">Subject</th>
                <th className="px-2 py-1 text-left">Data</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e, i) => {
                const isOutbound = e.direction === 'outbound'
                return (
                  <tr
                    key={i}
                    onClick={() => setSelected(e)}
                    className="border-b border-white/5 cursor-pointer hover:bg-white/5"
                  >
                    <td className="px-2 py-1 whitespace-nowrap text-slate-500">
                      {formatTime(e.timestamp)}
                    </td>
                    <td
                      className={`px-2 py-1 whitespace-nowrap ${isOutbound ? 'text-green-400' : 'text-amber-400'}`}
                      title={isOutbound ? 'outbound' : 'inbound'}
                    >
                      <span className="inline-flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs" style={{ fontSize: '12px' }}>
                          {isOutbound ? 'arrow_upward' : 'arrow_downward'}
                        </span>
                        {e.sender ?? '?'}
                      </span>
                    </td>
                    <td
                      className="px-2 py-1 whitespace-nowrap text-cyan-400 truncate max-w-[250px]"
                      title={e.subject}
                    >
                      {e.subject}
                    </td>
                    <td
                      className="px-2 py-1 text-slate-400 max-w-[350px] overflow-hidden"
                      title={e.data}
                    >
                      <span className="block truncate">{dataPreview(e.data)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {selected !== null && (
        <MessageDetailModal event={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
