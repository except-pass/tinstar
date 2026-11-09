import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useId, type MouseEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../apiClient'
import { askItemSchema, askItemsSchema, askReturn, isArtifactTarget, type AskItem, type AskReturn, type AskSelectionInput } from '../shared/ask'
import type { FloorScene, PresentationAction, PresentationState } from '../shared/reconciliationPresentation'
import { ageLabel } from '../reconciliation/recordFields'
import { useAskGesture } from './useAskGesture'
import { askElement } from './element'
import { AskSurface } from './AskSurface'
import { AskActions, AskSelectionRejected } from './AskActions'
import { fieldDrafts, type AskSeed, type AskSubject } from './semantic'
import type { AskField } from '../shared/ask'
import { workerTitle, cardTitle } from '../reconciliation/overviewModel'
import './ask.css'

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/ask/${path}`, { headers: { 'X-Tinstar-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok || !result.ok) {
    const message = result.error?.message ?? 'Ask unavailable'
    if (path === 'selections' && response.status >= 400 && response.status < 500) throw new AskSelectionRejected(message)
    throw new Error(message)
  }
  return result.data as T
}
interface AskControls {
  scene: FloorScene | null; expanded: string | null; collapse: () => void; state: PresentationState; submit: (body: unknown) => Promise<void>; canBack?: boolean; onBack?: () => void
  replySeed: { conversationId: string; seed: AskSeed; key: string } | null;
  selectAction: (input: AskSelectionInput) => Promise<AskItem>
  items: AskItem[]; error: string | null; open: (subject?: AskSeed, parent?: AskItem) => void
  returnTo: (item: AskItem) => void; action: (item: AskItem, action: 'retry' | 'dismiss') => void
}
const Controls = createContext<AskControls | null>(null)
export const useAskControls = () => useContext(Controls)
export function useCardAsk(seed: AskSeed | null, inspect?: () => void) {
  const controls = useContext(Controls)
  return useAskGesture(controls && seed ? () => controls.open(seed) : undefined, false, inspect)
}
export function useSemanticAsk(subject: AskSubject) {
  const controls = useContext(Controls)
  return (event: MouseEvent | KeyboardEvent, field_key?: AskField, field_value?: string) => {
    if (!controls || (event.target instanceof Element && (event.target.closest('input, textarea, select') || event.target.closest('a') && !event.target.closest('a[data-ask-field]')))) return
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
export function AskProvider({ scene, state, onReturn, canBack, onBack, children }: { canBack?: boolean; onBack?: () => void; scene: FloorScene | null; state: PresentationState; send: (action: PresentationAction) => void; onReturn: (origin: AskReturn) => void; children: ReactNode }) {
  const [items, setItems] = useState<AskItem[]>([]), [error, setError] = useState<string | null>(null)
  const [composer, setComposer] = useState<{ seed: AskSeed; parent?: AskItem; key: string } | null>(null)
  const [replySeed, setReplySeed] = useState<AskControls['replySeed']>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
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
  const open = (seed: AskSeed = {}, parent?: AskItem) => {
    parent ??= items.find(item => item.request_id === seed.followUpTo)
    if (parent) {
      setExpanded(parent.conversation_id)
      setReplySeed({ conversationId: parent.conversation_id, seed, key: crypto.randomUUID() })
      return
    }
    if (!scene && !isArtifactTarget(seed.target)) { setError('Source context is unavailable. Try again when sources connect.'); return }
    setComposer({ seed, key: crypto.randomUUID() })
  }
  const action = (item: AskItem, value: 'retry' | 'dismiss') => {
    void request(`requests/${item.request_id}/${value}`, {}).then(refresh).catch(reason => setError((reason as Error).message))
  }
  const returnTo = (item: AskItem) => {
    setExpanded(item.conversation_id)
    onReturn(askReturn(item.context))
    const unread = items.filter(turn => turn.conversation_id === item.conversation_id && turn.reply && !turn.read_at)
    if (unread.length) void Promise.all(unread.map(turn => request(`requests/${turn.request_id}/read`, {}))).then(refresh).catch(reason => setError((reason as Error).message))
  }
  const retain = (item: AskItem) => {
    localRevision.current++
    setItems(previous => previous.some(old => old.request_id === item.request_id) ? previous.map(old => old.request_id === item.request_id ? item : old) : [...previous, item])
    setExpanded(item.conversation_id)
  }
  const submit = async (body: unknown) => {
    const item = await request<AskItem>('requests', body)
    retain(item)
    setReplySeed(previous => previous && previous.key === replySeed?.key && previous.conversationId === item.conversation_id ? { ...previous, seed: {} } : previous)
  }
  const selectAction = async (input: AskSelectionInput) => {
    try {
      const item = askItemSchema.parse(await request<AskItem>('selections', input))
      retain(item)
      return item
    } catch (reason) {
      // Reconcile other-device selections or superseding replies using the same
      // refresh path; an uncertain retry still uses its original request key.
      void refresh()
      throw reason
    }
  }
  return <Controls.Provider value={{ scene, state, submit, selectAction, replySeed, expanded, collapse: () => setExpanded(null), canBack, onBack, items, error, open, returnTo, action }}>{children}
    {composer && createPortal(<AskComposer key={composer.key} scene={scene} state={state} seed={composer.seed} parent={composer.parent} clientKey={composer.key} close={() => setComposer(null)} submit={async body => {
      await submit(body)
      setComposer(null)
    }} />, document.body)}

  </Controls.Provider>
}
export function AskRelationshipHit({ claimId, d, onInspect }: { claimId: string; d: string; onInspect?: () => void }) {
  const controls = useAskControls()
  const ask = useSemanticAsk({ target: { kind: 'claim', id: claimId } })
  const gesture = useAskGesture<SVGPathElement>(controls ? () => controls.open({ target: { kind: 'claim', id: claimId }, field_key: 'relationship', field_value: claimId }) : undefined, false, onInspect)
  return <><path ref={gesture.ref} className="ov-relationship-hit" data-claim-id={claimId} d={d} role="button" tabIndex={0} aria-label="Ask about this relationship" onContextMenu={event => ask(event, 'relationship', claimId)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') ask(event, 'relationship', claimId) }} />{gesture.overlay}</>
}
function useDialogFocus(enabled: boolean) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    if (!enabled) return
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    dialog?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    return () => {
      dialog?.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [enabled])
  return ref
}
/** The same text form serves every contextual entry and the inline thread.
 * Future voice capture can supply editable text through this component's draft. */
function AskComposer({ scene, state, seed, parent, clientKey, submit, close, inline = false }: { scene: FloorScene | null; state: PresentationState; seed: AskSeed; parent?: AskItem; clientKey: string; submit: (body: unknown) => Promise<void>; close: () => void; inline?: boolean }) {
  const [chosen, setChosen] = useState(seed.cardId ?? ''), [question, setQuestion] = useState(seed.question ?? (seed.target?.kind === 'pull' && seed.target.action_receipt_id ? 'What does this action receipt establish?' : seed.field_key ? fieldDrafts[seed.field_key] : '')), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const ref = useDialogFocus(!inline), locked = useRef(false), titleId = useId()
  const card = scene?.cards.find(card => card.id === chosen)
  const worker = seed.target?.kind === 'execution' ? scene?.executions.find(worker => worker.id === seed.target!.id) : null
  const claim = seed.target?.kind === 'claim' ? scene?.claims.find(claim => claim.id === seed.target!.id) : null
  const linkedCard = claim && scene?.cards.find(card => card.id === claim.cardId)
  const label = parent?.context.anchor.label ?? seed.label ?? (isArtifactTarget(seed.target) ? seed.target.id : worker ? workerTitle(worker) : linkedCard ? `Relationship · ${cardTitle(linkedCard)}` : card ? cardTitle(card) : chosen)
  const bound = !!parent || !!seed.target || !!chosen
  const element = (seed.target || chosen === seed.cardId) ? seed.element : undefined
  // Freeze the whole uncertain envelope, including its exact parent. A refresh
  // may discover another turn before a lost acknowledgment is retried.
  const key = useRef(inline ? crypto.randomUUID() : clientKey), retryBody = useRef<unknown>(null)
  const edited = () => { if (retryBody.current) { key.current = crypto.randomUUID(); retryBody.current = null } }
  const form = <form className="ask-composer" aria-label={inline ? 'Reply to First Mate' : 'New question'} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!busy) close() }
  }} onSubmit={event => {
    event.preventDefault()
    if (locked.current || !bound || !question.trim()) return
    locked.current = true; setBusy(true); setError(null)
    retryBody.current ??= { client_key: key.current, ...(seed.target ? { target: seed.target } : { card_id: chosen }), ...((seed.element || seed.field_key) && (seed.target || chosen === seed.cardId) ? { element: seed.element, field_key: seed.field_key, field_value: seed.field_value } : {}), question: question.trim(), view: parent?.context.view ?? seed.view ?? { scene: 'overview', organizer: state.organizer, statusFilter: state.statusFilter }, ...(parent ? { follow_up_to: parent.request_id } : {}) }
    void submit(retryBody.current).then(() => {
      if (inline) { setQuestion(''); retryBody.current = null; key.current = crypto.randomUUID() }
    }).catch(reason => setError((reason as Error).message)).finally(() => { locked.current = false; setBusy(false) })
  }}>
    {!inline && <><header><h2 id={titleId}>Ask First Mate</h2><button type="button" disabled={busy} onClick={close} aria-label="Close question">×</button></header>
      <p>{seed.element ? 'Ask about this element. Send the suggested question or edit it.' : 'Swipe left on an item to ask; right-click or long-press a field to ask about it.'}</p>
      {bound ? <div className="ask-chip"><span>{seed.target && isArtifactTarget(seed.target) && <small>{seed.target.kind === 'pull' ? 'GitHub PR' : seed.target.kind === 'release' ? 'Deployment target' : 'Deployment receipt'} · </small>}{label}</span>{!parent && !seed.target && <button type="button" disabled={busy} aria-label="Remove task context" onClick={() => { setChosen(''); edited() }}>×</button>}</div> : <label>Task context<select aria-label="Task context" value={chosen} required onChange={event => { setChosen(event.target.value); edited() }}><option value="">Choose a task</option>{scene?.cards.map(card => <option key={card.id} value={card.id}>{String(card.source.properties.Name?.value ?? card.id)}</option>)}</select></label>}
      </>}
    {element && <div className="ask-element-context" aria-label="Element context"><small>{element.label}</small><p>{element.value}</p></div>}
    <label>{inline ? 'Reply to First Mate' : 'Question'}<textarea autoFocus={!inline || !!seed.question} required maxLength={4000} value={question} aria-busy={busy} readOnly={busy} onChange={event => { setQuestion(event.target.value); edited() }} placeholder={inline ? 'Ask a follow-up in this conversation…' : 'What would you like to know?'} enterKeyHint="send" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} /></label>
    {error && <p role="alert">{error} Retry keeps the same question ID.</p>}
    <footer>{!inline && <button type="button" disabled={busy} onClick={close}>Cancel</button>}<button type="submit" disabled={busy || !bound || !question.trim()}>{busy ? 'Sending…' : inline ? 'Send reply' : 'Send question'}</button></footer>
  </form>
  return inline ? form : <dialog ref={ref} className="ask-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) close() }}>{form}</dialog>
}
function sourceAvailable(item: AskItem, scene: FloorScene | null) {
  const target = item.context.target
  if (isArtifactTarget(target)) return true // The authorized section resolves current artifact availability.
  if (target?.kind === 'execution') return !!scene?.executions.some(worker => worker.id === target.id)
  if (target?.kind === 'claim') return !!scene?.claims.some(claim => claim.id === target.id && scene.cards.some(card => card.id === claim.cardId && !card.source.in_trash && !card.source.archived))
  return !!scene?.cards.some(card => card.id === item.context.anchor.page_id && !card.source.in_trash && !card.source.archived)
}
function AskDelivery({ item, controls, now }: { item: AskItem; controls: AskControls; now: number }) {
  return <div>
    <p role="status">{item.status === 'failed' ? 'Failed' : item.status === 'delivered' ? 'Delivered' : 'Sent'} · {item.error ?? 'Waiting for First Mate’s answer.'}</p>
    {Date.parse(item.created_at) < now - 120_000 && <p>Delivery or an answer is taking longer. First Mate may be offline.</p>}
    <button type="button" aria-label={`Retry delivery: ${item.question}`} onClick={() => controls.action(item, 'retry')}>Retry delivery</button>
  </div>
}
function AskThread({ turns, controls, now }: { turns: AskItem[]; controls: AskControls; now: number }) {
  const latest = turns.at(-1)!
  const latestAnswer = turns.filter(turn => turn.reply).sort((a, b) => Date.parse(a.answered_at ?? a.created_at) - Date.parse(b.answered_at ?? b.created_at)).at(-1)
  const seed = controls.replySeed?.conversationId === latest.conversation_id ? controls.replySeed : null
  return <section className="ask-thread" id={`ask-thread-${latest.conversation_id}`} aria-label={`Answer thread: ${turns[0]!.question}`}>
    <header><strong>Conversation</strong><button type="button" onClick={event => { controls.collapse(); event.currentTarget.closest('[data-ask-id]')?.querySelector<HTMLElement>('.ask-preview')?.focus({ preventScroll: true }) }}>Collapse answer</button></header>
    {!sourceAvailable(latest, controls.scene) && <p role="status">The original task is no longer on the floor.</p>}
    {latest.context.anchor.url && <a href={latest.context.anchor.url} target="_blank" rel="noreferrer">Open originating source ↗</a>}
    {turns.map(turn => {
      const selected = turns.find(item => item.action_selection?.answer_id === turn.request_id)
      return <section className="ask-turn" key={turn.request_id} aria-label={`Question: ${turn.question}`}>
      {turn.action_selection && <p className="ask-action-explanation">Selected by {turn.action_selection.actor} · <time dateTime={turn.action_selection.selected_at}>{new Date(turn.action_selection.selected_at).toLocaleString()}</time></p>}
      <p className="ask-thread-question">{turn.question}</p>
      {turn.captured_selection && <blockquote>{turn.captured_selection.element?.value ?? turn.captured_selection.field_value}</blockquote>}
      {turn.reply ? <><h3 {...askElement('answer', 'First Mate answer')}>{turn.reply.summary}</h3><p {...askElement('answer', 'Answer detail')} className="ask-detail">{turn.reply.detail}</p>
        {turn.reply.references.map((reference, index) => <a key={index} href={reference.url} target="_blank" rel="noreferrer">{reference.label} ↗</a>)}
        <AskActions answerId={turn.request_id} suggestions={turn.reply.suggested_actions} superseded={latestAnswer?.request_id !== turn.request_id}
          selection={selected ? { action_id: selected.action_selection!.action_id, status: selected.status, error: selected.error } : null} onSelect={controls.selectAction} />
      </> : <AskDelivery item={turn} controls={controls} now={now} />}
    </section>})}
    <footer><button type="button" onClick={() => controls.returnTo(latest)}>Return to source</button>{controls.canBack && <button type="button" onClick={controls.onBack}>Back to previous view</button>}</footer>
    <AskComposer key={seed?.key ?? latest.conversation_id} inline scene={controls.scene} state={controls.state} parent={latest}
      seed={{ ...(latest.context.target ? { target: latest.context.target, view: latest.context.view } : { cardId: latest.context.anchor.page_id }), ...seed?.seed }}
      clientKey={latest.conversation_id} submit={controls.submit} close={() => {
        const thread = document.getElementById(`ask-thread-${latest.conversation_id}`)
        thread?.querySelector<HTMLButtonElement>('header button')?.focus()
      }} />
  </section>
}
export function AskDesk({ now }: { now: number }) {
  const controls = useContext(Controls)
  const [history, setHistory] = useState(false), [search, setSearch] = useState('')
  if (!controls) return null
  const rank = (item: AskItem) => item.reply && !item.read_at ? 0 : item.status === 'sent' || item.status === 'delivered' ? 1 : item.status === 'failed' ? 2 : 3
  const visible = controls.items.filter(item => !!item.dismissed_at === history && (!history || !search || `${item.question} ${item.context.anchor.label} ${item.reply?.detail ?? ''}`.toLowerCase().includes(search.toLowerCase())))
  const conversations = new Map<string, AskItem[]>()
  for (const item of visible) conversations.set(item.conversation_id, [...conversations.get(item.conversation_id) ?? [], item])
  const groups = [...conversations.values()].map(turns => turns.sort((a,b) => a.created_at.localeCompare(b.created_at))).sort((a,b) => Math.min(...a.map(rank)) - Math.min(...b.map(rank)) || b.at(-1)!.created_at.localeCompare(a.at(-1)!.created_at))
  return <section className="ask-desk" aria-label="Questions for First Mate">
    {controls.error && <p role="status">{controls.error}. Questions will refresh automatically.</p>}
    {!groups.length && <p>{history ? 'No matching questions in history.' : 'Your questions and First Mate’s answers appear here.'}</p>}
    {groups.map(group => {
      const item = group.at(-1)!, expanded = controls.expanded === item.conversation_id, unread = group.some(turn => turn.reply && !turn.read_at)
      const turns = controls.items.filter(turn => turn.conversation_id === item.conversation_id).sort((a,b) => a.created_at.localeCompare(b.created_at))
      const failed = turns.filter(turn => !turn.reply && turn.status === 'failed').length
      const pending = turns.filter(turn => !turn.reply && turn.status !== 'failed').length
      return <AskSurface as="article" subject={item.context.target ? { followUpTo: item.request_id, target: item.context.target, label: item.context.anchor.label, view: item.context.view } : { followUpTo: item.request_id, cardId: item.context.anchor.page_id, view: item.context.view }} key={item.conversation_id} data-ask-id={item.request_id} data-unread={unread} data-expanded={expanded}>
        <button type="button" className="ask-preview" aria-expanded={expanded} aria-controls={`ask-thread-${item.conversation_id}`} onClick={() => controls.returnTo(item)}>
          <small {...askElement('status', 'Question delivery')}>{unread ? 'New answer' : ({ sent: 'Sent', delivered: 'Delivered', answered: 'Answered', failed: 'Failed' }[item.status])}{failed > 0 && ` · ${failed} failed`}{pending > 0 && ` · ${pending} pending`} · {ageLabel(Date.parse(item.updated_at), now)}</small>
          <strong {...askElement('question', 'Question')}>{turns[0]!.question}</strong><span {...askElement('title', 'Originating item')}>{item.context.anchor.label}</span>{!expanded && item.reply && <p {...askElement('answer', 'First Mate answer')}>{item.reply.summary}</p>}<span className="ask-open">{expanded ? 'Conversation open' : item.reply ? 'Open answer →' : 'Open question →'}</span>
        </button>
        {expanded && <AskThread turns={turns} controls={controls} now={now} />}
        {!expanded && turns.filter(turn => !turn.reply).map(turn => <AskDelivery key={turn.request_id} item={turn} controls={controls} now={now} />)}
        {!item.dismissed_at && <details className="ask-item-actions"><summary aria-label="Question actions">Actions</summary><button type="button" onClick={() => { for (const turn of group) controls.action(turn, 'dismiss') }}>Dismiss to history</button></details>}
      </AskSurface>
    })}
    <button type="button" className="ask-history" aria-pressed={history} onClick={() => setHistory(!history)}>{history ? 'Back to questions' : 'Question history'}</button>
    {history && <input aria-label="Search question history" type="search" value={search} onChange={event => setSearch(event.target.value)} />}
  </section>
}
