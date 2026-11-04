import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, apiUrl } from './apiClient'
import { findLinkedWorker, homeName, linkLocation, readOverviewSearch, writeOverviewSearch, type OverviewLocation } from './cockpit/overviewQuery'
import { directLabel } from './cockpit/groupWorkers'
import { ActivityBar } from './cockpit/shell/ActivityBar'
import { ContextPanel } from './cockpit/shell/ContextPanel'
import { MessagesPanel } from './cockpit/shell/MessagesPanel'
import { Composer, Face, MateBadge, StateChip, identityColor } from './cockpit/shell/present'
import { WorkerSwitcherPanel } from './cockpit/shell/WorkerSwitcherPanel'
import { DRAWER_MEDIA, isDrawerLayout, messageNeedsAttention, type AttentionCard, type ContextPanelMode, type Draft, type OutboxMessage, type SubmitResult, type Worker } from './cockpit/shell/types'
import { ComposerInput } from './components/PromptComposer/PromptComposer'
import './cockpit.css'
import { Overview } from './reconciliation/Overview'

interface FleetData { ready: boolean; workers: Worker[]; attention: AttentionCard[]; errors: string[] }
type Terminal = { state: 'live'; port: number; pid: number | null } | { state: 'unavailable'; reason: string }

function DirectControl({ worker, disabled, onChange }: { worker: Worker; disabled: boolean; onChange: (direct: boolean) => void }) {
  const label = directLabel(worker.direct)
  return <button
    type="button"
    className={`cockpit-direct${worker.direct ? ' cockpit-direct-on' : ''}`}
    aria-pressed={worker.direct}
    aria-label={`${worker.id} ${label}`}
    disabled={disabled}
    onClick={() => onChange(!worker.direct)}
  >{label}</button>
}

