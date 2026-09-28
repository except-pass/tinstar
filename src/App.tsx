import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, apiUrl } from './apiClient'
import { getAvatarDataUrl, subscribeAvatarCache } from './components/agentAvatarCache'
import { PALETTE_COLORS } from './components/ColorPalette'
import './cockpit.css'

interface Worker {
  key: string; id: string; home: string; kind: string; state: string; detail: string
  observedAt: string | null; freshness: string; objective: string; project: string
  worktree: string; branch: string; prUrl: string | null; terminalAvailable: boolean
}
interface FleetData { workers: Worker[]; errors: string[] }
type Terminal = { state: 'live'; port: number; pid: number | null; cols: number; rows: number } | { state: 'unavailable'; reason: string }

function identityColor(id: string): string {
  let hash = 2166136261
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  return PALETTE_COLORS[(hash % 8) * 3 + 1]!
}

function Face({ worker, size = 40 }: { worker: Worker; size?: number }) {
  const [, refresh] = useState(0)
  useEffect(() => subscribeAvatarCache(() => refresh(n => n + 1)), [])
  const color = identityColor(worker.id)
  const avatar = getAvatarDataUrl(worker.id, color)
  return <span className="cockpit-face" style={{ width: size, height: size, borderColor: color }}>
    {avatar ? <img src={avatar} alt="" /> : <span aria-hidden="true">✦</span>}
  </span>
}

function StateChip({ state }: { state: string }) {
  return <span className={`cockpit-state cockpit-state-${state.toLowerCase().replace(/[^a-z0-9-]/g, '')}`}>{state}</span>
}

