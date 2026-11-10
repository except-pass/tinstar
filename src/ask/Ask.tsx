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
import { answerStatus, deliveryFailed, deskConversations, mostRecentAnswer, type DeskView } from './deskInbox'
import { VoiceInput } from './VoiceInput'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { conversationTitle } from './deskInbox'
import type { QueueItem } from '../server/reconciliation/queue'
import { currentDecisionProposal } from '../shared/decisionProposal'
import { displayRequestText } from '../shared/requestText'
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
  decisionItems?: QueueItem[];
  scene: FloorScene | null; expanded: string | null; collapse: () => void; state: PresentationState; submit: (body: unknown) => Promise<void>; canBack?: boolean; onBack?: () => void
  deskVisible: boolean; setDeskVisible: (visible: boolean) => void; showThread: (item: AskItem) => void
  replySeed: { conversationId: string; seed: AskSeed; key: string } | null;
  selectAction: (input: AskSelectionInput) => Promise<AskItem>
  items: AskItem[]; error: string | null; open: (subject?: AskSeed, parent?: AskItem) => void
  returnToSource: (item: AskItem) => void; returnTo: (item: AskItem) => void; action: (item: AskItem, action: 'retry' | 'dismiss' | 'restore') => void
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
export function AskProvider({ decisionItems, scene, state, onReturn, onSourceReturn, canBack, onBack, children }: { decisionItems?: QueueItem[]; canBack?: boolean; onBack?: () => void; onSourceReturn?: () => void; scene: FloorScene | null; state: PresentationState; send: (action: PresentationAction) => void; onReturn: (origin: AskReturn) => void; children: ReactNode }) {
  const [deskVisible, setDeskVisible] = useState(false)
  const [items, setItems] = useState<AskItem[]>([]), [error, setError] = useState<string | null>(null)
  const [composer, setComposer] = useState<{ seed: AskSeed; parent?: AskItem; key: string } | null>(null)
  const [replySeed, setReplySeed] = useState<AskControls['replySeed']>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const localRevision = useRef(0), refreshRevision = useRef(0)
  const pendingMutations = useRef(0)
  const visibilityActions = useRef<Promise<unknown>>(Promise.resolve())
  const refresh = useCallback(async () => {
    if (pendingMutations.current) return
    const before = localRevision.current, revision = ++refreshRevision.current
    try {
      const parsed = askItemsSchema.safeParse(await request<AskItem[]>('requests'))
      if (!parsed.success) throw new Error('Questions could not be read')
      const items = parsed.data
      if (!pendingMutations.current && before === localRevision.current && revision === refreshRevision.current) { setItems(items); setError(null) }
    }
    catch (reason) { if (revision === refreshRevision.current) setError((reason as Error).message) }
  }, [])
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh() }, 5000); return () => { clearInterval(timer); refreshRevision.current++ } }, [refresh])
  const open = (seed: AskSeed = {}, parent?: AskItem) => {
    parent ??= items.find(item => item.request_id === seed.followUpTo)
    if (parent) {
      setExpanded(parent.conversation_id)
      markRead(parent)
      setReplySeed({ conversationId: parent.conversation_id, seed, key: crypto.randomUUID() })
      return
    }
    if (!scene && !isArtifactTarget(seed.target)) { setError('Source context is unavailable. Try again when sources connect.'); return }
    setComposer({ seed, key: crypto.randomUUID() })
  }
  const action = (item: AskItem, value: 'retry' | 'dismiss' | 'restore') => {
    localRevision.current++
    if (value !== 'retry') {
      setItems(rows => rows.map(row => row.conversation_id === item.conversation_id ? { ...row, dismissed_at: value === 'dismiss' ? new Date().toISOString() : null } : row))
      setExpanded(null)
    }
    pendingMutations.current++
    const perform = () => request(`requests/${item.request_id}/${value}`, {})
    const task = value === 'retry' ? perform() : visibilityActions.current.then(perform)
    if (value !== 'retry') visibilityActions.current = task.catch(() => undefined)
    void task.catch(reason => setError((reason as Error).message)).finally(() => {
      pendingMutations.current--
      if (!pendingMutations.current) void refresh()
    })
  }

  const markRead = (item: AskItem) => {
    const unread = items.filter(turn => turn.conversation_id === item.conversation_id && turn.reply && !turn.read_at)
    if (unread.length) {
      localRevision.current++
      pendingMutations.current++
      const opened = new Set(unread.map(turn => turn.request_id)), at = new Date().toISOString()
      setItems(rows => rows.map(row => opened.has(row.request_id) ? { ...row, read_at: at } : row))
      void Promise.allSettled(unread.map(turn => request(`requests/${turn.request_id}/read`, {}))).then(results => {
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') setError((failed.reason as Error).message)
      }).finally(() => {
        pendingMutations.current--
        if (!pendingMutations.current) void refresh()
      })
    }
  }

  const returnTo = (item: AskItem) => {
    setExpanded(item.conversation_id)
    onReturn(askReturn(item.context))
    markRead(item)
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
  return <Controls.Provider value={{ decisionItems, scene, state, deskVisible, setDeskVisible, showThread: item => { setExpanded(item.conversation_id); markRead(item) }, submit, selectAction, replySeed, expanded, collapse: () => setExpanded(null), canBack, onBack, items, error, open, returnTo, returnToSource: item => { returnTo(item); onSourceReturn?.() }, action }}>{children}
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
  return <><path ref={gesture.ref} className="ov-relationship-hit" data-claim-id={claimId} d={d} role="button" tabIndex={0} aria-label="Ask about this relationship" onContextMenu={event => ask(event, 'relationship', claimId)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') ask(event, 'relationship', claimId) }} /></>
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
/** One form for contextual surfaces, semantic entry points and Desk replies. */
function AskComposer({ scene, state, seed, parent, clientKey, submit, close, inline = false, embedded = false, compact = false }: { scene: FloorScene | null; state: PresentationState; seed: AskSeed; parent?: AskItem; clientKey: string; submit: (body: unknown) => Promise<void>; close: () => void; inline?: boolean; embedded?: boolean; compact?: boolean }) {
  const [chosen, setChosen] = useState(seed.cardId ?? ''), [question, setQuestion] = useState(seed.question ?? (seed.target?.kind === 'pull' && seed.target.action_receipt_id ? 'What does this action receipt establish?' : seed.field_key ? fieldDrafts[seed.field_key] : '')), [busy, setBusy] = useState(false), [voiceBusy, setVoiceBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const ref = useDialogFocus(!inline && !embedded), locked = useRef(false), titleId = useId()
  const card = scene?.cards.find(card => card.id === chosen)
  const worker = seed.target?.kind === 'execution' ? scene?.executions.find(worker => worker.id === seed.target!.id) : null
  const claim = seed.target?.kind === 'claim' ? scene?.claims.find(claim => claim.id === seed.target!.id) : null
  const linkedCard = claim && scene?.cards.find(card => card.id === claim.cardId)
  const label = parent?.context.anchor.label ?? seed.label ?? (isArtifactTarget(seed.target) ? seed.target.id : worker ? workerTitle(worker) : linkedCard ? `Relationship · ${cardTitle(linkedCard)}` : card ? cardTitle(card) : chosen)
  const bound = !!parent || !!seed.target || !!chosen
  const element = (seed.target || chosen === seed.cardId) ? seed.element : undefined
  // Freeze the whole uncertain envelope, including its exact parent. A refresh
  // may discover another turn before a lost acknowledgment is retried.
  const key = useRef(inline || embedded ? crypto.randomUUID() : clientKey), retryBody = useRef<unknown>(null)
  const edited = () => { if (retryBody.current) { key.current = crypto.randomUUID(); retryBody.current = null } }
  const send = async (text = question) => {
    if (locked.current || !bound || !text.trim()) return
    locked.current = true; setBusy(true); setError(null)
    retryBody.current ??= { client_key: key.current, ...(seed.target ? { target: seed.target } : { card_id: chosen }), ...((seed.element || seed.field_key) && (seed.target || chosen === seed.cardId) ? { element: seed.element, field_key: seed.field_key, field_value: seed.field_value } : {}), question: text.trim(), view: parent?.context.view ?? seed.view ?? { scene: 'overview', organizer: state.organizer, statusFilter: state.statusFilter }, ...(parent ? { follow_up_to: parent.request_id } : {}) }
    try {
      await submit(retryBody.current)
      if (inline || embedded) { setQuestion(''); retryBody.current = null; key.current = crypto.randomUUID() }
    } catch (reason) { setError((reason as Error).message) }
    finally { locked.current = false; setBusy(false) }
  }
  const form = <form className={`ask-composer${compact ? " ask-composer-compact" : ""}`} aria-label={inline ? 'Reply to First Mate' : embedded ? `Ask about ${label}` : 'New question'} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!busy) close() }
  }} onSubmit={event => {
    event.preventDefault()
    if (!voiceBusy) void send()
  }}>
    {!inline && !embedded && <><header><h2 id={titleId}>Ask First Mate</h2><button type="button" disabled={busy} onClick={close} aria-label="Close question">×</button></header>
      <p>{seed.element ? 'Ask about this element. Send the suggested question or edit it.' : 'Swipe left on an item to ask; right-click or long-press a field to ask about it.'}</p>
      {bound ? <div className="ask-chip"><span>{seed.target && isArtifactTarget(seed.target) && <small>{seed.target.kind === 'pull' ? 'GitHub PR' : seed.target.kind === 'release' ? 'Deployment target' : 'Deployment receipt'} · </small>}{label}</span>{!parent && !seed.target && <button type="button" disabled={busy} aria-label="Remove task context" onClick={() => { setChosen(''); edited() }}>×</button>}</div> : <label>Task context<select aria-label="Task context" value={chosen} required onChange={event => { setChosen(event.target.value); edited() }}><option value="">Choose a task</option>{scene?.cards.map(card => <option key={card.id} value={card.id}>{String(card.source.properties.Name?.value ?? card.id)}</option>)}</select></label>}
      </>}
    {element && <div className="ask-element-context" aria-label="Element context"><small>{element.label}</small><p>{element.value}</p></div>}
    <label><span className={inline || compact ? 'ask-sr-only' : undefined}>{inline ? 'Reply to First Mate' : embedded ? `Question about ${label}` : 'Question'}</span><textarea autoFocus={!inline && !embedded || !!seed.question} required maxLength={4000} value={question} aria-busy={busy || voiceBusy} readOnly={busy || voiceBusy} onChange={event => { setQuestion(event.target.value); edited() }} placeholder={compact ? 'Ask First Mate about this decision…' : inline ? 'Message First Mate…' : 'What would you like to know?'} enterKeyHint="send" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} /></label>
    {error && <><p role="alert">Message could not be sent. Try again.</p><details className="ask-delivery-diagnostics"><summary>Technical details</summary><p>{error}</p></details></>}
    <VoiceInput disabled={busy || !bound} onBusyChange={setVoiceBusy} onTranscript={async transcript => {
      const next = [question.trim(), transcript].filter(Boolean).join('\n')
      setQuestion(next); edited()
      if (next.length > 4000) { setError('Recording added to draft. Shorten it to 4,000 characters before sending.'); return }
      await send(next)
    }} />
    <footer>{!inline && !embedded && <button type="button" disabled={busy} onClick={close}>Cancel</button>}<button type="submit" aria-label={compact ? 'Send question' : inline ? 'Send reply' : undefined} disabled={busy || voiceBusy || !bound || !question.trim()}>{busy ? 'Sending…' : compact ? '↑' : inline ? 'Send' : embedded ? 'Send to First Mate' : 'Send question'}</button></footer>
  </form>
  return inline || embedded ? form : <dialog ref={ref} className="ask-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) close() }}>{form}</dialog>
}
/** Hosts supply the same canonical subject used by right-click and swipe Ask.
 * Freshness is resolved by the authenticated server, never trusted from text. */
