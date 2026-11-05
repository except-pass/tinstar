import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../apiClient'
import { askItemsSchema, type AskItem } from '../shared/ask'
import type { FloorScene, PresentationAction, PresentationState } from '../shared/reconciliationPresentation'
import { ageLabel } from '../reconciliation/recordFields'
import { useAskGesture } from './useAskGesture'
import './ask.css'

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/ask/${path}`, { headers: { 'X-Tinstar-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.error?.message ?? 'Ask unavailable')
  return result.data as T
}
interface AskControls {
  items: AskItem[]; error: string | null; open: (cardId?: string, parent?: AskItem) => void
  returnTo: (item: AskItem) => void; action: (item: AskItem, action: 'retry' | 'dismiss') => void
}
const Controls = createContext<AskControls | null>(null)
export function useCardAsk(cardId: string | null) {
  const controls = useContext(Controls)
  return useAskGesture(controls && cardId ? () => controls.open(cardId) : undefined)
}
export function AskLauncher() {
  const controls = useContext(Controls)
  return controls && <button type="button" className="ask-launch" onClick={() => controls.open()}>Ask about a task</button>
}
export function AskCardAction({ cardId }: { cardId: string }) {
  const controls = useContext(Controls)
  return controls && <button type="button" className="ask-launch" onClick={() => controls.open(cardId)}>Ask First Mate about this task</button>
}
export function AskProvider({ scene, state, send, children }: { scene: FloorScene; state: PresentationState; send: (action: PresentationAction) => void; children: ReactNode }) {
  const [items, setItems] = useState<AskItem[]>([]), [error, setError] = useState<string | null>(null)
  const [composer, setComposer] = useState<{ cardId: string; parent?: AskItem; key: string } | null>(null)
  const [answer, setAnswer] = useState<AskItem | null>(null)
  const localRevision = useRef(0), refreshRevision = useRef(0)
  const refresh = useCallback(async () => {
    const before = localRevision.current, revision = ++refreshRevision.current
    try {
      const parsed = askItemsSchema.safeParse(await request<AskItem[]>('requests'))
      if (!parsed.success) throw new Error('Questions could not be read')
      const items = parsed.data
      if (before === localRevision.current && revision === refreshRevision.current) { setItems(items); setError(null) }
    }
    catch (reason) { if (revision === refreshRevision.current) setError((reason as Error).message) }
  }, [])
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh() }, 5000); return () => { clearInterval(timer); refreshRevision.current++ } }, [refresh])
  const open = (cardId?: string, parent?: AskItem) => { setAnswer(null); setComposer({ cardId: cardId ?? (state.selection?.kind === 'card' ? state.selection.id : ''), parent, key: crypto.randomUUID() }) }
  const action = (item: AskItem, value: 'retry' | 'dismiss') => {
    void request(`requests/${item.request_id}/${value}`, {}).then(refresh).catch(reason => setError((reason as Error).message))
  }
  const returnTo = (item: AskItem) => {
    setAnswer(item)
    if (scene.cards.some(card => card.id === item.context.anchor.page_id)) send({ type: 'navigate-card', cardId: item.context.anchor.page_id })
    if (item.reply && !item.read_at) void request(`requests/${item.request_id}/read`, {}).then(refresh).catch(reason => setError((reason as Error).message))
  }
  const currentAnswer = answer && (items.find(item => item.request_id === answer.request_id) ?? answer)
  return <Controls.Provider value={{ items, error, open, returnTo, action }}>{children}
    {composer && createPortal(<AskComposer key={composer.key} scene={scene} state={state} cardId={composer.cardId} parent={composer.parent} clientKey={composer.key} close={() => setComposer(null)} submit={async body => {
      const item = await request<AskItem>('requests', body)
      localRevision.current++
      setItems(previous => [item, ...previous.filter(old => old.request_id !== item.request_id)])
      setComposer(null)
    }} />, document.body)}
    {currentAnswer && createPortal(<AskAnswer item={currentAnswer} available={scene.cards.some(card => card.id === currentAnswer.context.anchor.page_id)} close={() => setAnswer(null)} followUp={() => open(currentAnswer.context.anchor.page_id, currentAnswer)} />, document.body)}
  </Controls.Provider>
}
function useDialogFocus(returnCardId?: string) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    dialog?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    return () => {
      dialog?.close()
      const card = returnCardId ? document.querySelector<HTMLElement>(`.ov-card[data-entity-id="${returnCardId}"]`) : null
      const destination = card ?? previous
      if (destination?.isConnected) destination.focus({ preventScroll: true })
    }
  }, [])
  return ref
}
function AskComposer({ scene, state, cardId, parent, clientKey, submit, close }: { scene: FloorScene; state: PresentationState; cardId: string; parent?: AskItem; clientKey: string; submit: (body: unknown) => Promise<void>; close: () => void }) {
  const [chosen, setChosen] = useState(cardId), [question, setQuestion] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const ref = useDialogFocus(), locked = useRef(false)
  const card = scene.cards.find(card => card.id === chosen)
  const label = parent?.context.anchor.label ?? (typeof card?.source.properties.Name?.value === 'string' ? card.source.properties.Name.value : chosen)
  // Keep the retry envelope unchanged after an uncertain response; editing begins
  // a fresh idempotency key so a lost response cannot bind two different texts.
  const key = useRef(clientKey), attempted = useRef(false)
  return <dialog ref={ref} className="ask-dialog" aria-labelledby="ask-title" onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <form onSubmit={event => {
      event.preventDefault()
      if (locked.current || !chosen || !question.trim()) return
      locked.current = true; setBusy(true); setError(null); attempted.current = true
      void submit({ client_key: key.current, card_id: chosen, question: question.trim(), view: { scene: 'overview', organizer: state.organizer, statusFilter: state.statusFilter }, ...(parent ? { follow_up_to: parent.request_id } : {}) })
        .catch(reason => setError((reason as Error).message)).finally(() => { locked.current = false; setBusy(false) })
    }}>
      <header><h2 id="ask-title">Ask First Mate</h2><button type="button" disabled={busy} onClick={close} aria-label="Close question">×</button></header>
      <p>Swipe left on a task to ask. Review your question, then send.</p>
      {chosen ? <div className="ask-chip"><span>{label}</span>{!parent && <button type="button" disabled={busy} aria-label="Remove task context" onClick={() => { setChosen(''); if (attempted.current) key.current = crypto.randomUUID() }}>×</button>}</div> : <label>Task context<select aria-label="Task context" value={chosen} required onChange={event => { setChosen(event.target.value); if (attempted.current) key.current = crypto.randomUUID() }}><option value="">Choose a task</option>{scene.cards.map(card => <option key={card.id} value={card.id}>{String(card.source.properties.Name?.value ?? card.id)}</option>)}</select></label>}
      <label>Question<textarea autoFocus required maxLength={4000} value={question} disabled={busy} onChange={event => { setQuestion(event.target.value); if (attempted.current) key.current = crypto.randomUUID() }} placeholder="What would you like to know?" enterKeyHint="enter" /></label>
      {error && <p role="alert">{error} Retry keeps the same question ID.</p>}
      <footer><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" disabled={busy || !chosen || !question.trim()}>{busy ? 'Sending…' : 'Send question'}</button></footer>
    </form>
  </dialog>
}
function AskAnswer({ item, available, close, followUp }: { item: AskItem; available: boolean; close: () => void; followUp: () => void }) {
  const ref = useDialogFocus(item.context.anchor.page_id)
  return <dialog ref={ref} className="ask-dialog ask-answer" aria-labelledby="ask-answer-title" onCancel={event => { event.preventDefault(); close() }}>
    <header><h2 id="ask-answer-title">{item.context.anchor.label}</h2><button type="button" aria-label="Close answer" onClick={close}>×</button></header>
    {!available && <p role="status">The original task is no longer on the floor. <a href={item.context.anchor.url} target="_blank" rel="noreferrer">Open the source task</a></p>}
    <p>{item.question}</p>{item.reply ? <><h3>{item.reply.summary}</h3><p className="ask-detail">{item.reply.detail}</p>{item.reply.references.map((reference, index) => <a key={index} href={reference.url} target="_blank" rel="noreferrer">{reference.label}</a>)}{item.reply.suggested_actions.length > 0 && <><h4>Suggested next actions</h4><ul>{item.reply.suggested_actions.map((action, index) => <li key={index}>{action}</li>)}</ul><p>Suggestions require their existing approvals before execution.</p></>}</> : <p>{item.error ?? 'Waiting for First Mate’s answer.'}</p>}
    <footer><button type="button" onClick={close}>Back to task</button><button type="button" onClick={followUp}>Follow up</button></footer>
  </dialog>
}
export function AskDesk({ now }: { now: number }) {
  const controls = useContext(Controls)
  const [history, setHistory] = useState(false), [search, setSearch] = useState('')
  if (!controls) return null
  const rank = (item: AskItem) => item.reply && !item.read_at ? 0 : item.status === 'sent' || item.status === 'delivered' ? 1 : item.status === 'failed' ? 2 : 3
  const visible = controls.items.filter(item => !!item.dismissed_at === history && (!search || `${item.question} ${item.context.anchor.label} ${item.reply?.detail ?? ''}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at))
  return <section className="ask-desk" aria-label="Questions for First Mate"><header><h3>Questions</h3><button type="button" onClick={() => controls.open()}>Ask about a task</button></header>
    {controls.error && <p role="status">{controls.error}. Questions will refresh automatically.</p>}
    <button type="button" aria-pressed={history} onClick={() => setHistory(!history)}>{history ? 'Back to questions' : 'Question history'}</button>
    {history && <input aria-label="Search question history" type="search" value={search} onChange={event => setSearch(event.target.value)} />}
    {!visible.length && <p>{history ? 'No matching questions in history.' : 'Your questions and First Mate’s answers appear here.'}</p>}
    {visible.map(item => <article key={item.request_id} data-ask-id={item.request_id}><button type="button" className="ask-preview" onClick={() => controls.returnTo(item)}>
      <small>{item.reply && !item.read_at ? 'New answer' : ({ sent: 'Sent', delivered: 'Delivered', answered: 'Answered', failed: 'Failed' }[item.status])} · {ageLabel(Date.parse(item.updated_at), now)}</small>
      <strong>{item.question}</strong><span>{item.context.anchor.label}</span>{item.reply && <p>{item.reply.summary}</p>}
    </button>{item.error && <p role="status">{item.error}</p>}{!item.reply && Date.parse(item.created_at) < now - 120_000 && <p>Delivery or an answer is taking longer. First Mate may be offline.</p>}
      {!item.reply && <button type="button" onClick={() => controls.action(item, 'retry')}>Retry delivery</button>}{!item.dismissed_at && <button type="button" onClick={() => controls.action(item, 'dismiss')}>Dismiss to history</button>}
    </article>)}
  </section>
}
