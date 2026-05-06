import { useState, useEffect, useRef, useCallback } from 'react'
import type { NatsTrafficWidget } from '../../domain/types'
import type { WidgetProps } from '../widgetComponentRegistry'
import { registerActionHandler, deregisterActionHandler } from '../../hotkeys/actionHandlerRegistry'
import { fitWidgetToViewport } from '../../hotkeys/canvasActionsRegistry'
import { apiFetch } from '../../apiClient'

interface TrafficEvent {
  timestamp: string
  subject: string
  data: string
  direction: 'inbound' | 'outbound'
  sender?: string
}

const MAX_EVENTS = 200

export function NatsTrafficWidget({ data }: WidgetProps) {
  const widget = data as NatsTrafficWidget
  const [events, setEvents] = useState<TrafficEvent[]>([])
  const [filter, setFilter] = useState('')
  const [paused, setPaused] = useState(false)
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set())
  const [newSub, setNewSub] = useState('')
  const [publishSubject, setPublishSubject] = useState('')
  const [publishMessage, setPublishMessage] = useState('')
  const [showControls, setShowControls] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const natsBatchRef = useRef<TrafficEvent[]>([])
  const natsRafRef = useRef<number | null>(null)

  const subscriptions = widget.subscriptions || []

  // Listen to nats_traffic events (batch per animation frame to avoid setState storms)
  useEffect(() => {
    const flushBatch = () => {
      natsRafRef.current = null
      const batch = natsBatchRef.current
      natsBatchRef.current = []
      if (batch.length === 0) return
      setEvents(prev => {
        let next = [...prev, ...batch]
        if (next.length > MAX_EVENTS) next = next.slice(-MAX_EVENTS)
        return next
      })
    }

    const handler = (e: Event) => {
      if (pausedRef.current) return

      const event = (e as CustomEvent).detail as TrafficEvent
      natsBatchRef.current.push(event)
      if (natsRafRef.current === null) {
        natsRafRef.current = requestAnimationFrame(flushBatch)
      }
    }

    window.addEventListener('tinstar:nats_traffic', handler)
    return () => {
      window.removeEventListener('tinstar:nats_traffic', handler)
      if (natsRafRef.current !== null) cancelAnimationFrame(natsRafRef.current)
      natsBatchRef.current = []
    }
  }, [])

  // Auto-scroll when new events arrive
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events, paused])

  // Register hotkey action handler for this widget
  useEffect(() => {
    registerActionHandler(widget.id, (action) => {
      if (action === 'fit-viewport') fitWidgetToViewport(widget.id)
    })
    return () => deregisterActionHandler(widget.id)
  }, [widget.id])

  const handleClose = useCallback(() => {
    apiFetch(`/api/nats-traffic-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})
  }, [widget.id])

  const clearEvents = useCallback(() => {
    setEvents([])
  }, [])

  const addSubscription = useCallback(() => {
    if (!newSub.trim()) return
    apiFetch(`/api/nats-traffic-widgets/${widget.id}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: newSub.trim() }),
    }).then(() => setNewSub(''))
  }, [widget.id, newSub])

  const removeSubscription = useCallback((subject: string) => {
    apiFetch(`/api/nats-traffic-widgets/${widget.id}/subscribe`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject }),
    })
  }, [widget.id])

  const publishNats = useCallback(() => {
    if (!publishSubject.trim() || !publishMessage.trim()) return
    apiFetch(`/api/nats-traffic-widgets/${widget.id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: publishSubject.trim(), message: publishMessage.trim() }),
    }).then(() => {
      setPublishMessage('')
    })
  }, [widget.id, publishSubject, publishMessage])

  // Filter events by subject
  const filteredEvents = filter
    ? events.filter(e => e.subject.toLowerCase().includes(filter.toLowerCase()) || e.data.toLowerCase().includes(filter.toLowerCase()))
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
          Traffic Monitor
        </span>
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={() => setShowControls(!showControls)}
          className={`text-2xs font-mono px-2 py-0.5 rounded border flex-shrink-0 ${showControls ? 'border-primary/60 text-primary' : 'border-primary/30 text-slate-400 hover:text-slate-200 hover:border-primary/60'}`}
        >
          Config
        </button>
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

      {/* Controls panel (collapsible) */}
      {showControls && (
        <div className="px-3 py-2 bg-surface-panel border-b border-white/10 flex-shrink-0 space-y-2">
          {/* Subscriptions */}
          <div>
            <div className="text-2xs text-slate-500 uppercase tracking-wider mb-1">Subscriptions</div>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {subscriptions.length === 0 ? (
                <span className="text-2xs text-slate-500 italic">none</span>
              ) : (
                subscriptions.map(sub => (
                  <span
                    key={sub}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-primary/20 text-primary text-2xs font-mono rounded"
                  >
                    {sub}
                    <button
                      onClick={() => removeSubscription(sub)}
                      className="text-primary/60 hover:text-primary"
                    >
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                placeholder="tinstar.> or specific subject..."
                value={newSub}
                onChange={e => setNewSub(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addSubscription()}
                onPointerDown={e => e.stopPropagation()}
                className="flex-1 bg-surface-base text-xs font-mono px-2 py-1 rounded border border-white/10 focus:border-primary/50 focus:outline-none"
              />
              <button
                onClick={addSubscription}
                onPointerDown={e => e.stopPropagation()}
                className="px-2 py-1 bg-primary/20 text-primary text-xs rounded hover:bg-primary/30"
              >
                Add
              </button>
            </div>
          </div>

          {/* Publish */}
          <div>
            <div className="text-2xs text-slate-500 uppercase tracking-wider mb-1">Publish</div>
            <div className="flex gap-1 mb-1">
              <input
                type="text"
                placeholder="Subject"
                value={publishSubject}
                onChange={e => setPublishSubject(e.target.value)}
                onPointerDown={e => e.stopPropagation()}
                className="w-40 bg-surface-base text-xs font-mono px-2 py-1 rounded border border-white/10 focus:border-primary/50 focus:outline-none"
              />
              <input
                type="text"
                placeholder="Message"
                value={publishMessage}
                onChange={e => setPublishMessage(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && publishNats()}
                onPointerDown={e => e.stopPropagation()}
                className="flex-1 bg-surface-base text-xs font-mono px-2 py-1 rounded border border-white/10 focus:border-primary/50 focus:outline-none"
              />
              <button
                onClick={publishNats}
                onPointerDown={e => e.stopPropagation()}
                className="px-2 py-1 bg-green-600/20 text-green-400 text-xs rounded hover:bg-green-600/30"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0">
        <input
          type="text"
          placeholder="Filter by subject or content..."
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
          <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-2">
            {events.length === 0 ? (
              <>
                <span>Waiting for NATS traffic...</span>
                {subscriptions.length === 0 && (
                  <span className="text-2xs">Click Config to add subscriptions</span>
                )}
              </>
            ) : (
              'No matching events'
            )}
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
              {filteredEvents.map((e, i) => {
                const isExpanded = expandedRows.has(i)
                const isOutbound = e.direction === 'outbound'
                return (
                  <tr
                    key={i}
                    onClick={() => toggleRowExpand(i)}
                    className={`border-b border-white/5 cursor-pointer ${isExpanded ? 'bg-white/5' : 'hover:bg-white/5'}`}
                  >
                    <td className="px-2 py-1 whitespace-nowrap text-slate-500">{formatTime(e.timestamp)}</td>
                    <td className={`px-2 py-1 whitespace-nowrap ${isOutbound ? 'text-green-400' : 'text-amber-400'}`} title={isOutbound ? 'outbound' : 'inbound'}>
                      <span className="inline-flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs" style={{ fontSize: '12px' }}>
                          {isOutbound ? 'arrow_upward' : 'arrow_downward'}
                        </span>
                        {e.sender || '?'}
                      </span>
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-cyan-400 truncate max-w-[250px]" title={e.subject}>
                      {e.subject}
                    </td>
                    <td className={`px-2 py-1 text-slate-400 ${isExpanded ? '' : 'truncate max-w-[350px]'}`} title={isExpanded ? undefined : e.data}>
                      {isExpanded ? (
                        <div className="whitespace-pre-wrap break-all py-1">{e.data}</div>
                      ) : (
                        truncate(e.data, 120)
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
          {paused ? 'paused' : 'live'} | {filteredEvents.length} events {filter && `(${events.length} total)`} | {subscriptions.length} subs
        </span>
      </div>
    </div>
  )
}
