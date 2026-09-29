import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, apiUrl } from './apiClient'
import { getAvatarDataUrl, subscribeAvatarCache } from './components/agentAvatarCache'
import { PALETTE_COLORS } from './components/ColorPalette'
import { QuotaRail } from './cockpit/QuotaRail'
import type { AttentionCard } from './server/fleet/attention'
import './cockpit.css'

interface Worker {
  key: string; id: string; home: string; kind: string; state: string; detail: string
  observedAt: string | null; freshness: string; objective: string; project: string
  worktree: string; branch: string; prUrl: string | null; terminalAvailable: boolean; terminalPid: number | null
}
interface FleetData { ready: boolean; workers: Worker[]; attention: AttentionCard[]; errors: string[] }
type Terminal = { state: 'live'; port: number; pid: number | null; cols: number; rows: number } | { state: 'unavailable'; reason: string }
interface OutboxMessage {
  requestId: string; taskId: string | null; decisionKey: string | null
  kind: 'answer' | 'message'; text: string
  state: 'unknown' | 'sending' | 'saved' | 'acknowledged' | 'done'
  announced: boolean | null; reply: string | null; canReceive: boolean | 'unknown'
}
type Draft = { requestId: string; anchorKey?: string; kind: 'answer' | 'message'; text: string }

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

const attentionLabels = { decision: 'Decision', blocked: 'Blocked', failure: 'Failure', review: 'Review Ready' } as const
const attentionIcons = { decision: 'help', blocked: 'front_hand', failure: 'error', review: 'rate_review' } as const

type SubmitResult = { saved: boolean; error: string | null; canReceive: boolean | 'unknown' }

function dismissNote(card: AttentionCard): string {
  const key = card.decisionKey ?? ''
  return card.taskId ? `Dismiss decision ${key} on task ${card.taskId}.` : `Dismiss decision ${key}.`
}

function sameDismiss(card: AttentionCard, message: OutboxMessage): boolean {
  return message.kind === 'message' && message.text === dismissNote(card) && message.taskId === card.taskId && message.decisionKey === card.decisionKey
}

function SlideToDismiss({ onConfirm }: { onConfirm: () => void }) {
  const track = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLSpanElement>(null)
  const pos = useRef(0)
  const dragging = useRef(false)
  const [x, setX] = useState(0)
  const [travel, setTravel] = useState(1)

  const limit = () => {
    const width = track.current?.clientWidth ?? 0
    const knobWidth = knob.current?.offsetWidth ?? 0
    return width > 0 ? Math.max(0, width - knobWidth - 4) : 0
  }
  const moveTo = (next: number) => {
    const max = limit()
    const clamped = Math.min(max, Math.max(0, next))
    pos.current = clamped
    setTravel(max || 1)
    setX(clamped)
    return { clamped, max }
  }
  const reset = () => { pos.current = 0; setX(0) }
  const release = () => {
    const { clamped, max } = { clamped: pos.current, max: limit() }
    if (max > 0 && clamped >= max - 4) onConfirm()
    else reset()
  }

  return <div
    className="cockpit-slide"
    ref={track}
    role="slider"
    tabIndex={0}
    aria-label="Slide to dismiss"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.min(100, Math.round((x / travel) * 100))}
    onKeyDown={event => {
      const max = limit()
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        event.preventDefault()
        const { clamped } = moveTo(pos.current + max / 6)
        if (max > 0 && clamped >= max - 4) onConfirm()
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'Home' || event.key === 'Escape') {
        event.preventDefault()
        reset()
      } else if (event.key === ' ' || event.key === 'Enter') event.preventDefault()
    }}
    onBlur={() => { if (!dragging.current) reset() }}
  >
    <span className="cockpit-slide-label">Slide to dismiss</span>
    <span
      ref={knob}
      className={`cockpit-slide-knob${dragging.current ? ' dragging' : ''}`}
      style={{ transform: `translateX(${x}px)` }}
      onPointerDown={event => {
        if (event.button !== 0) return
        dragging.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        event.preventDefault()
      }}
      onPointerMove={event => {
        if (!dragging.current || !track.current) return
        const rect = track.current.getBoundingClientRect()
        moveTo(event.clientX - rect.left - 2 - (knob.current?.offsetWidth ?? 0) / 2)
      }}
      onPointerUp={() => { if (!dragging.current) return; dragging.current = false; release() }}
      onPointerCancel={() => { dragging.current = false; reset() }}
    />
  </div>
}