function displayTime(value: string | null): string {
  if (!value) return 'unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export default function App() {
  const [fleet, setFleet] = useState<FleetData>({ ready: false, workers: [], attention: [], errors: [] })
  const [detailOpen, setDetailOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(true)
  const [overviewLocation, setOverviewLocation] = useState<OverviewLocation>(() => readOverviewSearch(window.location.search))
  const [drawer, setDrawer] = useState(isDrawerLayout)
  const [panelMode, setPanelMode] = useState<ContextPanelMode>(null)
  const drawerRef = useRef(drawer)
  drawerRef.current = drawer
  const [jumpText, setJumpText] = useState('')
  const [terminals, setTerminals] = useState<Record<string, Terminal>>({})
  const [opening, setOpening] = useState<Record<string, boolean>>({})
  const [messages, setMessages] = useState<OutboxMessage[]>([])
  const [messageError, setMessageError] = useState<string | null>(null)
  const [directBusy, setDirectBusy] = useState<Record<string, boolean>>({})
  const pendingDirect = useRef(new Map<string, { direct: boolean; after: number | null }>())
  const fleetRequests = useRef(0)
  const focusTerminal = useRef(false)
  const messagesInFlight = useRef(false)
  const overviewRef = useRef(overviewLocation)
  overviewRef.current = overviewLocation
  const refresh = useCallback(async () => {
    const started = ++fleetRequests.current
    try {
      const res = await apiFetch('/api/fleet')
      if (!res.ok) throw new Error(`Fleet service unavailable (HTTP ${res.status})`)
      const raw = await res.text()
      if (!raw) throw new Error('Fleet service returned an empty response')
      let body: { ok: boolean; data?: FleetData }
      try { body = JSON.parse(raw) as typeof body } catch { throw new Error('Fleet service response was incomplete') }
      if (body.ok && body.data) {
        const workers = body.data.workers.map(worker => {
          const pending = pendingDirect.current.get(worker.key)
          if (pending === undefined) return worker
          if (pending.after !== null && started > pending.after) {
            pendingDirect.current.delete(worker.key)
            return worker
          }
          return { ...worker, direct: pending.direct }
        })
        setFleet({ ...body.data, workers })
      }
      else throw new Error('Fleet service did not return workers')
    } catch (err) {
      setFleet(previous => ({ ...previous, errors: [(err as Error).message] }))
    }
  }, [])

  const refreshMessages = useCallback(async () => {
    if (messagesInFlight.current) return
    messagesInFlight.current = true
    try {
      const response = await apiFetch('/api/fleet/messages')
      const body = await response.json() as { ok: boolean; data?: OutboxMessage[] }
      if (!body.ok || !body.data) throw new Error('Messages unavailable')
      setMessages(body.data); setMessageError(null)
    } catch (error) { setMessageError((error as Error).message) } finally { messagesInFlight.current = false }
  }, [])

  const submit = useCallback(async (draft: Draft) => {
    const response = await apiFetch('/api/fleet/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })
    const body = await response.json() as { ok: boolean; data?: SubmitResult; error?: { message: string } }
    if (!body.ok || !body.data) throw new Error(body.error?.message ?? 'Message unavailable')
    void refreshMessages()
    return body.data
  }, [refreshMessages])

  const retry = useCallback((message: OutboxMessage) => {
    void submit({ requestId: message.requestId, kind: message.kind, text: message.text })
      .catch(error => setMessageError((error as Error).message))
  }, [submit])

  const directLocks = useRef(new Set<string>())
  const setDirect = useCallback(async (worker: Worker, direct: boolean) => {
    if (directLocks.current.has(worker.key)) return
    directLocks.current.add(worker.key)
    setDirectBusy(previous => ({ ...previous, [worker.key]: true }))
    pendingDirect.current.set(worker.key, { direct, after: null })
    setFleet(previous => ({ ...previous, workers: previous.workers.map(item => item.key === worker.key ? { ...item, direct } : item) }))
    try {
      const response = await apiFetch(`/api/fleet/${encodeURIComponent(worker.key)}/direct`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direct }),
      })
      const body = await response.json() as { ok: boolean; data?: { direct: boolean; note: SubmitResult | null }; error?: { message: string } }
      const applied = body.data
      if (!response.ok || !body.ok || !applied) throw new Error(body.error?.message ?? 'Could not update the mark')
      pendingDirect.current.set(worker.key, { direct: applied.direct, after: fleetRequests.current })
      setFleet(previous => ({ ...previous, workers: previous.workers.map(item => item.key === worker.key ? { ...item, direct: applied.direct } : item) }))
      if (applied.note && !applied.note.saved) setMessageError(`The mark was saved. First Mate did not get the note${applied.note.error ? `: ${applied.note.error}` : '.'}`)
    } catch (error) {
      pendingDirect.current.delete(worker.key)
      setFleet(previous => ({ ...previous, workers: previous.workers.map(item => item.key === worker.key ? { ...item, direct: worker.direct } : item) }))
      setMessageError((error as Error).message)
    } finally {
      directLocks.current.delete(worker.key)
      setDirectBusy(previous => ({ ...previous, [worker.key]: false }))
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshMessages()
    const timer = window.setInterval(() => { void refresh(); void refreshMessages() }, 5_000)
    return () => window.clearInterval(timer)
  }, [refresh, refreshMessages])

  const workers = fleet.workers
  const attention = fleet.attention ?? []
  const current = findLinkedWorker(workers, overviewLocation)

  const applyOverviewLocation = useCallback((next: OverviewLocation, mode: 'push' | 'replace') => {
    const search = writeOverviewSearch(window.location.search, linkLocation(workers, next))
    const url = `${window.location.pathname}${search}${window.location.hash}`
    const here = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (url !== here) {
      // WebKit and Firefox throw after bursts of history calls; the view must still follow.
      try {
        if (mode === 'push') history.pushState(null, '', url)
        else history.replaceState(null, '', url)
      } catch {}
    }
    overviewRef.current = next
    setOverviewLocation(next)
  }, [workers])

  const openWorker = useCallback((key: string, mode: 'push' | 'replace' = 'push') => {
    const worker = workers.find(item => item.key === key)
    if (!worker) return
    if (mode === 'push') {
      if (drawerRef.current) setPanelMode(null)
      else if (!overviewRef.current.worker) setPanelMode(current => current && 'workers')
    }
    applyOverviewLocation({ worker: worker.id, home: homeName(worker.home), key: worker.key, q: overviewRef.current.q }, mode)
  }, [workers, applyOverviewLocation])

  const openOverview = useCallback(() => {
    setPanelMode(null)
    applyOverviewLocation({ worker: null, home: null, key: null, q: overviewRef.current.q }, 'push')
  }, [applyOverviewLocation])

  const selectPanel = useCallback((mode: Exclude<ContextPanelMode, null>) => {
    setPanelMode(current => current === mode ? null : mode)
  }, [])

  const order = useMemo(() => workers.map(w => w.key), [workers])
  const cycle = useCallback((direction: number, fromTerminal = false) => {
    if (!order.length) return
    focusTerminal.current = fromTerminal && order.length > 1
    const currentKey = findLinkedWorker(workers, overviewRef.current)?.key
    const index = currentKey ? order.indexOf(currentKey) : -1
    openWorker(index < 0
      ? order[direction > 0 ? 0 : order.length - 1]!
      : order[(index + direction + order.length) % order.length]!, 'replace')
  }, [order, workers, openWorker])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey || e.altKey || (e.code !== 'BracketRight' && e.code !== 'BracketLeft')) return
      e.preventDefault(); e.stopPropagation(); cycle(e.code === 'BracketRight' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cycle])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(DRAWER_MEDIA)
    const onChange = () => setDrawer(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!drawer || !panelMode) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setPanelMode(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drawer, panelMode])

  useEffect(() => {
    const onPop = () => {
      setOverviewLocation(readOverviewSearch(window.location.search))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

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

  const terminalsRef = useRef(terminals)
  useEffect(() => { terminalsRef.current = terminals }, [terminals])
  const currentKey = current?.key ?? null
  const currentTerminalAvailable = current?.terminalAvailable ?? false
  const currentTerminalPid = current?.terminalPid ?? null
  useEffect(() => {
    if (!currentKey || !currentTerminalAvailable) return
    const key = currentKey
    const known = terminalsRef.current[key]
    if (known?.state === 'live' && known.pid === currentTerminalPid) return
    setOpening(previous => ({ ...previous, [key]: true }))
    void apiFetch(`/api/fleet/${encodeURIComponent(key)}/terminal`)
      .then(async res => {
        const body = await res.json() as { ok: boolean; data?: Terminal; error?: { message: string } }
        const next: Terminal = body.ok && body.data ? body.data : { state: 'unavailable', reason: body.error?.message ?? 'Terminal unavailable' }
        setTerminals(previous => {
          const old = previous[key]
          if (old?.state === 'live' && next.state === 'live' && old.port === next.port && old.pid === next.pid) return previous
          return { ...previous, [key]: next }
        })
      })
      .catch(err => setTerminals(previous => previous[key]?.state === 'live' ? previous
        : { ...previous, [key]: { state: 'unavailable', reason: (err as Error).message } }))
      .finally(() => setOpening(previous => ({ ...previous, [key]: false })))
  }, [currentKey, currentTerminalAvailable, currentTerminalPid, fleet])

  useEffect(() => {
    if (!currentKey) return
    const key = currentKey
    return () => { void apiFetch(`/api/fleet/${encodeURIComponent(key)}/terminal/leave`, { method: 'POST' }).catch(() => {}) }
  }, [currentKey])

  useEffect(() => {
    const frame = [...document.querySelectorAll<HTMLIFrameElement>('.cockpit-terminal-frame')].find(f => f.dataset.session === currentKey)
    if (!frame) {
      if (focusTerminal.current && document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur()
      focusTerminal.current = false
      return
    }
    const origin = new URL(frame.src).origin
    if (focusTerminal.current) {
      focusTerminal.current = false
      frame.focus()
      frame.contentWindow?.postMessage({ type: 'terminal-focus' }, origin)
    }
    frame.contentWindow?.postMessage({ type: 'terminal-reveal-prompt', sessionName: currentKey }, origin)
  }, [currentKey])

  const activeIndex = current ? order.indexOf(current.key) : -1

  return <div className="cockpit-shell">
    <ActivityBar overviewActive={!overviewLocation.worker} panelMode={panelMode} counts={{ needs: attention.length, messages: messages.length, workers: workers.length }} messageAttention={messages.filter(messageNeedsAttention).length} onOverview={openOverview} onSelect={selectPanel} />
    {panelMode && drawer && <button type="button" className="cockpit-context-backdrop" aria-label="Dismiss panel" onClick={() => setPanelMode(null)} />}
    <ContextPanel mode={panelMode} count={panelMode === 'needs' ? attention.length : panelMode === 'messages' ? messages.length : workers.length} onCollapse={() => setPanelMode(null)}>

      <div hidden={panelMode !== 'messages'}><MessagesPanel messages={messages} error={messageError} retry={retry} /></div>
      <div hidden={panelMode !== 'workers'}><WorkerSwitcherPanel workers={workers} currentKey={current?.key ?? null} query={jumpText} onQuery={setJumpText} onOpen={openWorker} /></div>
    </ContextPanel>
    <main className={`cockpit-main ${current ? 'cockpit-main-worker' : ''}`}>
      {!current && !overviewLocation.worker ? <Overview workers={workers} messages={messages} submit={submit} /> : current ? <>
        <div className="cockpit-session">
        <section className="cockpit-terminal" aria-label="Live terminal"><div className="cockpit-terminal-stage">
          {workers.flatMap(worker => {
            const terminal = terminals[worker.key]
            if (terminal?.state !== 'live') return []
            const active = current.key === worker.key
            return [<iframe key={`${worker.key}:${terminal.port}:${terminal.pid}`} ref={frame => { if (frame) frame.inert = !active }} className="cockpit-terminal-frame" data-session={worker.key} src={apiUrl(`/terminal-wrapper.html?session=${encodeURIComponent(worker.key)}`)} title={`${worker.id} terminal`} style={{ opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none', zIndex: active ? 1 : 0 }} />]
          })}
          {opening[current.key] && !terminals[current.key] && <p className="cockpit-terminal-placeholder">Connecting to terminal…</p>}
          {!current.terminalAvailable && <p className="cockpit-terminal-placeholder">Terminal endpoint unavailable</p>}
          {terminals[current.key]?.state === 'unavailable' && <p className="cockpit-terminal-placeholder">{(terminals[current.key] as Extract<Terminal, { state: 'unavailable' }>).reason}</p>}
        </div></section>
        <div className="cockpit-prompt-dock">
          <ComposerInput key={current.key} sessionId={current.key} accent={identityColor(current.id)} status={current.state} expanded={composerOpen} onToggle={() => setComposerOpen(open => !open)} />
        </div>
        </div>
        <aside className={`cockpit-detail-rail ${detailOpen ? 'is-open' : ''}`}>
          <button type="button" className="cockpit-detail-summary" aria-expanded={detailOpen} onClick={() => setDetailOpen(open => !open)}>{detailOpen ? 'Close' : 'Details'}</button>
          <div className="cockpit-detail-body">
            <header className="cockpit-worker-header" style={{ '--worker-color': identityColor(current.id) } as React.CSSProperties}>
              <div className="cockpit-worker-identity"><Face worker={current} size={44} /><div><span className="cockpit-eyebrow">WORKER / {current.kind}</span><h1 title={current.id}>{current.id}</h1><span className="cockpit-worker-marks"><StateChip state={current.state} /><MateBadge kind={current.kind} /><DirectControl worker={current} disabled={!!directBusy[current.key]} onChange={direct => void setDirect(current, direct)} /></span></div></div>
              <span key={`flash:${current.key}`} className="cockpit-switch-flash" aria-hidden="true" />
              <div className="cockpit-switch"><button aria-label="Previous worker" title="Previous worker (Ctrl+[)" onClick={() => cycle(-1)} disabled={workers.length < 2}>← <span>Previous</span></button><span>{activeIndex + 1} / {workers.length}</span><button aria-label="Next worker" title="Next worker (Ctrl+])" onClick={() => cycle(1)} disabled={workers.length < 2}><span>Next</span> →</button></div>
            </header>
            <div className="cockpit-worker-content">
              <div className="cockpit-status-detail"><StateChip state={current.state} /><MateBadge kind={current.kind} /><span className="cockpit-status-text" title={current.detail}>{current.detail}</span><small>{current.freshness} · observed {displayTime(current.observedAt)}</small></div>
              <section className="cockpit-objective"><span className="cockpit-eyebrow">OBJECTIVE</span><p>{current.objective}</p></section>
              <div className="cockpit-facts"><div><span>PROJECT</span><strong title={current.project}>{current.project}</strong></div><div><span>WORKTREE</span><strong title={current.worktree}>{current.worktree}</strong></div><div><span>BRANCH</span><strong title={current.branch}>{current.branch}</strong></div><div><span>PR</span>{current.prUrl ? <a href={current.prUrl} target="_blank" rel="noopener noreferrer">Open pull request ↗</a> : <strong>unknown</strong>}</div></div>
              <details key={current.key} className="cockpit-worker-message"><summary>Tell First Mate about this</summary><Composer anchorKey={current.key} kind="message" submit={submit} /></details>
            </div>
          </div>
        </aside>
      </> : overviewLocation.worker ? <>
        {fleet.errors.length > 0 && <div className="cockpit-error" role="alert">Fleet update delayed: {fleet.errors.join('; ')}</div>}
        {fleet.ready
          ? <header className="cockpit-main-header"><h1>No such worker</h1></header>
          : !fleet.errors.length && <p className="cockpit-empty">Loading workers…</p>}
      </> : null}

    </main>

  </div>
}
