// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
// Lone exception: `EV` from src/lib/windowEvents (shared window-events schema).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { EV } from '../../../lib/windowEvents'
import { StreamView } from './StreamView'
import { subjectMatchesAny } from './subjectMatches'
import { resolveBinding } from './resolveBinding'
import type { TrafficEvent, SaloonData } from './types'

const MAX_EVENTS = 200

export function makeSaloonWidget(api: TinstarPluginAPI) {
  return function Saloon(_props: WidgetProps<SaloonData>) {
    const slots = api.constellations.useMySlots()
    const peers = api.constellations.usePeers()
    const invoke = api.constellations.useInvokePeerCapability()
    const [data, setData] = api.widget.useData<SaloonData>()
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

    // Resolve subjects (+ accent) for bound runs via the session.nats capability.
    const [subjects, setSubjects] = useState<string[]>([])
    const [accent, setAccent] = useState<string | undefined>(undefined)
    useEffect(() => {
      let cancelled = false
      ;(async () => {
        if (binding.mode !== 'runs') { setSubjects([]); setAccent(undefined); return }
        const runIds = binding.runIds
        const results = await Promise.all(runIds.map(id =>
          (invoke(id, 'session.nats', {}) as Promise<{ subscriptions: string[]; color?: string } | null>).catch(() => null)
        ))
        if (cancelled) return
        const subs = results.flatMap(r => r?.subscriptions ?? [])
        setSubjects(subs)
        setAccent(runIds.length === 1 ? api.theme.accent.resolve(results[0]?.color) : undefined)
        const prevIds = data?.boundRunIds ?? []
        if (JSON.stringify(prevIds) !== JSON.stringify(runIds)) setData({ boundRunIds: runIds })
      })()
      return () => { cancelled = true }
    }, [bindingKey, invoke])

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

    const subtitle = binding.mode === 'all'
      ? 'all traffic'
      : binding.mode === 'empty'
        ? 'no sessions in this group'
        : `${binding.runIds.length} session${binding.runIds.length === 1 ? '' : 's'}`

    return (
      <div className="flex flex-col h-full bg-surface-base text-slate-300 overflow-hidden" style={accent ? { boxShadow: `inset 0 2px 0 ${accent}` } : undefined}>
        <div className="widget-drag-handle flex items-center gap-2 px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab">
          <span className="text-primary text-xs">SALOON</span>
          <span className="text-2xs font-mono text-slate-400 flex-1 truncate">{subtitle}</span>
          {binding.mode !== 'empty' && (
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              onPointerDown={e => e.stopPropagation()}
              placeholder="Filter…"
              className="w-32 bg-surface-base text-2xs font-mono px-2 py-0.5 rounded border border-white/10 focus:border-primary/50 focus:outline-none"
            />
          )}
          <button onPointerDown={e => e.stopPropagation()} onClick={() => del()} className="text-slate-500 hover:text-slate-300 flex-shrink-0" title="Close">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
        {binding.mode === 'empty'
          ? <div className="flex-1 flex items-center justify-center text-slate-500 text-xs px-4 text-center">📡 Snap onto a session to monitor its traffic</div>
          : <StreamView events={events} filter={filter} />}
      </div>
    )
  }
}