function DismissControl({ card, held, error, onDismiss }: { card: AttentionCard; held: boolean; error: string | null; onDismiss: (card: AttentionCard) => void }) {
  if (card.type !== 'decision' || !card.decisionKey) return null
  if (held) return <p className="cockpit-dismissing" role="status">dismissing…</p>
  return <>
    <SlideToDismiss onConfirm={() => onDismiss(card)} />
    {error && <p className="cockpit-dismiss-error" role="alert">{error}</p>}
  </>
}

function AttentionCardView({ card, worker, open, submit, dismissing, dismissError, onDismiss }: {
  card: AttentionCard; worker: Worker | null; open: () => void; submit: (draft: Draft) => Promise<SubmitResult>
  dismissing: boolean; dismissError: string | null; onDismiss: (card: AttentionCard) => void
}) {
  const origin = worker ? <span className="cockpit-attention-origin"><Face worker={worker} size={25} /><span>{worker.id}</span></span>
    : <span className="cockpit-attention-origin cockpit-attention-origin-empty"><span className="material-symbols-outlined">account_tree</span>First Mate backlog</span>
  return <article className={`cockpit-attention-card cockpit-attention-${card.type}`}>
    <div className="cockpit-attention-type"><span className="material-symbols-outlined" aria-hidden="true">{attentionIcons[card.type]}</span><strong>{attentionLabels[card.type]}</strong></div>
    {card.type === 'review' ? <>
      <div className="cockpit-attention-review-ref"><span>{card.repository}</span><strong>#{card.prNumber}</strong></div>
      <p title={card.headline}>{card.headline}</p>
      <div className="cockpit-attention-review-meta"><span>CI {card.ci}</span>{card.reviewStatus === 'unknown' && <span>PR status unknown</span>}</div>
      <div className="cockpit-attention-bottom">{origin}<a className="cockpit-attention-action" href={card.prUrl!} target="_blank" rel="noopener noreferrer">Open GitHub ↗</a></div>
      <button className="cockpit-attention-message-link" onClick={open}>Tell First Mate about this</button>
    </> : <>
      <p title={card.headline}>{card.headline}</p>
      {card.type === 'decision' && <small className="cockpit-attention-age">Age {card.ageDays === null ? 'unknown' : `${card.ageDays}d`}</small>}
      {card.type === 'blocked' && card.detail && <small className="cockpit-attention-needed">NEEDED · {card.detail}</small>}
      {card.type === 'failure' && card.detail && <small className="cockpit-attention-failure-detail">{card.detail}</small>}
      <div className="cockpit-attention-bottom">{origin}<button className="cockpit-attention-action" onClick={open}>Open →</button></div>
      {card.type === 'decision' && <details className="cockpit-card-composer"><summary>Answer</summary><Composer anchorKey={card.key} kind="answer" submit={submit} /></details>}
      <DismissControl card={card} held={dismissing} error={dismissError} onDismiss={onDismiss} />
      <button className="cockpit-attention-message-link" onClick={open}>Tell First Mate about this</button>
    </>}
  </article>
}

