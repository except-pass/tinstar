import { useState, useEffect, useRef, useCallback } from 'react'
import type { NatsTrafficWidget } from '../../domain/types'
import type { WidgetProps } from '../widgetComponentRegistry'

interface TrafficEvent {
  timestamp: string
  sessionName: string
  direction: 'inbound' | 'outbound'
  subject: string
  from: string
  replyTo: string | null
  body: string
}

const MAX_EVENTS = 200

export function NatsTrafficWidget({ data }: WidgetProps) {
  const widget = data as NatsTrafficWidget
  const [events, setEvents] = useState<TrafficEvent[]>([])
  const [filter, setFilter] = useState('')
  const [paused, setPaused] = useState(false)
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  const isAllSessions = !widget.sessionId

  // Listen to nats_traffic events
  useEffect(() => {
    const handler = (e: Event) => {
      if (pausedRef.current) return

      const event = (e as CustomEvent).detail as TrafficEvent

      // Filter by session if widget has a sessionId set
      if (widget.sessionId && event.sessionName !== widget.sessionId) return

      setEvents(prev => {
        const next = [...prev, event]
        // Keep only the last MAX_EVENTS
        if (next.length > MAX_EVENTS) {
          return next.slice(-MAX_EVENTS)
        }
        return next
      })
    }

    window.addEventListener('tinstar:nats_traffic', handler)
    return () => window.removeEventListener('tinstar:nats_traffic', handler)
  }, [widget.sessionId])

  // Auto-scroll when new events arrive
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events, paused])

  const handleClose = useCallback(() => {
    fetch(`/api/nats-traffic-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})
  }, [widget.id])

  const clearEvents = useCallback(() => {
    setEvents([])
  }, [])

  // Filter events by subject
  const filteredEvents = filter
    ? events.filter(e => e.subject.toLowerCase().includes(filter.toLowerCase()))
    : events

  const formatTime = (ts: string) => {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const truncate = (s: string, len: number) => s.length > len ? s.slice(0, len) + '...' : s

  const toggleRowExpand = useCallback((index: number) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }, [])

  return (
    <div className="flex flex-col h-full bg-surface-base text-slate-300 overflow-hidden">
      {/* Header */}
      <div className="widget-drag-handle flex items-center gap-2 px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab">
        <span className="text-primary text-xs">NATS</span>
        <span className="text-2xs font-mono text-slate-400 truncate flex-1">
          Traffic Monitor {widget.sessionId ? `(${widget.sessionId})` : '(all sessions)'}
        </span>
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={clearEvents}
          className="text-2xs font-mono px-2 py-0.5 rounded border border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60 flex-shrink-0"
        >
          Clear
        </button>
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={() => setPaused(!paused)}
          className={`text-2xs font-mono px-2 py-0.5 rounded border flex-shrink-0 ${paused ? 'border-amber-500/60 text-amber-400' : 'border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60'}`}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={handleClose}
          className="text-slate-500 hover:text-slate-300 flex-shrink-0 ml-1"
          title="Close"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>

      {/* Filter bar */}
      <div className="px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0">
        <input
          type="text"
          placeholder="Filter by subject..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          onPointerDown={e => e.stopPropagation()}
          className="w-full bg-surface-base text-xs font-mono px-2 py-1 rounded border border-white/10 focus:border-primary/50 focus:outline-none"
        />
      </div>

      {/* Event list */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto font-mono text-2xs"
      >
        {filteredEvents.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500">
            {events.length === 0 ? 'Waiting for NATS traffic...' : 'No matching events'}
          </div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-surface-panel text-slate-400">
              <tr>
                <th className="px-2 py-1 text-left w-16">Time</th>
                <th className="px-2 py-1 text-left w-12">Dir</th>
                <th className="px-2 py-1 text-left w-24">ReplyTo</th>
                {isAllSessions && <th className="px-2 py-1 text-left w-20">Session</th>}
                <th className="px-2 py-1 text-left">Subject</th>
                <th className="px-2 py-1 text-left w-20">From</th>
                <th className="px-2 py-1 text-left">Body</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.map((e, i) => {
                const isExpanded = expandedRows.has(i)
                return (
                  <tr
                    key={i}
                    onClick={() => toggleRowExpand(i)}
                    className={`border-b border-white/5 cursor-pointer ${isExpanded ? 'bg-white/5' : 'hover:bg-white/5'} ${e.direction === 'inbound' ? 'text-cyan-400/80' : 'text-amber-400/80'}`}
                  >
                    <td className="px-2 py-1 whitespace-nowrap text-slate-500">{formatTime(e.timestamp)}</td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      {e.direction === 'inbound' ? '<-' : '->'}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap truncate max-w-[96px] text-slate-500" title={e.replyTo ?? ''}>
                      {e.replyTo ?? '-'}
                    </td>
                    {isAllSessions && (
                      <td className="px-2 py-1 whitespace-nowrap truncate max-w-[80px] text-slate-500" title={e.sessionName}>
                        {e.sessionName}
                      </td>
                    )}
                    <td className="px-2 py-1 whitespace-nowrap truncate max-w-[200px]" title={e.subject}>
                      {e.subject}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap truncate max-w-[80px]" title={e.from}>
                      {e.from}
                    </td>
                    <td className={`px-2 py-1 text-slate-400 ${isExpanded ? '' : 'truncate max-w-[300px]'}`} title={isExpanded ? undefined : e.body}>
                      {isExpanded ? (
                        <div className="whitespace-pre-wrap break-all py-1">{e.body}</div>
                      ) : (
                        truncate(e.body, 100)
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-1 bg-surface-panel border-t border-white/10 flex-shrink-0">
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: paused ? '#f59e0b' : '#22c55e' }}
        />
        <span className="text-2xs font-mono text-slate-500">
          {paused ? 'paused' : 'live'} | {filteredEvents.length} events {filter && `(${events.length} total)`}
        </span>
      </div>
    </div>
  )
}
