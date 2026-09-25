import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { apiFetch } from '../../apiClient'
import './motion.css'
import { getAvatarDataUrl, subscribeAvatarCache } from '../../components/agentAvatarCache'
import type { WorkerDescriptor } from '../contract/descriptor'
import {
  ContextThread,
  NeedsYouRail,
  PortfolioBoard,
  QuotaRail,
  ShellSelection,
  WorkerObjective,
} from './slots'
import { displayName, hashPaletteColor } from './identity'
import {
  adoptWorkers,
  cycleSelection,
  goBack,
  initialNav,
  jumpBoard,
  selectWorker,
  type ShellNav,
} from './navigation'

interface IdentityRecord {
  color: string
  alias?: string
}

interface IntentUi {
  workerId: string
  requestId: string
  disposition: string
  detail: string
  reply: string | null
  appliedOutcome: 'applied' | 'rejected' | null
}

function Slot({ component: Component }: { component: ComponentType | null }) {
  if (!Component) return null
  return <Component />
}

function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setReduce(media.matches)
    apply()
    media.addEventListener?.('change', apply)
    return () => media.removeEventListener?.('change', apply)
  }, [])
  return reduce
}

function isHiddenTerminal(element: HTMLElement): boolean {
  return element.tagName === 'IFRAME'
    && (element.dataset.testid ?? '').startsWith('terminal-')
    && (element as HTMLIFrameElement).style.visibility === 'hidden'
}

/** Put focus on the visible terminal, the open control, or the view heading. */
function restoreShellFocus(shell: HTMLElement) {
  const frames = [...shell.querySelectorAll<HTMLIFrameElement>('[data-testid^="terminal-"]')]
  const visible = frames.find(frame => frame.style.visibility !== 'hidden')
  if (visible) {
    visible.focus()
    return
  }
  const opener = shell.querySelector<HTMLElement>('[data-testid="open-terminal"]')
  if (opener) {
    opener.focus()
    return
  }
  shell.querySelector<HTMLElement>('[data-focus-landing]')?.focus()
}

function Face({ id, color }: { id: string; color: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const read = () => setUrl(getAvatarDataUrl(id, color))
    read()
    return subscribeAvatarCache(read)
  }, [id, color])
  if (!url) {
    return <span aria-hidden className="inline-block h-7 w-7 rounded-full border-2" style={{ borderColor: color }} />
  }
  return <img src={url} alt="" width={28} height={28} className="h-7 w-7 rounded-full" />
}

function statusLabel(intent: IntentUi): string {
  if (intent.appliedOutcome === 'applied') return 'Applied'
  if (intent.appliedOutcome === 'rejected') return 'Rejected'
  if (intent.disposition === 'saved-unannounced') return 'Saved, not announced'
  if (intent.disposition === 'not-receivable') return 'Not receivable'
  if (intent.disposition === 'failed') return intent.detail || 'Failed'
  return 'Queued'
}

