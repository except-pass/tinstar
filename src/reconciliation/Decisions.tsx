import { SessionConnection } from './SessionConnection'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDeskWorkspace } from '../ask/DeskWorkspace'
import { useViewSnapshot } from '../ask/workspaceHistory'
import { AskContextComposer, useAskControls } from '../ask/Ask'
import { AskActions, actionDeliveryLabel } from '../ask/AskActions'
import { decisionProposalReady, currentDecisionProposal } from '../shared/decisionProposal'
import { mostRecentAnswer } from '../ask/deskInbox'
import { AskSurface } from '../ask/AskSurface'
import { apiFetch } from '../apiClient'
import type { QueueItem } from '../server/reconciliation/queue'
import type { NeedsWillItem } from '../server/reconciliation/needsWill'
import { cardTitle } from './overviewModel'
import { decodeRequestText, displayRequestText } from './requestText'
import { isCoordinationRequest } from '../shared/requestText'
import { SourceActions } from './QueuePanel'
import { useWorkSave, WorkActions } from './WorkActions'
import { WorkerNotes, ResponseRetry } from '../cockpit/shell/present'
import { findLinkedWorker, homeName } from '../cockpit/overviewQuery'
import { requestAnchor } from '../shared/deskSource'
import './decisions.css'
import '../ask/ask-actions.css'

export const readinessLabels = {
  'ready-now': 'Open question',
  'needs-readiness-verification': 'Needs verification',
  'future-or-conditional': 'Waiting on a prerequisite',
}
const sourceStale = (item: QueueItem, now: number) => item.sources.some(source => !['fresh', 'partial'].includes(source.status) || !!source.expiresAt && Date.parse(source.expiresAt) <= now)
interface DecisionEntry { key: string; item: QueueItem; id: string | null; title: string; question: string | null }
function decisionCopy(item: QueueItem, title: string) {
  const request = item as Partial<NeedsWillItem>
  const action = request.requests?.find(request => request.question)?.question ?? item.action
  const prose = displayRequestText(action ?? title, 'Read the source to verify this request.')
  const question = prose.replace(/^owner\s*:\s*/i, '').trim()
  const cleanTitle = displayRequestText(title).replace(/^(?:owner|decision)\s*:\s*/i, '').trim()
  return { title: action && cleanTitle !== displayRequestText(action).replace(/^owner\s*:\s*/i, '').trim() ? cleanTitle : question,
    question: action && cleanTitle !== displayRequestText(action).replace(/^owner\s*:\s*/i, '').trim() ? question : null }
}

/** One row per existing canonical request. Opening it shares card focus, never
 * creates a second decision, approval or read/archive state. */
