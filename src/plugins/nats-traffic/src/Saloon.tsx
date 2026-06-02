// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
// Lone exception: `EV` from src/lib/windowEvents (shared window-events schema).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { EV } from '../../../lib/windowEvents'
import { StreamView } from './StreamView'
import { subjectMatchesAny } from './subjectMatches'
import { resolveBinding } from './resolveBinding'
import type { TrafficEvent } from './types'

const MAX_EVENTS = 200

/** Shape returned by a run's `session.nats` capability. */
interface SessionNats { sessionId: string; status?: string; subscriptions: string[]; color?: string; orphanedAt?: string | null }
/** Per-bound-session info kept for the header. */
interface BoundSession { sessionId: string; status?: string; subscriptions: string[]; orphanedAt?: string | null }

const STATUS_META: Record<string, { color: string; label: string }> = {
  running: { color: '#22c55e', label: 'running' },
  idle: { color: '#38bdf8', label: 'idle' },
  needs_attention: { color: '#f59e0b', label: 'needs attention' },
  creating: { color: '#94a3b8', label: 'creating' },
  stopped: { color: '#64748b', label: 'stopped' },
}

export function makeSaloonWidget(api: TinstarPluginAPI) {
  return function Saloon(_props: WidgetProps) {
    const myNodeId = api.constellations.useMyNodeId()
    const slots = api.constellations.useMySlots()
    const peers = api.constellations.usePeers()
    const invoke = api.constellations.useInvokePeerCapability()
    const del = api.widget.useDelete()

    const binding = useMemo(
      () => resolveBinding({ inConstellation: slots.length > 0, peers }),
      [slots.length, peers],
    )
    // Primitive identity for the current binding. `binding` (and `peers`) get a
    // fresh object identity every render, so effects must key off this string —
    // not the object — to fire only when the binding actually changes.
    const bindingKey = binding.mode === 'runs'
      ? `runs:${[...binding.runIds].sort().join(',')}`
      : binding.mode

    // 'all' mode (unsnapped) claims to show all traffic, but the bridge only
    // subscribes to subjects bound sessions registered. Ask the server for a
    // real tinstar.> firehose while unbound, and release it on bind/unmount so
    // we don't hold a full-bus subscription longer than the widget shows it.
    useEffect(() => {
      if (binding.mode !== 'all') return
      const toggle = (on: boolean) => api.http.fetch('/api/nats-traffic/firehose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ widgetId: myNodeId, on }),
      }).catch(() => { /* best-effort; bridge bounce/restart reconciles */ })
      toggle(true)
      return () => { toggle(false) }
    }, [binding.mode, myNodeId])

    // Resolve session info (name, status, subjects, accent) for bound runs via
    // the session.nats capability.
    const [bound, setBound] = useState<BoundSession[]>([])
    const [accent, setAccent] = useState<string | undefined>(undefined)
    // Re-poll the bound run(s) so the header status + subscriptions stay live
    // (the capability payload changes as the session's status changes).
    const [tick, setTick] = useState(0)
    useEffect(() => {
      if (binding.mode !== 'runs') return
      const t = setInterval(() => setTick(n => n + 1), 2000)
      return () => clearInterval(t)
    }, [bindingKey])
    useEffect(() => {
      let cancelled = false
      ;(async () => {
        if (binding.mode !== 'runs') { setBound([]); setAccent(undefined); return }
        const runIds = binding.runIds
        const results = await Promise.all(runIds.map(id =>
          (invoke(id, 'session.nats', {}) as Promise<SessionNats | null>).catch(() => null)
        ))
        if (cancelled) return
        const sessions: BoundSession[] = results
          .filter((r): r is SessionNats => r != null)
          .map(r => ({ sessionId: r.sessionId, status: r.status, subscriptions: r.subscriptions ?? [], orphanedAt: r.orphanedAt ?? null }))
        setBound(sessions)
        setAccent(runIds.length === 1 ? api.theme.accent.resolve(results[0]?.color) : undefined)
      })()
      return () => { cancelled = true }
    }, [bindingKey, invoke, tick])
    const subjects = useMemo(() => bound.flatMap(b => b.subscriptions), [bound])

    // Collect nats_traffic, filter by mode.
    const [events, setEvents] = useState<TrafficEvent[]>([])
    const [filter, setFilter] = useState('')
    const batchRef = useRef<TrafficEvent[]>([])
    const rafRef = useRef<number | null>(null)
    const subjectsRef = useRef(subjects); subjectsRef.current = subjects
    const modeRef = useRef(binding.mode); modeRef.current = binding.mode

    // Re-binding to a different session (or mode) must drop the previous
    // binding's accumulated traffic — otherwise stale cross-session rows linger
    // until they age past MAX_EVENTS. Also discard any in-flight batch.
    useEffect(() => {
      setEvents([])
      batchRef.current = []
    }, [bindingKey])

    useEffect(() => {
      const flush = () => {
        rafRef.current = null
        const batch = batchRef.current; batchRef.current = []
        if (!batch.length) return
        setEvents(prev => {
          let next = [...prev, ...batch]
          if (next.length > MAX_EVENTS) next = next.slice(-MAX_EVENTS)
          return next
        })
      }
      const handler = (e: Event) => {
        const det = (e as CustomEvent).detail as TrafficEvent
        if (modeRef.current === 'empty') return
        if (modeRef.current === 'runs' && !subjectMatchesAny(det.subject, subjectsRef.current)) return
        batchRef.current.push(det)
        if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush)
      }
      window.addEventListener(EV.natsTraffic, handler)
      return () => { window.removeEventListener(EV.natsTraffic, handler); if (rafRef.current !== null) cancelAnimationFrame(rafRef.current) }
    }, [])

    // Single bound session → show its name + live status in the header.
    const single = binding.mode === 'runs' && bound.length === 1 ? bound[0]! : null
    const status = single?.status ? STATUS_META[single.status] : undefined

    // Broker health: any bound session whose NATS control socket was orphaned.
    // The reconnect button bounces the host's NATS observer (re-establishes all
    // subscriptions) — global, so it's offered whenever we're showing traffic.
    const orphaned = bound.some(b => b.orphanedAt)
    const [reconnecting, setReconnecting] = useState(false)
    const reconnect = () => {
      if (reconnecting) return
      setReconnecting(true)
      api.http.fetch('/api/nats-traffic/bounce', { method: 'POST' })
        .catch(() => { /* best-effort; the orphan dot reflects real state on next poll */ })
        .finally(() => setReconnecting(false))
    }

    return (
      <div className="flex flex-col h-full bg-surface-base text-slate-300 overflow-hidden" style={accent ? { boxShadow: `inset 0 2px 0 ${accent}` } : undefined}>
        <div className="widget-drag-handle flex items-center gap-2 px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab">
          <span className="text-primary text-xs flex-shrink-0">SALOON</span>
          {single ? (
            <span className="flex items-center gap-1.5 flex-1 min-w-0">
              {status && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: status.color }} title={status.label} />}
              <span className="text-xs text-slate-200 truncate">{single.sessionId}</span>
              {status && <span className="text-2xs text-slate-500 flex-shrink-0">{status.label}</span>}
            </span>
          ) : (
            <span className="text-2xs font-mono text-slate-400 flex-1 truncate">
              {binding.mode === 'all'
                ? 'all traffic'
                : bound.length > 1
                  ? bound.map(b => b.sessionId).join(', ')
                  : '…'}
            </span>
          )}
          {binding.mode !== 'empty' && (
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              onPointerDown={e => e.stopPropagation()}
              placeholder="Filter…"
              className="w-32 bg-surface-base text-2xs font-mono px-2 py-0.5 rounded border border-white/10 focus:border-primary/50 focus:outline-none"
            />
          )}
          {binding.mode !== 'empty' && (
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={reconnect}
              disabled={reconnecting}
              className={`flex-shrink-0 ${orphaned ? 'text-amber-400 hover:text-amber-300' : 'text-slate-500 hover:text-slate-300'}`}
              title={orphaned ? 'NATS observer orphaned — click to reconnect' : 'Reconnect NATS observer'}
            >
              <span className={`material-symbols-outlined text-sm${reconnecting ? ' animate-spin' : ''}`}>sync</span>
            </button>
          )}
          <button onPointerDown={e => e.stopPropagation()} onClick={() => del()} className="text-slate-500 hover:text-slate-300 flex-shrink-0" title="Close">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
        {binding.mode !== 'empty' && (
          <div
            className="px-3 py-0.5 bg-surface-panel/60 border-b border-white/5 text-2xs font-mono text-slate-500 truncate flex-shrink-0"
            title={binding.mode === 'all' ? 'all subjects (every session’s traffic)' : subjects.join('\n')}
          >
            <span className="text-slate-600">subscribed: </span>
            {binding.mode === 'all'
              ? 'tinstar.> (all sessions)'
              : subjects.length ? subjects.join('  ·  ') : 'resolving…'}
          </div>
        )}
        {binding.mode === 'empty'
          ? <div className="flex-1 flex items-center justify-center text-slate-500 text-xs px-4 text-center">📡 Snap onto a session to monitor its traffic</div>
          /* key on bindingKey so a rebind remounts StreamView, dropping any open
             detail modal / selected row — otherwise the previous session's
             payload stays readable after switching sessions. */
          : <StreamView key={bindingKey} events={events} filter={filter} />}
      </div>
    )
  }
}