export function AskContextComposer({ subject, compact = false }: { subject: AskSeed; compact?: boolean }) {
  const controls = useAskControls()
  const [clientKey] = useState(() => crypto.randomUUID())
  if (!controls) return null
  const parent = subject.followUpTo ? controls.items.find(item => item.request_id === subject.followUpTo) : undefined
  return <div className="ask-context-composer"><AskComposer key={JSON.stringify(subject)} embedded compact={compact} scene={controls.scene} state={controls.state}
    seed={subject} parent={parent} clientKey={clientKey} submit={controls.submit} close={() => undefined} /></div>
}
/** Resolve the fleet terminal against the same canonical scene used by Ask.
 * A same-named worker in another home must never acquire this conversation. */
export function AskWorkerComposer({ home, taskId }: { home: string; taskId: string }) {
  const controls = useAskControls()
  const matches = controls?.scene?.executions.filter(execution => execution.home === home && execution.identity.task_id === taskId) ?? []
  if (matches.length !== 1) return <p role="status">Worker conversation context is unavailable or ambiguous. Reconnect sources to ask about this worker.</p>
  const execution = matches[0]!
  return <AskContextComposer key={execution.id} subject={{ target: { kind: 'execution', id: execution.id }, label: taskId, view: { scene: 'overview', worker: { home, task_id: taskId } } }} />
}
function sourceAvailable(item: AskItem, scene: FloorScene | null) {
  const target = item.context.target
  if (isArtifactTarget(target)) return true // The authorized section resolves current artifact availability.
  if (target?.kind === 'execution') return !!scene?.executions.some(worker => worker.id === target.id)
  if (target?.kind === 'claim') return !!scene?.claims.some(claim => claim.id === target.id && scene.cards.some(card => card.id === claim.cardId && !card.source.in_trash && !card.source.archived))
  return !!scene?.cards.some(card => card.id === item.context.anchor.page_id && !card.source.in_trash && !card.source.archived)
}
function MessageText({ text }: { text: string }) {
  // Some older user turns quote the validator wall the old UI inserted. Keep
  // that exact message inspectable without repeating protocol text as prose.
  const diagnostic = /["“]?\d+ suggested actions? (?:were|was) rejected:|\bfm-hold-v\d:|\binstruction: URLs and link syntax/i.exec(text)
  const prose = diagnostic ? text.slice(0, diagnostic.index).trim() : text
  const display = displayRequestText(prose, 'Message details available below')
  const hasDetails = !!diagnostic || display === 'Message details available below'
  return <div className="ask-message-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href, title }) => <a href={href} title={title} target="_blank" rel="noreferrer">{children}</a> }}>{display}</ReactMarkdown>{hasDetails && <details className="ask-delivery-diagnostics"><summary>Technical details</summary><pre>{text}</pre></details>}</div>
}
function MessageTime({ at }: { at: string }) {
  return <time dateTime={at} title={new Date(at).toLocaleString()}>{new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
}
function AskDelivery({ item, controls, now }: { item: AskItem; controls: AskControls; now: number }) {
  return <div className="ask-delivery">
    <p role="status">{item.status === 'delivered' && !deliveryFailed(item) ? 'Delivered · Waiting for answer' : deliveryFailed(item) ? 'Delivery failed' : 'Waiting for answer'}</p>
    <details className="ask-delivery-diagnostics"><summary>Technical details</summary>
      <p>{item.status === 'delivered' ? 'Delivered' : item.status === 'failed' ? 'Delivery failed' : 'Sent'}{item.error ? ` · ${item.error}` : ''}</p>
      {Date.parse(item.created_at) < now - 120_000 && <p>Waiting for First Mate’s answer. First Mate may be offline.</p>}
      <code>{item.request_id}</code>
    </details>
    {deliveryFailed(item) && <button type="button" aria-label={`Retry delivery: ${item.question}`} onClick={() => controls.action(item, 'retry')}>Retry delivery</button>}
  </div>
}
function AskThread({ turns, controls, now }: { turns: AskItem[]; controls: AskControls; now: number }) {
  const latest = turns.at(-1)!
  const latestAnswer = mostRecentAnswer(turns)
  const seed = controls.replySeed?.conversationId === latest.conversation_id ? controls.replySeed : null
  const viewport = useRef<HTMLDivElement>(null), nearBottom = useRef(true)
  // Reply timestamps can interleave with later questions. Sort message events,
  // not request pairs, and never render action selections twice.
  const messages = turns.flatMap(turn => [...(turn.published_proposal ? [] : [{ key: `${turn.request_id}:user`, turn, sender: 'You', at: turn.action_selection?.selected_at ?? turn.created_at }]),
    ...(turn.reply ? [{ key: `${turn.request_id}:reply`, turn, sender: 'First Mate', at: turn.answered_at ?? turn.created_at }] : [])])
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const signature = messages.map(message => message.key).join('|')
  const unread = turns.some(turn => turn.reply && !turn.read_at && !turn.dismissed_at)
  useLayoutEffect(() => {
    const element = viewport.current
    if (element && nearBottom.current) element.scrollTop = element.scrollHeight
  }, [signature])
  return <section className="ask-thread" id={`ask-thread-${latest.conversation_id}`} aria-label={`Answer thread: ${turns[0]!.question}`}>
    <header className="ask-thread-header"><h3>{conversationTitle(turns)}</h3><div>
      {unread && <button type="button" className="ask-thread-unread" aria-label="Read new answer" onClick={() => { controls.returnTo(latest); nearBottom.current = true; if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }}>New answer</button>}
      <button type="button" className="ask-source-return" aria-label="Return to source" title="Return to source" onClick={() => controls.returnToSource(latest)}>↗</button>
      <button type="button" aria-label="Collapse answer" onClick={controls.collapse}>×</button>
    </div></header>
    <div className="ask-messages" ref={viewport} onScroll={event => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64 }}>
      {messages.map(({ key, turn, sender, at }) => {
        const incoming = sender === 'First Mate', reply = turn.reply
        const selected = turns.find(item => item.action_selection?.answer_id === turn.request_id)
        const decision = turn.context.target?.kind === 'decision'
        const workProposal = controls.decisionItems?.find(item => item.id === turn.context.target?.id)?.proposal
        const currentProposal = decision ? currentDecisionProposal([...controls.items.filter(item => item.context.target?.kind === 'decision' && item.context.target.id === turn.context.target!.id && item.reply?.decision_proposal?.request_key === turn.context.target!.id).map(item => ({ answer_id: item.request_id, value: item.reply!.decision_proposal! })), ...(workProposal ? [workProposal] : [])]) : undefined
        const superseded = decision ? currentProposal?.answer_id !== turn.request_id : latestAnswer?.request_id !== turn.request_id
        const unavailable = !!reply?.rejected_actions?.length && !reply.suggested_actions.some(action => typeof action !== 'string')
        const summary = reply?.summary.trim() ?? '', detail = reply?.detail.trim() ?? ''
        // Legacy replies often store a summary prefix of the full detail.
        const text = detail.startsWith(summary) ? detail : summary === detail || !detail ? summary : `${summary}\n\n${detail}`
        return <section key={key} className={`ask-message ${incoming ? 'is-incoming' : 'is-outgoing'}`} data-unread={incoming && !turn.read_at && !turn.dismissed_at} aria-label={incoming ? 'First Mate reply' : `Question: ${turn.question}`}>
          <header><strong>{sender}</strong><MessageTime at={at} /></header>
          {incoming && reply ? <>
            <div {...askElement('answer', 'First Mate answer', detail.startsWith(summary) ? text : summary)}><MessageText text={detail.startsWith(summary) ? text : summary} /></div>{!detail.startsWith(summary) && detail && <div {...askElement('answer', 'Answer detail', detail)}><MessageText text={detail} /></div>}
            {!!reply.references.length && <div className="ask-message-references">{reply.references.map((reference, index) => <a key={index} href={reference.url} target="_blank" rel="noreferrer">{/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(reference.url) ? `Open PR #${reference.url.match(/\d+\/?$/)?.[0].replace('/', '')}` : reference.label} ↗</a>)}</div>}
            {unavailable && <p className="ask-action-unavailable">One-click action unavailable{!superseded && <button type="button" onClick={() => controls.open({ question: 'Please resend the one-click choices for your last answer.' }, latest)}>Request new choices</button>}</p>}
            <AskActions decision={decision} answerId={turn.request_id} suggestions={reply.decision_proposal?.actions ?? (turn.context.target?.kind === 'decision' ? reply.suggested_actions.filter(action => typeof action === 'string') : reply.suggested_actions)} superseded={superseded}
              selection={selected ? { action_id: selected.action_selection!.action_id, status: selected.status, outcome: selected.outcome, merge_selection: selected.merge_selection, error: selected.error } : null} onSelect={controls.selectAction} />
            {!!reply.rejected_actions?.length && <details className="ask-delivery-diagnostics"><summary>Technical details</summary><pre>{JSON.stringify(reply.rejected_actions, null, 2)}</pre></details>}
          </> : <>
            <MessageText text={turn.action_selection ? `Requested: ${turn.action_selection.label}` : turn.question} />
            {turn.captured_selection && <details className="ask-delivery-diagnostics"><summary>Selected context</summary><blockquote>{turn.captured_selection.element?.value ?? turn.captured_selection.field_value}</blockquote></details>}
            {!turn.reply && <AskDelivery item={turn} controls={controls} now={now} />}
          </>}
        </section>
      })}
      <div className="ask-thread-context">
        {latest.context.anchor.url && <a href={latest.context.anchor.url} target="_blank" rel="noreferrer">Open originating source ↗</a>}
        {controls.canBack && <button type="button" onClick={controls.onBack}>Back to previous view</button>}
        <details className="ask-delivery-diagnostics"><summary>Technical details</summary>{!sourceAvailable(latest, controls.scene) && <p>Original source is outside the current view.</p>}<pre>{JSON.stringify(turns.map(turn => ({ request_id: turn.request_id, status: turn.status, error: turn.error, action_selection: turn.action_selection })), null, 2)}</pre></details>
      </div>
    </div>
    <AskComposer key={seed?.key ?? latest.conversation_id} inline scene={controls.scene} state={controls.state} parent={latest}
      seed={{ ...(latest.context.target ? { target: latest.context.target, view: latest.context.view } : { cardId: latest.context.anchor.page_id }), ...seed?.seed }}
      clientKey={latest.conversation_id} submit={controls.submit} close={() => viewport.current?.closest('section')?.querySelector<HTMLButtonElement>('[aria-label="Collapse answer"]')?.focus()} />
  </section>
}
export function AskDesk({ now, view, showEmpty = true }: { now: number; view: DeskView; showEmpty?: boolean }) {
  const controls = useContext(Controls)
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState<AskItem | null>(null)
  useEffect(() => {
    if (archived && controls?.items.some(item => item.conversation_id === archived.conversation_id && !item.dismissed_at)) setArchived(null)
  }, [archived, controls?.items])
  const previousExpanded = useRef<string | null>(null), desk = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (!controls?.expanded && previousExpanded.current) document.querySelector<HTMLElement>(`[data-conversation-id="${previousExpanded.current}"]`)?.querySelector<HTMLButtonElement>('.ask-preview')?.focus({ preventScroll: true })
    if (controls?.expanded && controls.expanded !== previousExpanded.current && desk.current) desk.current.scrollTop = 0
    previousExpanded.current = controls?.expanded ?? null
  }, [controls?.expanded])
  if (!controls) return null
  const history = view === 'history'
  const groups = deskConversations(controls.items).map(group => ({ ...group, visible: group.view === view && (!history || !search || group.turns.some(item => `${item.question} ${item.context.anchor.label} ${item.reply?.summary ?? ''} ${item.reply?.detail ?? ''}`.toLowerCase().includes(search.toLowerCase()))) })).filter(group => group.visible || group.id === controls.expanded).sort((a, b) => Number(b.id === controls.expanded) - Number(a.id === controls.expanded))
  return <section ref={desk} className="ask-desk" data-thread-open={!!controls.expanded} aria-label="Questions for First Mate">
    {archived && <div role="status">Conversation archived. <button type="button" aria-label="Undo archive" onClick={() => { controls.action(archived, 'restore'); setArchived(null) }}>Undo</button></div>}
    {controls.error && <><p role="status">Discuss is temporarily unavailable. Try again.</p><details className="ask-delivery-diagnostics"><summary>Technical details</summary><p>{controls.error}</p></details></>}
    {history && <input aria-label="Search question history" type="search" value={search} onChange={event => setSearch(event.target.value)} />}
    {showEmpty && !groups.some(group => group.visible) && <p>{history ? 'No matching questions in history.' : view === 'waiting' ? 'No questions waiting for an answer.' : 'New answers appear here.'}</p>}
    {groups.map(group => {
      const { latest: item, turns, unread } = group, expanded = controls.expanded === item.conversation_id
      const answer = mostRecentAnswer(turns)
      const preview = answer?.reply?.summary && displayRequestText(answer.reply.summary) !== conversationTitle(turns) ? displayRequestText(answer.reply.summary) : null
      return <AskSurface as="article" hidden={!group.visible} subject={item.context.target ? { followUpTo: item.request_id, target: item.context.target, label: item.context.anchor.label, view: item.context.view } : { followUpTo: item.request_id, cardId: item.context.anchor.page_id, view: item.context.view }} key={item.conversation_id} data-ask-id={item.request_id} data-conversation-id={item.conversation_id} data-unread={unread} data-expanded={expanded}>
        <button type="button" hidden={expanded} data-has-preview={!!preview} className="ask-preview" aria-expanded={expanded} aria-controls={`ask-thread-${item.conversation_id}`} onClick={() => controls.returnTo(item)}>
          <small {...askElement('status', 'Question status')}>{unread ? 'New answer' : group.failed ? 'Delivery failed' : item.reply ? 'Answered' : answerStatus(item)} · {ageLabel(Date.parse(group.updatedAt), now)}</small>
          <strong {...askElement('question', 'Question')}>{conversationTitle(turns)}</strong><span {...askElement('title', 'Originating item')}>{displayRequestText(item.context.anchor.label, 'First Mate')}</span>{preview && <p>{preview}</p>}
        </button>
        {expanded && <AskThread turns={turns} controls={controls} now={now} />}
        {!expanded && <button type="button" className="ask-archive" aria-label={history ? 'Restore to inbox' : 'Archive conversation'} title={history ? 'Restore to inbox' : 'Archive conversation'} onClick={() => { controls.action(item, history ? 'restore' : 'dismiss'); if (!history) setArchived(item) }}>{history ? 'Restore' : <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3 3h14v4H3zM5 7v10h10V7M10 9v5m-3-3 3 3 3-3" /></svg>}</button>}
      </AskSurface>
    })}
  </section>
}