export function Decisions() {
  const workspace = useDeskWorkspace()
  const { scene, error, queue, queueError, state, send, connection, bridgeError, now, views } = workspace
  const [query, setQuery] = useState(''), [openedId, setOpenedId] = useState<string | null>(() => { try { return sessionStorage.getItem('tinstar-decision-request') } catch { return null } })
  const [detailOpen, setDetailOpen] = useState(!!openedId)
  useEffect(() => { try { if (openedId) sessionStorage.setItem('tinstar-decision-request', openedId); else sessionStorage.removeItem('tinstar-decision-request') } catch {} }, [openedId])
  const list = useRef<HTMLDivElement>(null), interaction = useRef(0)
  const [expiredFlash, setExpiredFlash] = useState<number | null>(null)
  const selectedId = state.selection?.kind === 'card' ? state.selection.id : null
  const flash = state.flash && state.flash.until > Date.now() && state.flash.until !== expiredFlash ? state.flash : null
  useViewSnapshot(views, 'decisions', () => ({ query, filter: { request: openedId, detailOpen } }), saved => { setQuery(saved.query); setOpenedId(saved.filter.request); setDetailOpen(saved.filter.detailOpen) })

  const coordination = (queue?.needsWill ?? queue?.items ?? []).filter(item => isCoordinationRequest(item.title))
  const entries: DecisionEntry[] = (queue?.needsWill ?? queue?.items ?? []).filter(item => !isCoordinationRequest(item.title)).map(item => {
    const id = item.cardIds[0] ?? null, card = scene?.cards.find(card => card.id === id)
    return { key: item.id, item, id, ...decisionCopy(item, card ? cardTitle(card) : item.title) }
  })
  useEffect(() => {
    setOpenedId(current => !selectedId || entries.find(entry => entry.key === current)?.item.cardIds.includes(selectedId) ? current : null)
  }, [selectedId])
  const queueCardId = state.queueOpen ? state.queueCardId : null
  const selected = state.queueOpen
    ? queueCardId ? entries.find(entry => entry.item.cardIds.includes(queueCardId)) : entries.find(entry => entry.key === state.queueItemId)
    : entries.find(entry => entry.key === openedId) ?? (selectedId ? entries.find(entry => entry.item.cardIds.includes(selectedId)) : undefined)
  const contextCardId = queueCardId && !selected ? queueCardId : null
  const closeDetail = () => { workspace.clearOrigin?.(); setDetailOpen(false); send({ type: 'close-queue' }) }
  const matches = (entry: DecisionEntry) => `${entry.title} ${entry.question ?? ''} ${entry.item.cardIds.join(' ')} ${readinessLabels[entry.item.readiness]}`.toLowerCase().includes(query.trim().toLowerCase())
  const visible = entries.filter(entry => matches(entry) || state.queueOpen && entry.key === selected?.key || !!entry.id && entry.item.cardIds.includes(selectedId ?? '') || !!entry.id && entry.item.cardIds.some(id => flash?.ids.includes(`card:${id}`)))
  const unavailable = !!queueError || !!error
  const incomplete = !!queue?.pullCoverage && (!queue.pullCoverage.associationsComplete || queue.pullCoverage.repositories.some(repo => repo.status !== 'fresh' || !repo.complete)) || queue && [queue.coverage.intentions, ...queue.coverage.fleet].some(source => !['fresh', 'partial'].includes(source.status) || source.coverage !== 'complete' || !!source.expiresAt && Date.parse(source.expiresAt) <= now)
  const canFocus = (id: string) => !unavailable && !!scene?.cards.some(card => card.id === id)
  const returnedOrigin = useRef<typeof workspace.origin>()
  useEffect(() => {
    const origin = workspace.origin
    if (!origin) { returnedOrigin.current = undefined; return }
    if (origin.section !== 'decisions' || origin.target.kind !== 'decision' || returnedOrigin.current === origin) return
    setOpenedId(origin.target.id); setDetailOpen(true)
    if (origin.view?.query !== undefined) setQuery(origin.view.query)
    if (state.queueOpen) send({ type: 'close-queue' })
    if (!queue && !queueError) return
    returnedOrigin.current = origin
    const entry = entries.find(entry => entry.key === origin.target.id)
    if (entry?.id && canFocus(entry.id)) send({ type: 'focus', target: { kind: 'card', id: entry.id }, origin: 'manual' })
  }, [workspace.origin, queue, queueError, scene])
  useLayoutEffect(() => {
    if (state.queueOpen && selected) {
      Array.from(list.current?.querySelectorAll<HTMLElement>('[data-decision-id]') ?? []).find(row => row.dataset.decisionId === selected.key)?.scrollIntoView({ block: 'nearest' })
    } else if (selectedId) list.current?.querySelector<HTMLElement>(`[data-card-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [state.selection, state.queueOpen, selected?.key])
  useLayoutEffect(() => {
    const current = state.flash, viewport = list.current
    if (current && current.until > Date.now()) setDetailOpen(false)
    if (!current || current.until <= Date.now() || !viewport) return
    const row = Array.from(viewport.querySelectorAll<HTMLElement>('[data-card-id]')).find(row => current.ids.includes(`card:${row.dataset.cardId}`))
    const scrolls: { element: HTMLElement; top: number; left: number }[] = []
    for (let element: HTMLElement | null = viewport; element; element = element.parentElement) {
      scrolls.push({ element, top: element.scrollTop, left: element.scrollLeft })
    }
    const before = interaction.current
    let restored = false
    const restore = () => {
      if (restored || interaction.current !== before) return
      restored = true
      for (const { element, top, left } of scrolls) {
        element.scrollTop = top
        element.scrollLeft = left
      }
    }
    const takeOwnership = () => { interaction.current++ }
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    for (const event of events) document.addEventListener(event, takeOwnership, true)
    row?.scrollIntoView({ block: 'nearest' })
    const frame = requestAnimationFrame(() => row?.scrollIntoView({ block: 'nearest' }))
    const timer = setTimeout(() => {
      setExpiredFlash(current.until)
      restore()
    }, Math.max(0, current.until - Date.now()))
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      restore()
      for (const event of events) document.removeEventListener(event, takeOwnership, true)
    }
  }, [state.flash])
  const retainedNotes = (workspace.messages ?? []).filter(message => message.kind === 'message' && !(workspace.workers ?? []).some(worker => worker.home === message.home && worker.id === message.taskId))
  const needsVerification = unavailable || incomplete || bridgeError || !!queue?.warnings?.length || !!queue?.operationalExceptions?.length || !!coordination.length
  const missingOrigin = workspace.origin?.section === 'decisions' && workspace.origin.target.kind === 'decision' && openedId === workspace.origin.target.id && !!queue && !entries.some(entry => entry.key === openedId)
  const preview = missingOrigin ? undefined : selected ?? (!contextCardId && !state.queueOpen ? visible[0] : undefined)
  const position = preview ? visible.findIndex(entry => entry.key === preview.key) : -1
  const openEntry = (entry: DecisionEntry) => {
    interaction.current++
    workspace.clearOrigin?.()
    if (state.queueOpen) send({ type: 'close-queue' })
    if (entry.id && canFocus(entry.id)) send({ type: 'focus', target: { kind: 'card', id: entry.id }, origin: 'manual' })
    setOpenedId(entry.key); setDetailOpen(true)
  }
  return <section className={`decisions${(detailOpen || state.queueOpen) && (preview || contextCardId || missingOrigin) ? ' detail-open' : ''}`} aria-label="Decisions" data-presentation-scene data-scene-id={connection?.scene_id} data-revision={state.revision}>
    <header className="decisions-top"><SessionConnection /><div className="decisions-brand"><h1>Decisions</h1><span>Choose a decision to resolve</span></div>
      <details className="decisions-source"><summary>{needsVerification ? 'Some sources need verification' : 'Source status'}</summary><div className="decisions-warnings">
        <h3>Source health</h3>
        {bridgeError && <p>MCP connection delayed. Local browsing remains available.</p>}
        {unavailable && <p role="status">Requests could not refresh. Shared card focus is unavailable until sources recover.</p>}
        {incomplete && <p>Some evidence is stale or unavailable. Retained requests do not establish that all work is clear.</p>}
        {!needsVerification && <p>No source warnings were reported in this observation.</p>}
        <details><summary>Technical diagnostics</summary>
          {queue?.warnings?.map(warning => <p key={warning}>{warning}</p>)}
          {!!coordination.length && <details><summary>Operational coordination</summary>{coordination.map(item => <p key={item.id}>{displayRequestText(item.title)}</p>)}</details>}
          <ExecutionWarnings warnings={queue?.operationalExceptions} onFocus={id => send({ type: 'focus', target: { kind: 'card', id }, origin: 'manual' })} canFocus={canFocus} />
          {!!retainedNotes.length && <details><summary>Retained worker notes</summary><WorkerNotes messages={retainedNotes} submit={workspace.submit} /></details>}
        </details>
      </div></details>
    </header>
    <div className="decisions-layout" data-selected={!!preview || !!contextCardId || missingOrigin}>
      <section className="decisions-queue" aria-label="Decision queue"><div className="decisions-queue-top">
        <div className="decisions-queue-title"><strong>Decision queue</strong><span>{visible.length} shown</span></div>
        <label className="decisions-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Search decisions" value={query} onChange={event => { interaction.current++; setExpiredFlash(state.flash?.until ?? null); setQuery(event.target.value) }} placeholder="Find a decision…" /></label>
      </div><div className="decisions-list" ref={list} aria-label="Decision requests">
        {!queue && !queueError && <p role="status">Reading decision sources…</p>}
        {!queue && queueError && <p role="status">Decision sources are unavailable.</p>}
        {queue && !visible.length && <p role="status">{unavailable || incomplete ? 'No matching requests in available records. Some evidence needs verification.' : query ? 'No matching requests.' : 'No decisions in the current queue.'}</p>}
        {visible.map(entry => {
          const { item, id } = entry, stale = sourceStale(item, now)
          const flashed = item.cardIds.some(id => flash?.ids.includes(`card:${id}`))
          const row = <button type="button" title={[item.title, item.action].filter(Boolean).join(' · ')} className={`decisions-row${selected?.key === entry.key ? ' selected' : ''}${flashed ? ' flashed' : ''}`} data-card-id={id ?? undefined} data-decision-id={item.id} aria-pressed={selected?.key === entry.key} onClick={() => openEntry(entry)}>
            <div className="one-line"><span className="title">{entry.title}</span><span className="chev">›</span></div>
            <div className="one-line"><span className={`subtitle${stale ? ' stale' : ''}`}>{stale ? 'Needs verification' : item.proposal ? `Recommendation: ${item.proposal.value.actions.find(action => action.id === item.proposal!.value.recommended_action_id)?.label}` : item.readiness !== 'ready-now' ? readinessLabels[item.readiness] : entry.question ?? 'Question and evidence inside'}</span><span className="type">{item.kind === 'blocked' ? 'Intervention' : item.kind === 'merge' ? 'Review' : 'Decision'}</span></div>
          </button>
          return id ? <AskSurface as="div" subject={{ target: { kind: 'decision', id: entry.key }, view: { scene: 'decisions', request_key: entry.key, query } }} key={entry.key}>{row}</AskSurface> : <div key={entry.key}>{row}</div>
        })}
      </div></section>
      {preview && <DecisionDetail key={preview.key} entry={preview} items={queue?.needsWill ?? queue?.items ?? []} unavailable={unavailable} onClose={closeDetail} query={query} position={position} total={visible.length}
        previous={() => openEntry(visible[(position - 1 + visible.length) % visible.length]!)} next={() => openEntry(visible[(position + 1) % visible.length]!)} />}
      {missingOrigin && <MissingDecision requestKey={openedId!} onClose={closeDetail} />}
      {contextCardId && !missingOrigin && <aside className="decisions-summary" aria-label="Card context"><button type="button" onClick={closeDetail}>← All decisions</button><h2>Card context</h2><DecisionCardContext key={contextCardId} id={contextCardId} /></aside>}
    </div>
  </section>
}

function MissingDecision({ requestKey, onClose }: { requestKey: string; onClose: () => void }) {
  const controls = useAskControls(), { openDesk } = useDeskWorkspace()
  const latest = controls?.items.filter(item => item.context.target?.kind === 'decision' && item.context.target.id === requestKey).at(-1)
  return <aside className="decisions-summary" aria-label="Request unavailable">
    <button type="button" className="mobile-back" onClick={onClose}>← All decisions</button>
    <h2 className="detail-heading">Request unavailable</h2><p className="lede">This request is absent from the current queue. Its conversation remains in Discuss.</p>
    {latest && <><p>{displayRequestText(latest.context.anchor.label)}</p><button type="button" onClick={() => { controls!.setDeskVisible(true); controls!.showThread(latest); openDesk() }}>Full conversation ↗</button>
      {latest.context.anchor.url && <a href={latest.context.anchor.url} target="_blank" rel="noreferrer">Source record ↗</a>}</>}
  </aside>
}

function DecisionDetail({ entry, items, unavailable, onClose, query, position, total, previous, next }: { entry: DecisionEntry; items: QueueItem[]; unavailable: boolean; onClose: () => void; query: string; position: number; total: number; previous: () => void; next: () => void }) {
  const { now, submit, messages = [], workers = [], openDesk, scene } = useDeskWorkspace()
  const controls = useAskControls()
  const { item } = entry
  const ready = !unavailable && item.readiness === 'ready-now' && !sourceStale(item, now)
  const request = item as Partial<NeedsWillItem>
  const turns = (controls?.items ?? []).filter(turn => turn.context.target?.kind === 'decision' && turn.context.target.id === item.id)
  const latest = turns.at(-1), answer = mostRecentAnswer(turns)
  const replyProposals = turns.flatMap(turn => {
    const value = turn.reply?.decision_proposal
    return value && value.request_key === item.id && value.source.kind === 'ask-reply' && value.source.id === turn.request_id && (!value.card_id || item.cardIds.includes(value.card_id)) ? [{ answer_id: turn.request_id, value }] : []
  })
  const proposal = currentDecisionProposal([...replyProposals, ...(item.proposal ? [item.proposal] : [])])
  const proposalReply = turns.find(turn => turn.request_id === proposal?.answer_id && !turn.published_proposal)
  const proposalReady = !unavailable && !controls?.error && decisionProposalReady(item, proposal, proposalReply, now)
  const recommended = proposal?.value.actions.find(action => action.id === proposal.value.recommended_action_id)
  const [draft, setDraft] = useState<{ question: string; key: number } | null>(null), [challenge, setChallenge] = useState(false)
  const subject = { target: { kind: 'decision' as const, id: item.id }, view: { scene: 'decisions' as const, request_key: item.id, query }, label: entry.title, ...(latest ? { followUpTo: latest.request_id } : {}) }
  const seed = (question: string) => { controls?.collapse(); setDraft({ question, key: Date.now() }); setChallenge(false) }
  const selection = proposal && turns.filter(turn => turn.action_selection?.answer_id === proposal.answer_id).at(-1)
  const card = scene?.cards.find(card => card.id === entry.id)
  const question = proposal?.value.question ?? entry.question ?? displayRequestText(item.action ?? '', '').replace(/^owner\s*:\s*/i, '').trim()
  const sourceStatus = card ? [card.source.properties.Owner?.value, card.source.properties.Status?.value].filter(Boolean).join(' · ') : `Owner/status not published · ${readinessLabels[item.readiness]}`
  return <aside className="decisions-summary" aria-label="Selected decision" data-decision-id={item.id}>
    <button type="button" className="mobile-back" onClick={onClose}>← All decisions</button>
    <div className="decisions-detail-main"><div className="detail-eyebrow"><span className="section-label">{item.kind === 'blocked' ? 'Intervention' : 'Decision'} · {Math.max(1, position + 1)} of {total}</span><span className="state-label">{selection ? actionDeliveryLabel(selection) : !ready || !!proposal && !proposalReady ? 'Needs verification' : proposal ? 'Awaiting your choice' : 'Recommendation needed'}</span></div>
      <h2 className="detail-heading" title={item.title}>{entry.title}</h2>{question && question !== entry.title && <p className="lede" title={question}>{question}</p>}<div className="divider" />
      <section className="rec-panel" aria-label="Recommendation and choices"><h3 className="small-cap">First Mate recommends</h3>
        <div className="rec-title">{recommended?.label ?? 'Recommendation not yet published'}</div>
        {proposal ? <><p className="rec-basis">{proposal.value.rationale}</p>
          {controls && <AskActions decision answerId={proposal.answer_id} suggestions={proposal.value.actions} recommendedActionId={proposal.value.recommended_action_id} superseded={false} disabled={!proposalReady}
            selection={selection ? { request_id: selection.request_id, action_id: selection.action_selection!.action_id, status: selection.status, outcome: selection.outcome, merge_selection: selection.merge_selection, error: selection.error } : null} onSelect={controls.selectAction} />}
        </> : <button type="button" className="primary" onClick={() => seed('Please publish a current recommendation and alternatives for this exact request using tinstar.decision-proposal.v1, with request_key matching this context. Include rationale and source references.')}>Ask for a recommendation →</button>}
        <div className="secondary-bar"><button type="button" className="wrong-btn" aria-expanded={challenge} onClick={() => setChallenge(!challenge)}>Something wrong? ▾</button><span className="source-basis">{proposal ? `${proposalReady ? 'Current request' : 'Last-known recommendation'} · First Mate` : 'No current proposal'}</span></div>
        {challenge && <div className="wrong-menu">{[
          ['Already resolved', 'Please verify whether this exact request has already been resolved and reconcile its source if confirmed.'],
          ['Not my decision', 'Please verify who owns this exact decision and its outstanding ask.'],
          ['Need more information', 'Please provide the missing context and a current recommendation for this exact request.'],
        ].map(([label, question]) => <button type="button" key={label} onClick={() => seed(`${label}: ${question}`)}>{label}</button>)}</div>}
        {!proposal && <DecisionChoices key={entry.key} entry={entry} items={items} disabled={!ready} />}
        {!ready && <p className="rec-basis" role="status">{item.readiness === 'future-or-conditional' ? 'Waiting on a prerequisite. Verify it has cleared before answering.' : 'This request needs verification before you act.'}</p>}
      </section>
      <section className="discussion" aria-label="Decision discussion"><div className="discuss-head"><h3 className="small-cap">Discussion</h3>{latest && <button type="button" className="full-link" onClick={() => { controls!.setDeskVisible(true); controls!.showThread(latest); openDesk() }}>Full conversation ↗</button>}</div>
        <div className="thread-preview">{answer?.reply ? <><b>First Mate · recent answer</b><span>{displayRequestText(answer.reply.summary)}</span></> : <span>No First Mate exchange published for this request yet.</span>}</div>
        {controls?.deskVisible && controls.expanded ? <p className="rec-basis">Continue in the open Discuss conversation.</p> : <AskContextComposer key={draft?.key ?? item.id} compact subject={{ ...subject, ...(draft ? { question: draft.question } : {}) }} />}
      </section>
      <section className="evidence"><h3 className="small-cap">Sources and evidence</h3><div className="evidence-links">
        {item.cardIds.map(id => <a key={id} href={`https://www.notion.so/${id}`} target="_blank" rel="noreferrer">Read Notion card ↗</a>)}
        {item.evidence.filter(e => e.kind !== 'card').map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer">{e.kind === 'pull-request' ? 'Related PR' : 'Evidence'} ↗</a>)}
        {proposal?.value.references.filter(ref => !item.evidence.some(e => e.url === ref.url)).map(ref => <a key={ref.url} href={ref.url} target="_blank" rel="noreferrer">{ref.label} ↗</a>)}
      </div><p className="source-basis">{sourceStatus}</p>
      <details className="decisions-evidence"><summary>Evidence and delivery details</summary>
        {!item.sources.some(source => source.request && source.request.kind !== 'notion-card') && <p>{displayRequestText(item.action ?? item.title)}</p>}
        {item.sources.filter(source => source.request && source.request.kind !== 'notion-card').map((source, index) => {
          const pending = messages.find(message => message.kind === 'answer' && message.sourceAnchor === source.responseAnchor)
          const request = source.request!
          const matches = workers.filter(worker => worker.home === request.home && worker.id === request.taskId)
          const worker = matches.length === 1 ? matches[0] : null
          const route = worker ? { worker: worker.id, home: homeName(worker.home), key: null, q: '' } : null
          const linked = route ? findLinkedWorker(workers, route) : null
          const href = worker && linked?.home === worker.home && linked.id === worker.id && route ? `?${new URLSearchParams({ worker: route.worker, home: route.home })}` : null
          return <section key={`${source.id}:${index}`} className="decisions-response" aria-label="Decision response"><p>{displayRequestText(source.action ?? '', 'Read the source to verify this question.')}</p>
            {href && <a href={href} target="_blank" rel="noreferrer">Open source terminal ↗</a>}
            {pending ? <><p role="status">{['saved', 'acknowledged', 'done'].includes(pending.state) ? 'Answer saved.' : 'Response pending.'}</p><pre>{JSON.stringify(pending, null, 2)}</pre>{submit && (pending.state === 'sending' || pending.state === 'saved' && pending.announced === false) && <ResponseRetry message={pending} submit={submit} />}</> : ready && request.kind !== 'notion-card' && source.readiness === 'ready-now' && source.responseAnchor === requestAnchor(request) && submit && <SourceActions source={source} submit={submit} />}
          </section>
        })}
        {item.cardIds.map(id => <DecisionCardContext key={id} id={id} showLink={false} />)}
        {request.pulls?.map(pull => <p key={pull.id}>{pull.repository} #{pull.number} · PR opened {pull.createdAt} (not request age) · {pull.readiness?.checks ?? 'Checks unverified'}</p>)}
        <p>{request.requestSince ? `Oldest recorded open ask: ${request.requestSince}` : 'Request age unknown'}</p><pre>{JSON.stringify({ request: item, proposal }, null, 2)}</pre>
      </details></section>
    </div>
    <footer className="nav-foot"><button type="button" onClick={previous} disabled={total < 2}>← Previous</button><span className="progress">{Math.max(1, position + 1)} of {total}</span><button type="button" onClick={next} disabled={total < 2}>Next decision →</button></footer>
  </aside>
}

function DecisionCardContext({ id, showLink = true }: { id: string; showLink?: boolean }) {
  const { scene, refreshAfterMutation, send } = useDeskWorkspace()
  const card = scene?.cards.find(card => card.id === id)
  const [context, setContext] = useState<{ outcome?: string; blocks?: Array<{ id: string; text: string }> } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void apiFetch(`/api/reconciliation/card-context?id=${encodeURIComponent(id)}`, { signal: controller.signal }).then(res => res.json()).then(body => {
      if (!controller.signal.aborted) setContext(body.ok ? body.data : { outcome: 'unavailable' })
    }).catch(() => { if (!controller.signal.aborted) setContext({ outcome: 'unavailable' }) })
    return () => controller.abort()
  }, [id])
  return <section className="decisions-evidence" aria-label={card ? cardTitle(card) : 'Supporting card'}>
    {showLink && <a href={`https://www.notion.so/${id}`} target="_blank" rel="noreferrer">Read Notion card ↗{card ? ` · ${cardTitle(card)}` : ''}</a>}
    {context?.outcome === 'unavailable' && <p>Source details are unavailable. Use the source link.</p>}
    {!!context?.blocks?.length && <details className="decisions-evidence" open><summary>Question, choices and evidence</summary>{context.blocks.map(block => <p key={block.id}>{displayRequestText(block.text, 'Additional source details are available in Technical details.')}</p>)}</details>}
    {card && <><button type="button" className="decisions-context-link" onClick={() => send({ type: 'navigate-card', cardId: card.id })}>Open related work</button><details className="decisions-evidence"><summary>Answer decision</summary><WorkActions answerOnly card={card} sources={context?.blocks} onSaved={refreshAfterMutation} /></details></>}
    <details className="decisions-evidence"><summary>Technical details</summary><pre>{JSON.stringify(context, null, 2)}</pre></details>
  </section>
}
function ExecutionWarnings({ warnings, onFocus, canFocus }: { warnings: import('../server/reconciliation/workflowViews').ExecutionWarning[] | undefined; onFocus: (id: string) => void; canFocus: (id: string) => boolean }) {
  if (!warnings?.length) return null
  return <details><summary>Worker evidence</summary>{warnings.map(warning => <article key={warning.cardId}><button type="button" disabled={!canFocus(warning.cardId)} onClick={() => onFocus(warning.cardId)}>{warning.title}</button><strong>{warning.state === 'unknown' ? 'Execution unknown' : 'No running linked worker observed'}</strong>{warning.reasons.map(reason => <p key={reason}>{decodeRequestText(reason)}</p>)}</article>)}</details>
}

/** Formal published choices use the same workflow operation as MCP. A saved
 * answer does not dismiss this source request; only reconciliation can do so. */
function DecisionChoices({ entry, items, disabled }: { entry: DecisionEntry; items: QueueItem[]; disabled: boolean }) {
  const [saved, setSaved] = useState<{ items: QueueItem[]; requestId: string; result: import('../shared/workflow').StartWorkResult } | null>(null)
  const requests = (entry.item as Partial<NeedsWillItem>).requests ?? []
  const proposals = requests.filter(request => request.cardId === entry.id && !request.answered && request.options?.length && (!entry.item.sources.some(source => source.kind === 'firstmate') || !!request.sourceRequest && entry.item.sources.some(source => source.request && source.request.kind !== 'notion-card' && requestAnchor(source.request) === requestAnchor(request.sourceRequest!) && (source.question ?? source.action) === request.sourceQuestion && (source.generation ?? null) === (request.sourceSpawnGen ?? null))))
  const localStatus = saved?.result.decision_resolution?.message ?? saved?.result.message
  const resolution = saved ? items.filter(item => item.cardIds.includes(entry.id!))
    .flatMap(item => item.decisionResolution?.requests ?? (item.decisionResolution ? [item.decisionResolution] : []))
    .find(status => status.request_id === saved.requestId) : entry.item.decisionResolution
  const status = saved?.items === items ? localStatus : resolution?.message ?? localStatus
  return <>{proposals.map(proposal => <ProposalChoices key={proposal.id} cardId={entry.id!} proposal={proposal} disabled={disabled} onResult={result => setSaved({ items, requestId: proposal.id, result })} />)}{status && <small role="status">{status}</small>}</>
}

function ProposalChoices({ cardId, proposal, onResult, disabled }: { disabled: boolean; cardId: string; proposal: NeedsWillItem['requests'][number]; onResult: (result: import('../shared/workflow').StartWorkResult) => void }) {
  const { busy, result, save } = useWorkSave(async () => {})
  const shownResult = useRef(result)
  useLayoutEffect(() => {
    if (result && shownResult.current !== result) onResult(result)
    shownResult.current = result
  }, [result, onResult])
  return <div className="ask-recommendations ask-action-choices" role="group" aria-label={proposal.question ?? 'Decision choices'}>
    {proposal.options!.map(option => <button className="ask-action-choice" key={option.id} disabled={disabled || busy || !!result?.decision_resolution} onClick={() => void save({
      kind: 'answer_decision', card_id: cardId, request_id: proposal.id, option_id: option.id, answer: option.label,
      next: { owner: 'Firstmate', status: 'Queued' },
    })}>{option.label}</button>)}
  </div>
}
