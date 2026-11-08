import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../apiClient'
import { askItemsSchema, askReturn, isArtifactTarget, type AskItem, type AskReturn } from '../shared/ask'
import type { FloorScene, PresentationAction, PresentationState } from '../shared/reconciliationPresentation'
import { ageLabel } from '../reconciliation/recordFields'
import { useAskGesture } from './useAskGesture'
import { fieldDrafts, type AskSeed, type AskSubject } from './semantic'
import type { AskField } from '../shared/ask'
import { workerTitle, cardTitle } from '../reconciliation/overviewModel'
import { findOriginElement } from './useOriginFocus'
import './ask.css'

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/ask/${path}`, { headers: { 'X-Tinstar-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.error?.message ?? 'Ask unavailable')
  return result.data as T
}
interface AskControls {
  items: AskItem[]; error: string | null; open: (subject?: AskSeed, parent?: AskItem) => void
  returnTo: (item: AskItem) => void; action: (item: AskItem, action: 'retry' | 'dismiss') => void
}
const Controls = createContext<AskControls | null>(null)
export const useAskControls = () => useContext(Controls)
export function useCardAsk(cardId: string | null) {
  const controls = useContext(Controls)
  return useAskGesture(controls && cardId ? () => controls.open({ cardId }) : undefined)
}
export function useSemanticAsk(subject: AskSubject) {
  const controls = useContext(Controls)
  return (event: MouseEvent | KeyboardEvent, field_key?: AskField, field_value?: string) => {
    if (!controls || (event.target instanceof Element && event.target.closest('a, input, textarea, select'))) return
    event.preventDefault(); event.stopPropagation()
    controls.open({ ...subject, field_key, field_value: field_value?.slice(0, 4000) })
  }
}
export function AskCardAction({ cardId, subject, icon = false }: { cardId?: string; subject?: AskSubject; icon?: boolean }) {
  const controls = useContext(Controls)
  const label = cardId || subject ? 'Ask about this item' : 'Ask First Mate'
  return controls && <button type="button" className={icon ? 'ov-header-icon' : 'ask-launch'} aria-label={icon ? label : undefined} title={label} onClick={event => { event.stopPropagation(); controls.open(subject ?? { cardId }) }}>
    {icon ? <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 3h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8l-5 3v-3a2 2 0 0 1-2-2V5a2 2 0 0 1 3-2Z" /></svg> : 'Ask First Mate about this task'}
  </button>
}
export function AskProvider({ scene, state, send, onReturn, children }: { scene: FloorScene | null; state: PresentationState; send: (action: PresentationAction) => void; onReturn: (origin: AskReturn) => void; children: ReactNode }) {
  const [items, setItems] = useState<AskItem[]>([]), [error, setError] = useState<string | null>(null)
  const [composer, setComposer] = useState<{ seed: AskSeed; parent?: AskItem; key: string } | null>(null)
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
  const open = (seed: AskSeed = {}, parent?: AskItem) => { if (!scene && !isArtifactTarget(seed.target)) { setError('Source context is unavailable. Try again when sources connect.'); return } setAnswer(null); setComposer({ seed, parent, key: crypto.randomUUID() }) }
  const action = (item: AskItem, value: 'retry' | 'dismiss') => {
    void request(`requests/${item.request_id}/${value}`, {}).then(refresh).catch(reason => setError((reason as Error).message))
  }
  const returnTo = (item: AskItem) => {
    setAnswer(item)
    onReturn(askReturn(item.context))
    if (item.context.target?.kind === 'execution' || item.context.target?.kind === 'claim') {
      send({ type: 'reveal-search', target: item.context.target })
      send({ type: 'flash', targets: [item.context.target] })
    } else if (!isArtifactTarget(item.context.target) && scene?.cards.some(card => card.id === item.context.anchor.page_id)) send({ type: 'navigate-card', cardId: item.context.anchor.page_id })
    if (item.reply && !item.read_at) void request(`requests/${item.request_id}/read`, {}).then(refresh).catch(reason => setError((reason as Error).message))
  }
  const currentAnswer = answer && (items.find(item => item.request_id === answer.request_id) ?? answer)
  return <Controls.Provider value={{ items, error, open, returnTo, action }}>{children}
    {composer && createPortal(<AskComposer key={composer.key} scene={scene} state={state} seed={composer.seed} parent={composer.parent} clientKey={composer.key} close={() => setComposer(null)} submit={async body => {
      const item = await request<AskItem>('requests', body)
      localRevision.current++
      setItems(previous => [item, ...previous.filter(old => old.request_id !== item.request_id)])
      setComposer(null)
    }} />, document.body)}
    {currentAnswer && createPortal(<AskAnswer item={currentAnswer} available={isArtifactTarget(currentAnswer.context.target) ? true : currentAnswer.context.target?.kind === 'execution' ? !!scene?.executions.some(worker => worker.id === currentAnswer.context.target!.id) : currentAnswer.context.target?.kind === 'claim' ? !!scene?.claims.some(claim => claim.id === currentAnswer.context.target!.id && scene.cards.some(card => card.id === claim.cardId && !card.source.in_trash && !card.source.archived)) : !!scene?.cards.some(card => card.id === currentAnswer.context.anchor.page_id && !card.source.in_trash && !card.source.archived)} close={() => setAnswer(null)} followUp={() => open(currentAnswer.context.target ? { target: currentAnswer.context.target, view: currentAnswer.context.view, label: currentAnswer.context.anchor.label } : { cardId: currentAnswer.context.anchor.page_id }, currentAnswer)} />, document.body)}
  </Controls.Provider>
}
export function AskRelationshipHit({ claimId, d }: { claimId: string; d: string }) {
  const ask = useSemanticAsk({ target: { kind: 'claim', id: claimId } })
  return <path className="ov-relationship-hit" data-claim-id={claimId} d={d} role="button" tabIndex={0} aria-label="Ask about this relationship" onContextMenu={event => ask(event, 'relationship', claimId)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') ask(event, 'relationship', claimId) }} />
}
function useDialogFocus(returnCardId?: string, origin?: AskReturn) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    dialog?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    return () => {
      dialog?.close()
      const card = returnCardId ? [...document.querySelectorAll<HTMLElement>('.ov-item')].find(element => element.dataset.entityId === returnCardId) : null
      const destination = (origin ? findOriginElement(document, origin.target) : null) ?? card ?? previous
      if (destination?.isConnected) destination.focus({ preventScroll: true })
    }
  }, [])
  return ref
}
function AskComposer({ scene, state, seed, parent, clientKey, submit, close }: { scene: FloorScene | null; state: PresentationState; seed: AskSeed; parent?: AskItem; clientKey: string; submit: (body: unknown) => Promise<void>; close: () => void }) {
  const [chosen, setChosen] = useState(seed.cardId ?? ''), [question, setQuestion] = useState(seed.field_key ? fieldDrafts[seed.field_key] : ''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const ref = useDialogFocus(), locked = useRef(false)
  const card = scene?.cards.find(card => card.id === chosen)
  const worker = seed.target?.kind === 'execution' ? scene?.executions.find(worker => worker.id === seed.target!.id) : null
  const claim = seed.target?.kind === 'claim' ? scene?.claims.find(claim => claim.id === seed.target!.id) : null
  const linkedCard = claim && scene?.cards.find(card => card.id === claim.cardId)
  const label = parent?.context.anchor.label ?? seed.label ?? (isArtifactTarget(seed.target) ? seed.target.id : worker ? workerTitle(worker) : linkedCard ? `Relationship · ${cardTitle(linkedCard)}` : card ? cardTitle(card) : chosen)
  const bound = !!seed.target || !!chosen
  // Keep the retry envelope unchanged after an uncertain response; editing begins
  // a fresh idempotency key so a lost response cannot bind two different texts.
  const key = useRef(clientKey), attempted = useRef(false)
  return <dialog ref={ref} className="ask-dialog" aria-labelledby="ask-title" onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <form onSubmit={event => {
      event.preventDefault()
      if (locked.current || !bound || !question.trim()) return
      locked.current = true; setBusy(true); setError(null); attempted.current = true
      void submit({ client_key: key.current, ...(seed.target ? { target: seed.target } : { card_id: chosen }), ...(seed.field_key && (seed.target || chosen === seed.cardId) ? { field_key: seed.field_key, field_value: seed.field_value } : {}), question: question.trim(), view: parent?.context.view ?? seed.view ?? { scene: 'overview', organizer: state.organizer, statusFilter: state.statusFilter }, ...(parent ? { follow_up_to: parent.request_id } : {}) })
        .catch(reason => setError((reason as Error).message)).finally(() => { locked.current = false; setBusy(false) })
    }}>
      <header><h2 id="ask-title">Ask First Mate</h2><button type="button" disabled={busy} onClick={close} aria-label="Close question">×</button></header>
      <p>Swipe left on an item to ask. Review your question, then send.</p>
      {bound ? <div className="ask-chip"><span>{seed.target && isArtifactTarget(seed.target) && <small>{seed.target.kind === 'pull' ? 'GitHub PR' : seed.target.kind === 'release' ? 'Deployment target' : 'Deployment receipt'} · </small>}{label}</span>{!parent && !seed.target && <button type="button" disabled={busy} aria-label="Remove task context" onClick={() => { setChosen(''); if (attempted.current) key.current = crypto.randomUUID() }}>×</button>}</div> : <label>Task context<select aria-label="Task context" value={chosen} required onChange={event => { setChosen(event.target.value); if (attempted.current) key.current = crypto.randomUUID() }}><option value="">Choose a task</option>{scene?.cards.map(card => <option key={card.id} value={card.id}>{String(card.source.properties.Name?.value ?? card.id)}</option>)}</select></label>}
      <label>Question<textarea autoFocus required maxLength={4000} value={question} disabled={busy} onChange={event => { setQuestion(event.target.value); if (attempted.current) key.current = crypto.randomUUID() }} placeholder="What would you like to know?" enterKeyHint="send" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} /></label>
      {error && <p role="alert">{error} Retry keeps the same question ID.</p>}
      <footer><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" disabled={busy || !bound || !question.trim()}>{busy ? 'Sending…' : 'Send question'}</button></footer>
    </form>
  </dialog>
}
function AskAnswer({ item, available, close, followUp }: { item: AskItem; available: boolean; close: () => void; followUp: () => void }) {
  const ref = useDialogFocus(item.context.anchor.page_id, askReturn(item.context))
  const [expanded, setExpanded] = useState(false)
  return <dialog ref={ref} data-expanded={expanded} className="ask-dialog ask-answer" aria-labelledby="ask-answer-title" onCancel={event => { event.preventDefault(); close() }}>
    <header><h2 id="ask-answer-title">{item.context.anchor.label}</h2><button type="button" aria-label="Close answer" onClick={close}>×</button></header>
    {!available && <p role="status">The original task is no longer on the floor. {item.context.anchor.url && <a href={item.context.anchor.url} target="_blank" rel="noreferrer">Open the source task</a>}</p>}
    {isArtifactTarget(item.context.target) && item.context.anchor.url && <a href={item.context.anchor.url} target="_blank" rel="noreferrer">Open originating source</a>}
    <p className="ask-answer-question" title={item.question}>{item.question}</p>{item.reply ? <><h3 className="ask-answer-summary" title={item.reply.summary}>{item.reply.summary}</h3><details onToggle={event => setExpanded(event.currentTarget.open)}><summary>Full answer &amp; evidence</summary><p className="ask-detail">{item.reply.detail}</p>{item.reply.references.map((reference, index) => <a key={index} href={reference.url} target="_blank" rel="noreferrer">{reference.label}</a>)}{item.reply.suggested_actions.length > 0 && <><h4>Suggested next actions</h4><ul>{item.reply.suggested_actions.map((action, index) => <li key={index}>{action}</li>)}</ul><p>Suggestions require their existing approvals before execution.</p></>}</details></> : <p>{item.error ?? 'Waiting for First Mate’s answer.'}</p>}
    <footer><button type="button" onClick={close}>Back to task</button><button type="button" onClick={followUp}>Follow up</button></footer>
  </dialog>
}
export function AskDesk({ now }: { now: number }) {
  const controls = useContext(Controls)
  const [history, setHistory] = useState(false), [search, setSearch] = useState('')
  if (!controls) return null
  const rank = (item: AskItem) => item.reply && !item.read_at ? 0 : item.status === 'sent' || item.status === 'delivered' ? 1 : item.status === 'failed' ? 2 : 3
  const visible = controls.items.filter(item => !!item.dismissed_at === history && (!history || !search || `${item.question} ${item.context.anchor.label} ${item.reply?.detail ?? ''}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at))
  return <section className="ask-desk" aria-label="Questions for First Mate">
    {controls.error && <p role="status">{controls.error}. Questions will refresh automatically.</p>}
    {!visible.length && <p>{history ? 'No matching questions in history.' : 'Your questions and First Mate’s answers appear here.'}</p>}
    {visible.map(item => <article key={item.request_id} data-ask-id={item.request_id} data-unread={!!item.reply && !item.read_at}><button type="button" className="ask-preview" onClick={() => controls.returnTo(item)}>
      <small>{item.reply && !item.read_at ? 'New answer' : ({ sent: 'Sent', delivered: 'Delivered', answered: 'Answered', failed: 'Failed' }[item.status])} · {ageLabel(Date.parse(item.updated_at), now)}</small>
      <strong>{item.question}</strong><span>{item.context.anchor.label}</span>{item.reply && <p>{item.reply.summary}</p>}<span className="ask-open">{item.reply ? 'Open answer →' : 'Open question →'}</span>
    </button>{item.error && <p role="status">{item.error}</p>}{!item.reply && Date.parse(item.created_at) < now - 120_000 && <p>Delivery or an answer is taking longer. First Mate may be offline.</p>}
      {!item.reply && <button type="button" onClick={() => controls.action(item, 'retry')}>Retry delivery</button>}{!item.dismissed_at && <details className="ask-item-actions"><summary aria-label="Question actions">Actions</summary><button type="button" onClick={() => controls.action(item, 'dismiss')}>Dismiss to history</button></details>}
    </article>)}
    <button type="button" className="ask-history" aria-pressed={history} onClick={() => setHistory(!history)}>{history ? 'Back to questions' : 'Question history'}</button>
    {history && <input aria-label="Search question history" type="search" value={search} onChange={event => setSearch(event.target.value)} />}
  </section>
}