function displayTime(value: string | null): string {
  if (!value) return 'unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export default function App() {
  const [fleet, setFleet] = useState<FleetData>({ workers: [], errors: [] })
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [jumpText, setJumpText] = useState('')
  const [terminals, setTerminals] = useState<Record<string, Terminal>>({})
  const [opening, setOpening] = useState<Record<string, boolean>>({})
  const focusTerminal = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch('/api/fleet')
      if (!res.ok) throw new Error(`Fleet service unavailable (HTTP ${res.status})`)
      const raw = await res.text()
      if (!raw) throw new Error('Fleet service returned an empty response')
      let body: { ok: boolean; data?: FleetData }
      try { body = JSON.parse(raw) as typeof body } catch { throw new Error('Fleet service response was incomplete') }
      if (body.ok && body.data) setFleet(body.data)
      else throw new Error('Fleet service did not return workers')
    } catch (err) {
      setFleet(previous => ({ ...previous, errors: [(err as Error).message] }))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const workers = fleet.workers
  const current = workers.find(w => w.key === selected) ?? null
  const order = useMemo(() => workers.map(w => w.key), [workers])
  const cycle = useCallback((direction: number, fromTerminal = false) => {
    if (!order.length) return
    focusTerminal.current = fromTerminal && order.length > 1
    setSelected(previous => {
      const index = previous ? order.indexOf(previous) : -1
      if (index < 0) return order[direction > 0 ? 0 : order.length - 1]!
      return order[(index + direction + order.length) % order.length]!
    })
  }, [order])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey || e.altKey || (e.code !== 'BracketRight' && e.code !== 'BracketLeft')) return
      e.preventDefault(); e.stopPropagation(); cycle(e.code === 'BracketRight' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cycle])

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type !== 'terminal-session-cycle') return
      const source = [...document.querySelectorAll<HTMLIFrameElement>('.cockpit-terminal-frame')]
        .find(frame => frame.contentWindow === e.source)
      if (!source || e.origin !== new URL(source.src).origin || e.data.sessionName !== source.dataset.session) return
      const action = e.data.action
      if (action === 'ready-next' || action === 'all-next') cycle(1, true)
      if (action === 'ready-prev' || action === 'all-prev') cycle(-1, true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [cycle])

  const currentKey = current?.key ?? null
  const currentTerminalAvailable = current?.terminalAvailable ?? false
  useEffect(() => {
    if (!currentKey || !currentTerminalAvailable) return
    const key = currentKey
    setOpening(previous => ({ ...previous, [key]: true }))
    void apiFetch(`/api/fleet/${encodeURIComponent(key)}/terminal`)
      .then(async res => {
        const body = await res.json() as { ok: boolean; data?: Terminal; error?: { message: string } }
        const next: Terminal = body.ok && body.data ? body.data : { state: 'unavailable', reason: body.error?.message ?? 'Terminal unavailable' }
        setTerminals(previous => {
          const old = previous[key]
          if (old?.state === 'live' && next.state === 'live' && old.port === next.port && old.pid === next.pid
            && old.cols === next.cols && old.rows === next.rows) return previous
          return { ...previous, [key]: next }
        })
      })
      .catch(err => setTerminals(previous => ({ ...previous, [key]: { state: 'unavailable', reason: (err as Error).message } })))
      .finally(() => setOpening(previous => ({ ...previous, [key]: false })))
  }, [currentKey, currentTerminalAvailable, fleet])

  useEffect(() => {
    if (!focusTerminal.current) return
    focusTerminal.current = false
    const frame = [...document.querySelectorAll<HTMLIFrameElement>('.cockpit-terminal-frame')].find(f => f.dataset.session === currentKey)
    if (!frame) {
      if (document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur()
      return
    }
    frame.focus()
    frame.contentWindow?.postMessage({ type: 'terminal-focus' }, new URL(frame.src).origin)
  }, [currentKey])

  const states = useMemo(() => {
    const groups = new Map<string, Worker[]>()
    for (const worker of workers) groups.set(worker.state, [...(groups.get(worker.state) ?? []), worker])
    return [...groups]
  }, [workers])
  const activeIndex = current ? order.indexOf(current.key) : -1

  return <div className="cockpit-shell">
    <aside className="cockpit-rail">
      <div className="cockpit-brand"><span className="cockpit-brand-mark">✦</span><div><strong>TIN STAR</strong><small>WORKER COCKPIT</small></div></div>
      <button className={`cockpit-overview-button ${!current ? 'active' : ''}`} onClick={() => setSelected(null)}><span className="material-symbols-outlined">dashboard</span>Overview</button>
      <input className="cockpit-jump" aria-label="Jump to worker" placeholder="Jump to worker ↵" value={jumpText} onChange={e => setJumpText(e.target.value)} onKeyDown={e => {
        if (e.key !== 'Enter') return
        const match = workers.find(w => w.id.toLowerCase().includes(jumpText.trim().toLowerCase()))
        if (match && jumpText.trim()) { setSelected(match.key); setJumpText('') }
      }} />
      <div className="cockpit-rail-heading"><span>WORKERS</span><span>{workers.length}</span></div>
      <div className="cockpit-worker-list">
        {workers.map(worker => <button key={worker.key} className={`cockpit-worker-button ${selected === worker.key ? 'active' : ''}`} onClick={() => setSelected(worker.key)} style={{ '--worker-color': identityColor(worker.id) } as React.CSSProperties}>
          <Face worker={worker} size={35} /><span className="cockpit-worker-label"><strong>{worker.id}</strong><small>{worker.project}</small></span><StateChip state={worker.state} />
        </button>)}
      </div>
      <div className="cockpit-rail-footer">CTRL + [ &nbsp; / &nbsp; CTRL + ]<span>Switch workers</span></div>
    </aside>
    <main className="cockpit-main">
      {!current ? <>
        <header className="cockpit-main-header"><span className="cockpit-eyebrow">FLEET / OVERVIEW</span><h1>Workers</h1><p>Live work across your First Mate homes</p></header>
        {fleet.errors.length > 0 && <div className="cockpit-error" role="alert">Fleet update delayed: {fleet.errors.join('; ')}</div>}
        {loading ? <p className="cockpit-empty">Loading workers…</p> : workers.length === 0 ? <p className="cockpit-empty">{fleet.errors.length ? 'Waiting for the fleet service to reconnect…' : 'No workers found. Configure a First Mate home to see its fleet.'}</p> : <div className="cockpit-groups">
          {states.map(([state, entries]) => <section key={state} className="cockpit-group"><div className="cockpit-group-heading"><StateChip state={state} /><span>{entries.length} {entries.length === 1 ? 'worker' : 'workers'}</span></div><div className="cockpit-card-grid">
            {entries.map(worker => <button key={worker.key} className="cockpit-card" onClick={() => setSelected(worker.key)} style={{ '--worker-color': identityColor(worker.id) } as React.CSSProperties}><div className="cockpit-card-top"><Face worker={worker} size={46} /><div><strong>{worker.id}</strong><span>{worker.project}</span></div><span className="material-symbols-outlined">arrow_forward</span></div><p>{worker.objective}</p><small>{worker.detail}</small></button>)}
          </div></section>)}
        </div>}
      </> : <>
        <header className="cockpit-worker-header" style={{ '--worker-color': identityColor(current.id) } as React.CSSProperties}>
          <div className="cockpit-worker-identity"><Face worker={current} size={68} /><div><span className="cockpit-eyebrow">WORKER / {current.kind}</span><h1>{current.id}</h1><StateChip state={current.state} /></div></div>
          <div className="cockpit-switch"><button aria-label="Previous worker" title="Previous worker (Ctrl+[)" onClick={() => cycle(-1)} disabled={workers.length < 2}>← <span>Previous</span></button><span>{activeIndex + 1} / {workers.length}</span><button aria-label="Next worker" title="Next worker (Ctrl+])" onClick={() => cycle(1)} disabled={workers.length < 2}><span>Next</span> →</button></div>
        </header>
        <div className="cockpit-worker-content"><section className="cockpit-objective"><span className="cockpit-eyebrow">OBJECTIVE</span><p>{current.objective}</p></section>
          <div className="cockpit-facts"><div><span>PROJECT</span><strong>{current.project}</strong></div><div><span>WORKTREE</span><strong>{current.worktree}</strong></div><div><span>BRANCH</span><strong>{current.branch}</strong></div><div><span>PR</span>{current.prUrl ? <a href={current.prUrl} target="_blank" rel="noopener noreferrer">Open pull request ↗</a> : <strong>unknown</strong>}</div></div>
          <div className="cockpit-status-detail"><StateChip state={current.state} /><span>{current.detail}</span><small>{current.freshness} · observed {displayTime(current.observedAt)}</small></div>
          <section className="cockpit-terminal"><div className="cockpit-terminal-heading"><span><span className="material-symbols-outlined">terminal</span> LIVE TERMINAL</span><small>Direct terminal input</small></div><div className="cockpit-terminal-stage">
            {workers.flatMap(worker => {
              const terminal = terminals[worker.key]
              if (terminal?.state !== 'live') return []
              const active = current.key === worker.key
              return [<iframe key={`${worker.key}:${terminal.port}:${terminal.pid}:${terminal.cols}x${terminal.rows}`} ref={frame => { if (frame) frame.inert = !active }} className="cockpit-terminal-frame" data-session={worker.key} src={apiUrl(`/terminal-wrapper.html?session=${encodeURIComponent(worker.key)}&cols=${terminal.cols}&rows=${terminal.rows}`)} title={`${worker.id} terminal`} style={{ opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none', zIndex: active ? 1 : 0 }} />]
            })}
            {opening[current.key] && !terminals[current.key] && <p className="cockpit-terminal-placeholder">Connecting to terminal…</p>}
            {!current.terminalAvailable && <p className="cockpit-terminal-placeholder">Terminal endpoint unavailable</p>}
            {terminals[current.key]?.state === 'unavailable' && <p className="cockpit-terminal-placeholder">{(terminals[current.key] as Extract<Terminal, { state: 'unavailable' }>).reason}</p>}
          </div></section>
        </div>
      </>}
    </main>
  </div>
}