export function V6Shell({ pollMs = 4000 }: { pollMs?: number }) {
  const [nav, setNav] = useState<ShellNav>(initialNav)
  const [workers, setWorkers] = useState<WorkerDescriptor[]>([])
  const [identities, setIdentities] = useState<Record<string, IdentityRecord>>({})
  const [configured, setConfigured] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [opened, setOpened] = useState<string[]>([])
  const [concealed, setConcealed] = useState<string[]>([])
  const [terminalNote, setTerminalNote] = useState<string | null>(null)
  const [intent, setIntent] = useState<IntentUi | null>(null)
  const [switchCount, setSwitchCount] = useState(0)
  const reduce = useReducedMotion()
  const postedColors = useRef(new Set<string>())
  const shellRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const lastFocusRef = useRef<HTMLElement | null>(null)
  const switchSeq = useRef(0)
  const noteRef = useRef<string | null>(null)
  const dismissing = useRef(false)

  function markSwitch() {
    switchSeq.current += 1
    shellRef.current?.setAttribute('data-switch-seq', String(switchSeq.current))
    setSwitchCount(switchSeq.current)
  }

  function focusOpener() {
    const back = openerRef.current
    openerRef.current = null
    if (back && back.isConnected && back !== document.body) {
      back.focus()
      return
    }
    if (shellRef.current) restoreShellFocus(shellRef.current)
  }

  function dismissTerminal() {
    if (dismissing.current) return
    dismissing.current = true
    const dialog = dialogRef.current
    if (dialog && typeof dialog.close === 'function' && dialog.open) dialog.close()
    setTerminalNote(null)
    focusOpener()
    queueMicrotask(() => { dismissing.current = false })
  }

  useEffect(() => {
    let stop = false
    async function load() {
      try {
        const res = await apiFetch('/api/v6/workers')
        if (!res.ok || stop) return
        const body = await res.json() as {
          ok?: boolean
          data?: {
            configured?: boolean
            workers?: WorkerDescriptor[]
            identities?: Record<string, IdentityRecord>
          }
        }
        if (stop || !body.ok || !body.data) return
        const next = body.data.workers ?? []
        setWorkers(next)
        setIdentities(body.data.identities ?? {})
        setConfigured(body.data.configured !== false)
        setNav(current => adoptWorkers(current, next.map(worker => worker.id)))
      } catch {
        if (!stop) setConfigured(false)
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, pollMs)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [pollMs])

  useEffect(() => {
    for (const worker of workers) {
      if (identities[worker.id]?.color || postedColors.current.has(worker.id)) continue
      postedColors.current.add(worker.id)
      const color = hashPaletteColor(worker.id)
      void apiFetch('/api/v6/identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: worker.id, color }),
      })
    }
  }, [workers, identities])

  useEffect(() => {
    const ids = () => workers.map(worker => worker.id)
    function onKey(event: KeyboardEvent) {
      if (event.altKey || event.shiftKey) return
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.code !== 'BracketLeft' && event.code !== 'BracketRight') return
      event.preventDefault()
      markSwitch()
      const dir = event.code === 'BracketRight' ? 1 : -1
      setNav(current => cycleSelection(current, ids(), dir))
    }
    function onMessage(event: MessageEvent) {
      const data = event.data as { type?: string; direction?: string } | null
      if (!data || data.type !== 'v6-worker-cycle') return
      if (data.direction !== 'next' && data.direction !== 'prev') return
      markSwitch()
      setNav(current => cycleSelection(current, ids(), data.direction === 'next' ? 1 : -1))
    }
    function onFocusIn(event: FocusEvent) {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (!shellRef.current?.contains(target)) return
      if (target.closest('[data-testid="v6-terminal-dialog"]')) return
      lastFocusRef.current = target
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('message', onMessage)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('message', onMessage)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [workers])

  useEffect(() => {
    if (!intent || intent.reply || intent.disposition === 'failed') return
    let stop = false
    const timer = setInterval(() => {
      void apiFetch(`/api/v6/intents/${encodeURIComponent(intent.requestId)}`).then(async res => {
        if (!res.ok || stop) return
        const body = await res.json() as { data?: { reply?: { body?: string; appliedOutcome?: 'applied' | 'rejected' | null } | null } }
        const reply = body.data?.reply
        if (!reply || typeof reply.body !== 'string') return
        setIntent(current => current && current.requestId === intent.requestId
          ? {
              ...current,
              reply: reply.body ?? null,
              appliedOutcome: reply.appliedOutcome ?? null,
            }
          : current)
      }).catch(() => undefined)
    }, Math.min(pollMs, 1500))
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [intent, pollMs])

  const selected = workers.find(worker => worker.id === nav.selectedWorkerId) ?? null
  const view = nav.history.current
  noteRef.current = terminalNote
  const stageKey = `${view.kind}:${view.kind === 'portfolio' ? '' : view.id}:${selected?.id ?? ''}`
  const presence = `${opened.join(',')}|${concealed.join(',')}`

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    // Paint-only. setNav already committed, so the next switch does not wait on animationend.
    stage.classList.remove('v6-arrive')
    if (reduce) return
    void stage.getBoundingClientRect()
    stage.classList.add('v6-arrive')
  }, [stageKey, reduce])

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell || shell.querySelector('[data-testid="v6-terminal-dialog"]')) return
    const previous = lastFocusRef.current
    if (!previous) return
    const lost = !previous.isConnected
    const hidden = previous.isConnected && isHiddenTerminal(previous)
    if (!lost && !hidden) return
    restoreShellFocus(shell)
  }, [stageKey, presence, terminalNote])

  useEffect(() => {
    if (!noteRef.current) return
    const back = openerRef.current
    openerRef.current = null
    setTerminalNote(null)
    if (back && back.isConnected && back !== document.body) back.focus()
  }, [stageKey])

  useEffect(() => {
    if (!terminalNote) return
    const dialog = dialogRef.current
    if (!dialog) return
    const active = document.activeElement
    if (active instanceof HTMLElement && !dialog.contains(active)) openerRef.current = active
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.open = true
      dialog.querySelector<HTMLElement>('[data-dialog-initial]')?.focus()
    }
    return () => {
      dismissing.current = true
      if (typeof dialog.close === 'function' && dialog.open) dialog.close()
      queueMicrotask(() => { dismissing.current = false })
    }
  }, [terminalNote])

  async function openTerminal(worker: WorkerDescriptor) {
    setTerminalNote(null)
    try {
      const res = await apiFetch(`/api/v6/workers/${encodeURIComponent(worker.id)}/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spawnGen: worker.spawnGen, target: worker.endpoint.target }),
      })
      const body = await res.json() as { data?: { state?: string; reason?: string } }
      if (body.data?.state === 'live') {
        setOpened(current => current.includes(worker.id) ? current : [...current, worker.id])
        setConcealed(current => current.filter(id => id !== worker.id))
        return
      }
      setTerminalNote(body.data?.reason ?? 'terminal unavailable')
    } catch {
      setTerminalNote('terminal unavailable')
    }
  }

  async function closeTerminal(workerId: string) {
    setOpened(current => current.filter(id => id !== workerId))
    setConcealed(current => current.filter(id => id !== workerId))
    try {
      await apiFetch(`/api/v6/workers/${encodeURIComponent(workerId)}/terminal`, { method: 'DELETE' })
    } catch {
      /* the view process is stopped server-side when the request lands */
    }
  }

  async function send() {
    if (!selected) return
    const text = drafts[selected.id] ?? ''
    if (!text.trim()) return
    const requestId = crypto.randomUUID()
    setIntent({
      workerId: selected.id,
      requestId,
      disposition: 'queued',
      detail: 'Queued',
      reply: null,
      appliedOutcome: null,
    })
    try {
      const res = await apiFetch('/api/v6/intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema: 'tinstar.v6.intent/1',
          kind: 'thread.message',
          requestId,
          revision: null,
          anchor: { type: 'worker', ids: [selected.id] },
          body: { text },
        }),
      })
      const body = await res.json() as { data?: { disposition?: string; detail?: string } }
      const disposition = body.data?.disposition ?? 'failed'
      setIntent({
        workerId: selected.id,
        requestId,
        disposition,
        detail: body.data?.detail ?? disposition,
        reply: null,
        appliedOutcome: null,
      })
      if (disposition !== 'failed') setDrafts(current => ({ ...current, [selected.id]: '' }))
    } catch {
      setIntent({
        workerId: selected.id,
        requestId,
        disposition: 'failed',
        detail: 'the message was not saved',
        reply: null,
        appliedOutcome: null,
      })
    }
  }

  const motion = reduce ? '' : 'transition-colors duration-150'

  return (
    <ShellSelection value={{ workerId: selected?.id ?? null, view }}>
    <div
      ref={shellRef}
      data-testid="v6-shell"
      data-view={view.kind}
      data-worker={selected?.id ?? ''}
      data-reduced={reduce ? 'true' : 'false'}
      data-switch-seq={switchCount}
      className="v6-shell flex h-full min-h-screen flex-col bg-surface-base text-slate-100"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <strong className="mr-2 text-sm tracking-wide">Tin Star</strong>
        <button type="button" data-testid="board" className="rounded border border-white/15 px-2 py-1 text-xs" onClick={() => { markSwitch(); setNav(current => jumpBoard(current)) }}>Board</button>
        <button type="button" data-testid="back" className="rounded border border-white/15 px-2 py-1 text-xs disabled:opacity-40" disabled={nav.history.past.length === 0} onClick={() => { markSwitch(); setNav(current => goBack(current)) }}>Back</button>
        <button type="button" data-testid="worker-prev" className="rounded border border-white/15 px-2 py-1 text-xs" onClick={() => { markSwitch(); setNav(current => cycleSelection(current, workers.map(worker => worker.id), -1)) }}>Previous worker</button>
        <button type="button" data-testid="worker-next" className="rounded border border-white/15 px-2 py-1 text-xs" onClick={() => { markSwitch(); setNav(current => cycleSelection(current, workers.map(worker => worker.id), 1)) }}>Next worker</button>
        <Slot component={QuotaRail} />
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[16rem_1fr]">
        <aside className="border-r border-white/10 p-2">
          <Slot component={NeedsYouRail} />
          {!configured && <p className="px-2 py-3 text-sm text-slate-300">First Mate home is not configured.</p>}
          <ul className="space-y-1">
            {workers.map(worker => {
              const color = identities[worker.id]?.color ?? hashPaletteColor(worker.id)
              const name = displayName(worker.id, identities[worker.id]?.alias)
              const active = worker.id === selected?.id
              return (
                <li key={worker.id}>
                  <button
                    type="button"
                    data-testid={`worker-${worker.id}`}
                    data-color={color}
                    aria-pressed={active}
                    className={`v6-worker-row flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-sm ${motion}`}
                    style={{ borderColor: color, background: active ? 'rgba(255,255,255,0.04)' : 'transparent' }}
                    onClick={() => { markSwitch(); setNav(current => selectWorker(current, worker.id)) }}
                  >
                    <Face id={worker.id} color={color} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{name}</span>
                      <span className="block truncate text-xs text-slate-400">{worker.project || 'no project'}</span>
                    </span>
                    <span data-testid={`crew-${worker.id}`} className="rounded border border-white/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">{worker.crewState}</span>
                    {worker.fixture && <span data-testid="fixture-label" className="text-[10px] uppercase text-amber-300">fixture</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </aside>
        <main ref={stageRef} data-testid="v6-stage" className="v6-stage flex min-h-0 flex-col">
          {view.kind === 'portfolio' && (
            <section className="p-4">
              <h1 tabIndex={-1} data-focus-landing="" className="mb-2 text-lg">Portfolio</h1>
              {PortfolioBoard ? <PortfolioBoard /> : <p>No epics yet.</p>}
            </section>
          )}
          {view.kind === 'worker' && selected && (
            <section className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2">
                <Face id={selected.id} color={identities[selected.id]?.color ?? hashPaletteColor(selected.id)} />
                <div>
                  <h1 tabIndex={-1} data-focus-landing="" className="text-base">{displayName(selected.id, identities[selected.id]?.alias)}</h1>
                  <p className="text-xs text-slate-400">{selected.worktree.path ?? 'worktree unavailable'} · {selected.project || 'no project'}</p>
                </div>
                <span className="rounded border border-white/15 px-1.5 py-0.5 text-[10px] uppercase">{selected.crewState}</span>
                {selected.fixture && <span className="text-[10px] uppercase text-amber-300">fixture</span>}
              </div>
              <Slot component={WorkerObjective} />
              <div className="relative min-h-[12rem] flex-1 bg-black">
                {opened.map(id => (
                  <iframe
                    key={id}
                    data-testid={`terminal-${id}`}
                    title={`Terminal ${id}`}
                    src={`/v6-terminal-wrapper.html?worker=${encodeURIComponent(id)}`}
                    className="absolute inset-0 h-full w-full border-0"
                    style={{ visibility: id === selected.id && !concealed.includes(id) ? 'visible' : 'hidden' }}
                  />
                ))}
                {!opened.includes(selected.id) && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <button type="button" data-testid="open-terminal" className="rounded border border-cyan-400/40 px-3 py-1.5 text-sm text-cyan-200" onClick={() => { void openTerminal(selected) }}>Open terminal</button>
                  </div>
                )}
                {opened.includes(selected.id) && (
                  <div className="absolute right-2 top-2 z-10 flex gap-2">
                    <button type="button" className="rounded bg-black/70 px-2 py-1 text-xs" onClick={() => setConcealed(current => current.includes(selected.id) ? current.filter(id => id !== selected.id) : [...current, selected.id])}>Hide terminal</button>
                    <button type="button" className="rounded bg-black/70 px-2 py-1 text-xs" onClick={() => { void closeTerminal(selected.id) }}>Close view</button>
                  </div>
                )}

              </div>
              <form
                className="border-t border-white/10 bg-surface-base p-3"
                onSubmit={event => {
                  event.preventDefault()
                  void send()
                }}
              >
                <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400" htmlFor="v6-message">Message this worker</label>
                <textarea
                  id="v6-message"
                  aria-label="Message"
                  className="h-20 w-full resize-none rounded border border-white/15 bg-black/40 p-2 text-sm"
                  value={drafts[selected.id] ?? ''}
                  onChange={event => {
                    const value = event.target.value
                    setDrafts(current => ({ ...current, [selected.id]: value }))
                  }}
                />
                <button type="submit" className="mt-2 rounded bg-cyan-400/20 px-3 py-1 text-sm text-cyan-100">Send</button>
                {intent && intent.workerId === selected.id && (
                  <div data-testid="intent-status" className="mt-2 text-sm">
                    <p>{statusLabel(intent)}</p>
                    {intent.appliedOutcome === null && <p>Not applied</p>}
                    {intent.reply && <p data-testid="intent-reply">{intent.reply}</p>}
                  </div>
                )}
              </form>
              <Slot component={ContextThread} />
            </section>
          )}
          {view.kind !== 'portfolio' && view.kind !== 'worker' && (
            <section className="p-4">
              <p tabIndex={-1} data-focus-landing="" className="text-sm text-slate-300">{view.kind} {view.id}</p>
            </section>
          )}
        </main>
      </div>
      {terminalNote && (
        <dialog
          ref={dialogRef}
          data-testid="v6-terminal-dialog"
          aria-modal="true"
          aria-labelledby="v6-terminal-dialog-title"
          className="v6-dialog"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              dismissTerminal()
              return
            }
            if (event.key !== 'Tab') return
            const dialog = dialogRef.current
            if (!dialog) return
            const items = [...dialog.querySelectorAll<HTMLElement>('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')]
              .filter(item => !item.hasAttribute('disabled'))
            const first = items[0]
            const last = items[items.length - 1]
            if (!first || !last) return
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first.focus()
            }
          }}
          onCancel={event => {
            event.preventDefault()
            dismissTerminal()
          }}
          onClose={dismissTerminal}
        >
          <h2 id="v6-terminal-dialog-title" className="mb-2 text-base">Terminal unavailable</h2>
          <p data-testid="terminal-note" className="text-sm text-amber-200">{terminalNote}</p>
          <button type="button" data-dialog-initial className="mt-3 rounded border border-white/20 px-3 py-1 text-sm" onClick={dismissTerminal}>Close</button>
        </dialog>
      )}
    </div>
    </ShellSelection>
  )
}