function mintRequestId(): string {
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `tinstar-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function Composer({ anchorKey, kind, submit }: { anchorKey: string; kind: 'answer' | 'message'; submit: (draft: Draft) => Promise<SubmitResult> }) {
  const [text, setText] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const inFlight = useRef(false)
  const label = kind === 'answer' ? 'Answer this decision' : 'Tell First Mate about this'
  return <form className="cockpit-composer" onSubmit={event => {
    event.preventDefault()
    if (inFlight.current || !text.trim()) return
    const id = requestId ?? mintRequestId()
    inFlight.current = true; setBusy(true); setNotice(null)
    setRequestId(id)
    void submit({ requestId: id, anchorKey, kind, text: text.trim() }).then(result => {
      if (result.saved) { setText(''); setRequestId(null); setNotice(result.error ?? (result.canReceive === false ? 'Saved, not yet read. First Mate will read it when it wakes.' : 'Saved. First Mate will receive it at the next check.')) }
      else setNotice(result.error ?? 'Could not confirm the message was saved. Retry with the same request ID.')
    }).catch(error => setNotice((error as Error).message)).finally(() => { inFlight.current = false; setBusy(false) })
  }}>
    <label>{label}<textarea value={text} onChange={event => { setText(event.target.value); setRequestId(null) }} rows={3} maxLength={10000} placeholder={kind === 'answer' ? 'Write your answer…' : 'Write your message…'} /></label>
    <button type="submit" disabled={busy || !text.trim()}>{busy ? 'Sending…' : requestId ? 'Retry' : 'Send to First Mate'}</button>
    {notice && <p role="status">{notice}</p>}
  </form>
}

function MessageFeed({ messages, retry }: { messages: OutboxMessage[]; retry: (message: OutboxMessage) => void }) {
  if (!messages.length) return null
  return <div className="cockpit-messages">{messages.map(message => <article key={message.requestId}>
    <div className="cockpit-message-top"><strong>{message.kind === 'answer' ? 'Answer' : 'Message'} · {message.taskId ?? 'First Mate backlog'}</strong><span>{message.state === 'acknowledged' ? 'First Mate has it' : message.state === 'unknown' ? 'status unknown' : message.state}</span></div>
    <p>{message.text}</p>
    {message.state === 'saved' && message.canReceive === false && <small role="status">Saved, not yet read. First Mate will read it when it wakes.</small>}
    {(message.state === 'sending' || (message.state === 'saved' && message.announced === false)) && <button onClick={() => retry(message)}>{message.state === 'sending' ? 'Retry sending' : 'Retry waking First Mate'}</button>}
    {message.reply && <blockquote><strong>First Mate replied</strong><p>{message.reply}</p></blockquote>}
  </article>)}</div>
}

export default function App() {
  const [fleet, setFleet] = useState<FleetData>({ ready: false, workers: [], attention: [], errors: [] })
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedAttention, setSelectedAttention] = useState<string | null>(null)
  const [jumpText, setJumpText] = useState('')
  const [terminals, setTerminals] = useState<Record<string, Terminal>>({})
  const [opening, setOpening] = useState<Record<string, boolean>>({})
  const [messages, setMessages] = useState<OutboxMessage[]>([])
  const [messageError, setMessageError] = useState<string | null>(null)
  const focusTerminal = useRef(false)
  const messagesInFlight = useRef(false)
  const dismissIds = useRef<Record<string, string>>({})
  const dismissBusy = useRef(new Set<string>())
  const dismissSettled = useRef(new Set<string>())
  const [dismissingKeys, setDismissingKeys] = useState<Record<string, true>>({})
  const [dismissErrors, setDismissErrors] = useState<Record<string, string>>({})

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

  const dismiss = useCallback((card: AttentionCard) => {
    if (dismissBusy.current.has(card.key)) return
    const text = dismissNote(card)
    const existing = messages.find(message => sameDismiss(card, message) && !dismissSettled.current.has(message.requestId))
    const requestId = dismissIds.current[card.key] ?? existing?.requestId ?? mintRequestId()
    dismissIds.current[card.key] = requestId
    dismissBusy.current.add(card.key)
    setDismissErrors(previous => {
      if (!previous[card.key]) return previous
      const next = { ...previous }
      delete next[card.key]
      return next
    })
    setDismissingKeys(previous => ({ ...previous, [card.key]: true }))
    void submit({ requestId, anchorKey: card.key, kind: 'message', text }).then(result => {
      if (result.saved) return
      dismissBusy.current.delete(card.key)
      setDismissingKeys(previous => {
        const next = { ...previous }
        delete next[card.key]
        return next
      })
      setDismissErrors(previous => ({ ...previous, [card.key]: result.error ?? 'Could not confirm the message was saved. Retry with the same request ID.' }))
    }).catch(error => {
      dismissBusy.current.delete(card.key)
      setDismissingKeys(previous => {
        const next = { ...previous }
        delete next[card.key]
        return next
      })
      setDismissErrors(previous => ({ ...previous, [card.key]: (error as Error).message }))
    })
  }, [messages, submit])

  const dismissHeld = useCallback((card: AttentionCard) => {
    if (dismissErrors[card.key]) return false
    if (dismissingKeys[card.key]) return true
    return messages.some(message => sameDismiss(card, message) && message.state !== 'sending' && !dismissSettled.current.has(message.requestId))
  }, [dismissErrors, dismissingKeys, messages])

  useEffect(() => {
    void refresh()
    void refreshMessages()
    const timer = window.setInterval(() => { void refresh(); void refreshMessages() }, 5_000)
    return () => window.clearInterval(timer)
  }, [refresh, refreshMessages])

  const workers = fleet.workers
  const waiting = loading || !fleet.ready
  const attention = fleet.attention ?? []
  useEffect(() => {
    if (!fleet.ready || fleet.errors.length > 0) return
    const openKeys = new Set(attention.map(card => card.key))
    for (const message of messages) {
      if (!message.text.startsWith('Dismiss decision ')) continue
      if (!attention.some(card => sameDismiss(card, message))) dismissSettled.current.add(message.requestId)
    }
    for (const key of [...dismissBusy.current]) if (!openKeys.has(key)) dismissBusy.current.delete(key)
    for (const key of Object.keys(dismissIds.current)) if (!openKeys.has(key)) delete dismissIds.current[key]
    setDismissingKeys(previous => {
      const next = Object.fromEntries(Object.entries(previous).filter(([key]) => openKeys.has(key)))
      return Object.keys(next).length === Object.keys(previous).length ? previous : next
    })
    setDismissErrors(previous => {
      const next = Object.fromEntries(Object.entries(previous).filter(([key]) => openKeys.has(key)))
      return Object.keys(next).length === Object.keys(previous).length ? previous : next
    })
  }, [fleet.ready, attention, messages])
  const activeAttention = attention.find(card => card.key === selectedAttention) ?? null
  const current = workers.find(w => w.key === selected) ?? null
  const order = useMemo(() => workers.map(w => w.key), [workers])
  const cycle = useCallback((direction: number, fromTerminal = false) => {
    if (!order.length) return
    setSelectedAttention(null)
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

  const states = useMemo(() => {
    const groups = new Map<string, Worker[]>()
    for (const worker of workers) groups.set(worker.state, [...(groups.get(worker.state) ?? []), worker])
    return [...groups]
  }, [workers])
  const activeIndex = current ? order.indexOf(current.key) : -1

  return <div className="cockpit-shell">
    <aside className="cockpit-rail">
      <div className="cockpit-brand"><span className="cockpit-brand-mark">✦</span><div><strong>TIN STAR</strong><small>WORKER COCKPIT</small></div></div>
      <button className={`cockpit-overview-button ${!current ? 'active' : ''}`} onClick={() => { setSelected(null); setSelectedAttention(null) }}><span className="material-symbols-outlined">dashboard</span>Overview</button>
      <input className="cockpit-jump" aria-label="Jump to worker" placeholder="Jump to worker ↵" value={jumpText} onChange={e => setJumpText(e.target.value)} onKeyDown={e => {
        if (e.key !== 'Enter') return
        const match = workers.find(w => w.id.toLowerCase().includes(jumpText.trim().toLowerCase()))
        if (match && jumpText.trim()) { setSelected(match.key); setSelectedAttention(null); setJumpText('') }
      }} />
      <div className="cockpit-rail-heading cockpit-attention-heading"><span>NEEDS YOU</span><span>{attention.length}</span></div>
      <div className="cockpit-attention-list" aria-label="Needs You">
        {fleet.errors.length > 0 && <p className="cockpit-attention-empty" role="alert">Needs You unavailable — {fleet.errors.join('; ')}</p>}
        {attention.length ? attention.map(card => <AttentionCardView key={card.key} card={card} worker={workers.find(worker => worker.key === card.workerKey) ?? null} open={() => setSelectedAttention(card.key)} submit={submit} dismissing={dismissHeld(card)} dismissError={dismissErrors[card.key] ?? null} onDismiss={dismiss} />)
          : fleet.errors.length > 0 ? null : <p className="cockpit-attention-empty">{waiting ? 'Loading Needs You…' : 'Nothing needs you right now.'}</p>}
      </div>
      <div className="cockpit-rail-heading"><span>MESSAGES</span><span>{messages.length}</span></div>
      {messageError && <p className="cockpit-attention-empty" role="alert">{messageError}</p>}
      <div className="cockpit-rail-messages"><MessageFeed messages={messages} retry={retry} /></div>
      <div className="cockpit-rail-heading"><span>WORKERS</span><span>{workers.length}</span></div>
      <div className="cockpit-worker-list">
        {workers.map(worker => <button key={worker.key} className={`cockpit-worker-button ${selected === worker.key ? 'active' : ''}`} onClick={() => { setSelected(worker.key); setSelectedAttention(null) }} style={{ '--worker-color': identityColor(worker.id) } as React.CSSProperties}>
          <Face worker={worker} size={35} /><span className="cockpit-worker-label"><strong>{worker.id}</strong><small>{worker.project}</small></span><StateChip state={worker.state} />
        </button>)}
      </div>
      <QuotaRail />
      <div className="cockpit-rail-footer">CTRL + [ &nbsp; / &nbsp; CTRL + ]<span>Switch workers</span></div>
    </aside>
    <main className={`cockpit-main ${current ? 'cockpit-main-worker' : ''}`}>
      {!current ? <>
        <header className="cockpit-main-header"><span className="cockpit-eyebrow">FLEET / OVERVIEW</span><h1>Workers</h1><p>Live work across your First Mate homes</p></header>
        {fleet.errors.length > 0 && <div className="cockpit-error" role="alert">Fleet update delayed: {fleet.errors.join('; ')}</div>}
        {waiting && !fleet.errors.length ? <p className="cockpit-empty">Loading workers…</p> : workers.length === 0 ? <p className="cockpit-empty">{fleet.errors.length ? 'Waiting for the fleet service to reconnect…' : 'No workers found. Configure a First Mate home to see its fleet.'}</p> : <div className="cockpit-groups">
          {states.map(([state, entries]) => <section key={state} className="cockpit-group"><div className="cockpit-group-heading"><StateChip state={state} /><span>{entries.length} {entries.length === 1 ? 'worker' : 'workers'}</span></div><div className="cockpit-card-grid">
            {entries.map(worker => <button key={worker.key} className="cockpit-card" onClick={() => setSelected(worker.key)} style={{ '--worker-color': identityColor(worker.id) } as React.CSSProperties}><div className="cockpit-card-top"><Face worker={worker} size={46} /><div><strong>{worker.id}</strong><span>{worker.project}</span></div><span className="material-symbols-outlined">arrow_forward</span></div><p>{worker.objective}</p><small>{worker.detail}</small></button>)}
          </div></section>)}
        </div>}
      </> : <>
        <header className="cockpit-worker-header" style={{ '--worker-color': identityColor(current.id) } as React.CSSProperties}>
          <div className="cockpit-worker-identity"><Face worker={current} size={68} /><div><span className="cockpit-eyebrow">WORKER / {current.kind}</span><h1 title={current.id}>{current.id}</h1><StateChip state={current.state} /></div></div>
          <span key={`flash:${current.key}`} className="cockpit-switch-flash" aria-hidden="true" />
          <div className="cockpit-switch"><button aria-label="Previous worker" title="Previous worker (Ctrl+[)" onClick={() => cycle(-1)} disabled={workers.length < 2}>← <span>Previous</span></button><span>{activeIndex + 1} / {workers.length}</span><button aria-label="Next worker" title="Next worker (Ctrl+])" onClick={() => cycle(1)} disabled={workers.length < 2}><span>Next</span> →</button></div>
        </header>
        <div className="cockpit-worker-content"><section className="cockpit-objective"><span className="cockpit-eyebrow">OBJECTIVE</span><p>{current.objective}</p></section>
          <details key={current.key} className="cockpit-worker-message"><summary>Tell First Mate about this</summary><Composer anchorKey={current.key} kind="message" submit={submit} /></details>
          <div className="cockpit-facts"><div><span>PROJECT</span><strong title={current.project}>{current.project}</strong></div><div><span>WORKTREE</span><strong title={current.worktree}>{current.worktree}</strong></div><div><span>BRANCH</span><strong title={current.branch}>{current.branch}</strong></div><div><span>PR</span>{current.prUrl ? <a href={current.prUrl} target="_blank" rel="noopener noreferrer">Open pull request ↗</a> : <strong>unknown</strong>}</div></div>
          <div className="cockpit-status-detail"><StateChip state={current.state} /><span title={current.detail}>{current.detail}</span><small>{current.freshness} · observed {displayTime(current.observedAt)}</small></div>
          <section className="cockpit-terminal"><div className="cockpit-terminal-heading"><span><span className="material-symbols-outlined">terminal</span> LIVE TERMINAL</span><small>Direct terminal input</small></div><div className="cockpit-terminal-stage">
            {workers.flatMap(worker => {
              const terminal = terminals[worker.key]
              if (terminal?.state !== 'live') return []
              const active = current.key === worker.key
              return [<iframe key={`${worker.key}:${terminal.port}:${terminal.pid}`} ref={frame => { if (frame) frame.inert = !active }} className="cockpit-terminal-frame" data-session={worker.key} src={apiUrl(`/terminal-wrapper.html?session=${encodeURIComponent(worker.key)}&cols=${terminal.cols}&rows=${terminal.rows}`)} title={`${worker.id} terminal`} style={{ opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none', zIndex: active ? 1 : 0 }} />]
            })}
            {opening[current.key] && !terminals[current.key] && <p className="cockpit-terminal-placeholder">Connecting to terminal…</p>}
            {!current.terminalAvailable && <p className="cockpit-terminal-placeholder">Terminal endpoint unavailable</p>}
            {terminals[current.key]?.state === 'unavailable' && <p className="cockpit-terminal-placeholder">{(terminals[current.key] as Extract<Terminal, { state: 'unavailable' }>).reason}</p>}
          </div></section>
        </div>
      </>}
    </main>
    {activeAttention && <div className="cockpit-attention-scrim" onClick={() => setSelectedAttention(null)}>
      <section className={`cockpit-attention-detail cockpit-attention-${activeAttention.type}`} role="dialog" aria-modal="true" aria-label={attentionLabels[activeAttention.type]} onClick={event => event.stopPropagation()}>
        <div className="cockpit-attention-detail-top"><span className="material-symbols-outlined">{attentionIcons[activeAttention.type]}</span><strong>{attentionLabels[activeAttention.type]}</strong><button aria-label="Close details" onClick={() => setSelectedAttention(null)}>×</button></div>
        <h2>{activeAttention.headline}</h2>{activeAttention.detail && <p>{activeAttention.detail}</p>}
        <div className="cockpit-attention-detail-facts"><span>Origin</span><strong>{activeAttention.workerId ?? 'First Mate backlog'}</strong><span>Age</span><strong>{activeAttention.ageDays === null ? 'unknown' : `${activeAttention.ageDays} days`}</strong></div>
        <DismissControl card={activeAttention} held={dismissHeld(activeAttention)} error={dismissErrors[activeAttention.key] ?? null} onDismiss={dismiss} />
        <Composer key={`${activeAttention.key}:message`} anchorKey={activeAttention.key} kind="message" submit={submit} />
        {activeAttention.workerKey && <button className="cockpit-attention-view-worker" onClick={() => { setSelected(activeAttention.workerKey); setSelectedAttention(null) }}>View worker →</button>}
      </section>
    </div>}
  </div>
}
