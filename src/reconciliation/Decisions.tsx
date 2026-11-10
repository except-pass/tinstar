import { SessionConnection } from './SessionConnection'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDeskWorkspace } from '../ask/DeskWorkspace'
import { useViewSnapshot } from '../ask/workspaceHistory'
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
  const [query, setQuery] = useState(''), [openedId, setOpenedId] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null), interaction = useRef(0)
  const [expiredFlash, setExpiredFlash] = useState<number | null>(null)
  const selectedId = state.selection?.kind === 'card' ? state.selection.id : null
  const flash = state.flash && state.flash.until > Date.now() && state.flash.until !== expiredFlash ? state.flash : null
  useViewSnapshot(views, 'decisions', () => ({ query }), saved => setQuery(saved.query))
  const coordination = (queue?.needsWill ?? queue?.items ?? []).filter(item => isCoordinationRequest(item.title))
  const entries: DecisionEntry[] = (queue?.needsWill ?? queue?.items ?? []).filter(item => !isCoordinationRequest(item.title)).map(item => {
    const id = item.cardIds[0] ?? null, card = scene?.cards.find(card => card.id === id)
    return { key: item.id, item, id, ...decisionCopy(item, card ? cardTitle(card) : item.title) }
  })
  useEffect(() => {
    setOpenedId(current => current && entries.find(entry => entry.key === current)?.item.cardIds.includes(selectedId ?? '') ? current : null)
  }, [selectedId])
  const queueCardId = state.queueOpen ? state.queueCardId : null
  const selected = state.queueOpen
    ? queueCardId ? entries.find(entry => entry.item.cardIds.includes(queueCardId)) : entries.find(entry => entry.key === state.queueItemId)
    : entries.find(entry => entry.key === openedId) ?? (selectedId ? entries.find(entry => entry.item.cardIds.includes(selectedId)) : undefined)
  const contextCardId = queueCardId && !selected ? queueCardId : null
  const closeDetail = () => { setOpenedId(null); send({ type: 'close-queue' }); send({ type: 'clear-selection' }) }
  const matches = (entry: DecisionEntry) => `${entry.title} ${entry.question ?? ''} ${entry.item.cardIds.join(' ')} ${readinessLabels[entry.item.readiness]}`.toLowerCase().includes(query.trim().toLowerCase())
  const visible = entries.filter(entry => matches(entry) || state.queueOpen && entry.key === selected?.key || !!entry.id && entry.item.cardIds.includes(selectedId ?? '') || !!entry.id && entry.item.cardIds.some(id => flash?.ids.includes(`card:${id}`)))
  const unavailable = !!queueError || !!error
  const incomplete = !!queue?.pullCoverage && (!queue.pullCoverage.associationsComplete || queue.pullCoverage.repositories.some(repo => repo.status !== 'fresh' || !repo.complete)) || queue && [queue.coverage.intentions, ...queue.coverage.fleet].some(source => !['fresh', 'partial'].includes(source.status) || source.coverage !== 'complete' || !!source.expiresAt && Date.parse(source.expiresAt) <= now)
  const canFocus = (id: string) => !unavailable && !!scene?.cards.some(card => card.id === id)
  useLayoutEffect(() => {
    if (state.queueOpen && selected) {
      Array.from(list.current?.querySelectorAll<HTMLElement>('[data-decision-id]') ?? []).find(row => row.dataset.decisionId === selected.key)?.scrollIntoView({ block: 'nearest' })
    } else if (selectedId) list.current?.querySelector<HTMLElement>(`[data-card-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [state.selection, state.queueOpen, selected?.key])
  useLayoutEffect(() => {
    const current = state.flash, viewport = list.current
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
    const timer = setTimeout(() => {
      setExpiredFlash(current.until)
      restore()
    }, Math.max(0, current.until - Date.now()))
    return () => {
      clearTimeout(timer)
      restore()
      for (const event of events) document.removeEventListener(event, takeOwnership, true)
    }
  }, [state.flash])
  const retainedNotes = (workspace.messages ?? []).filter(message => message.kind === 'message' && !(workspace.workers ?? []).some(worker => worker.home === message.home && worker.id === message.taskId))
  const needsVerification = unavailable || incomplete || bridgeError || !!queue?.warnings?.length || !!queue?.operationalExceptions?.length || !!coordination.length
  return <section className="decisions" aria-label="Decisions" data-presentation-scene data-scene-id={connection?.scene_id} data-revision={state.revision}>
    <header><SessionConnection /><h1>Decisions</h1></header>
    <label className="decisions-search"><span className="ask-sr-only">Search decisions</span><input type="search" value={query} onChange={event => { interaction.current++; setQuery(event.target.value) }} placeholder="Need a decision? Search title, card or topic…" /></label>
    <div className="decisions-layout" data-selected={!!selected || !!contextCardId}>
      <div className="decisions-list" ref={list} aria-label="Decision requests">
        {!queue && !queueError && <p role="status">Reading decision sources…</p>}
        {queue && !visible.length && <p role="status">{unavailable || incomplete ? 'No matching requests in available records. Some evidence needs verification.' : query ? 'No matching requests.' : 'No decisions in the current queue.'}</p>}
        {visible.map(entry => {
          const { item, id } = entry, stale = sourceStale(item, now)
          const flashed = item.cardIds.some(id => flash?.ids.includes(`card:${id}`))
          const row = <button type="button" className={`decisions-row${selected?.key === entry.key ? ' selected' : ''}${flashed ? ' flashed' : ''}`} data-card-id={id ?? undefined} data-decision-id={item.id} aria-pressed={selected?.key === entry.key} onClick={() => {
            if (state.queueOpen) send({ type: 'close-queue' })
            setOpenedId(item.id)
            if (id && canFocus(id)) send({ type: 'focus', target: { kind: 'card', id }, origin: 'manual' })
          }}><div><strong>{entry.title}</strong>{entry.question && <span>{entry.question}</span>}
            <small>{stale ? 'Needs verification' : item.readiness !== 'ready-now' ? readinessLabels[item.readiness] : 'Question and evidence inside'}</small>
          </div><span className="decisions-open">Open</span></button>
          return id ? <AskSurface as="div" subject={{ cardId: id }} key={entry.key}>{row}</AskSurface> : <div key={entry.key}>{row}</div>
        })}
      </div>
      {selected && <DecisionDetail key={selected.key} entry={selected} items={queue?.needsWill ?? queue?.items ?? []} unavailable={unavailable} onClose={closeDetail} />}
      {contextCardId && <aside className="decisions-summary" aria-label="Card context">
        <header><h2>Card context</h2><button type="button" aria-label="Close card context" onClick={closeDetail}>×</button></header>
        <DecisionCardContext key={contextCardId} id={contextCardId} />
      </aside>}
    </div>
    {needsVerification && <details className="decisions-diagnostics"><summary>Some requests need verification · Details</summary>
      {bridgeError && <p>MCP connection delayed. Local browsing remains available.</p>}
      {unavailable && <p role="status">Requests could not refresh. Shared card focus is unavailable until sources recover.</p>}
      {incomplete && <p>Some evidence is stale or unavailable. Retained requests do not establish that all work is clear.</p>}
      {queue?.warnings?.map(warning => <p key={warning}>{warning}</p>)}
      {!!coordination.length && <details><summary>Operational coordination</summary>{coordination.map(item => <p key={item.id}>{displayRequestText(item.title)}</p>)}</details>}
      <ExecutionWarnings warnings={queue?.operationalExceptions} onFocus={id => send({ type: 'focus', target: { kind: 'card', id }, origin: 'manual' })} canFocus={canFocus} />
    </details>}
    {!!retainedNotes.length && <details className="decisions-diagnostics"><summary>Retained worker notes</summary><WorkerNotes messages={retainedNotes} submit={workspace.submit} /></details>}
  </section>
}

function DecisionDetail({ entry, items, unavailable, onClose }: { entry: DecisionEntry; items: QueueItem[]; unavailable: boolean; onClose: () => void }) {
  const { now, submit, messages = [], workers = [] } = useDeskWorkspace()
  const { item } = entry
  const ready = !unavailable && item.readiness === 'ready-now' && !sourceStale(item, now)
  const request = item as Partial<NeedsWillItem>
  return <aside className="decisions-summary" aria-label="Selected decision" data-decision-id={item.id}>
    <header><h2>{entry.title}</h2><button type="button" aria-label="Close decision" onClick={onClose}>×</button></header>
    {entry.question && <p>{entry.question}</p>}
    <DecisionChoices key={entry.key} entry={entry} items={items} />
    {!ready && <p role="status">{item.readiness === 'future-or-conditional' ? 'Waiting on a prerequisite. Verify it has cleared before answering.' : 'This request needs verification before you act.'}</p>}
    {item.evidence.filter(e => e.kind !== 'card').map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer">{e.kind === 'pull-request' ? 'Open PR' : 'Read evidence'} ↗</a>)}
    {item.sources.filter(source => source.request && source.request.kind !== 'notion-card').map((source, index) => {
      const pending = messages.find(message => message.kind === 'answer' && message.sourceAnchor === source.responseAnchor)
      const request = source.request!
      const matches = workers.filter(worker => worker.home === request.home && worker.id === request.taskId)
      const worker = matches.length === 1 ? matches[0] : null
      const route = worker ? { worker: worker.id, home: homeName(worker.home), key: null, q: '' } : null
      const linked = route ? findLinkedWorker(workers, route) : null
      const href = worker && linked?.home === worker.home && linked.id === worker.id && route ? `?${new URLSearchParams({ worker: route.worker, home: route.home })}` : null
      return <section key={`${source.id}:${source.field}:${index}`} className="decisions-response" aria-label="Decision response">
        <p>{displayRequestText(source.action ?? '', 'Read the source to verify this question.')}</p>
        {href && <a href={href} target="_blank" rel="noreferrer">Open source terminal ↗</a>}
        {pending ? <><p role="status">{['saved', 'acknowledged', 'done'].includes(pending.state) ? 'Answer saved.' : 'Response pending.'}</p><details className="decisions-evidence"><summary>Response delivery details</summary><pre>{JSON.stringify(pending, null, 2)}</pre>{submit && (pending.state === 'sending' || pending.state === 'saved' && pending.announced === false) && <ResponseRetry message={pending} submit={submit} />}</details></> : ready && request.kind !== 'notion-card' && source.readiness === 'ready-now' && source.responseAnchor === requestAnchor(request) && submit && <SourceActions source={source} submit={submit} />}
      </section>
    })}
    {item.cardIds.map(id => <DecisionCardContext key={id} id={id} />)}
    <details className="decisions-evidence"><summary>Technical details</summary>
      <p>{request.requestSince ? `Oldest recorded open ask: ${request.requestSince}` : 'Request age unknown'}</p>
      {request.pulls?.map(pull => <p key={pull.id}>{pull.repository} #{pull.number} · PR opened {pull.createdAt} (not request age) · {pull.readiness?.checks ?? 'Checks unverified'}</p>)}
      <pre>{JSON.stringify({ request: item }, null, 2)}</pre>
    </details>
  </aside>
}
function DecisionCardContext({ id }: { id: string }) {
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
    <a href={`https://www.notion.so/${id}`} target="_blank" rel="noreferrer">Read Notion card ↗{card ? ` · ${cardTitle(card)}` : ''}</a>
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
function DecisionChoices({ entry, items }: { entry: DecisionEntry; items: QueueItem[] }) {
  const [saved, setSaved] = useState<{ items: QueueItem[]; requestId: string; result: import('../shared/workflow').StartWorkResult } | null>(null)
  const requests = (entry.item as Partial<NeedsWillItem>).requests ?? []
  const proposals = requests.filter(request => request.cardId === entry.id && !request.answered && request.options?.length)
  const localStatus = saved?.result.decision_resolution?.message ?? saved?.result.message
  const resolution = saved ? items.filter(item => item.cardIds.includes(entry.id!))
    .flatMap(item => item.decisionResolution?.requests ?? (item.decisionResolution ? [item.decisionResolution] : []))
    .find(status => status.request_id === saved.requestId) : entry.item.decisionResolution
  const status = saved?.items === items ? localStatus : resolution?.message ?? localStatus
  return <>{proposals.map(proposal => <ProposalChoices key={proposal.id} cardId={entry.id!} proposal={proposal} onResult={result => setSaved({ items, requestId: proposal.id, result })} />)}{status && <small role="status">{status}</small>}</>
}

function ProposalChoices({ cardId, proposal, onResult }: { cardId: string; proposal: NeedsWillItem['requests'][number]; onResult: (result: import('../shared/workflow').StartWorkResult) => void }) {
  const { busy, result, save } = useWorkSave(async () => {})
  const shownResult = useRef(result)
  useLayoutEffect(() => {
    if (result && shownResult.current !== result) onResult(result)
    shownResult.current = result
  }, [result, onResult])
  return <div className="ask-recommendations ask-action-choices" role="group" aria-label={proposal.question ?? 'Decision choices'}>
    {proposal.options!.map(option => <button className="ask-action-choice" key={option.id} disabled={busy || !!result?.decision_resolution} onClick={() => void save({
      kind: 'answer_decision', card_id: cardId, request_id: proposal.id, option_id: option.id, answer: option.label,
      next: { owner: 'Firstmate', status: 'Queued' },
    })}>{option.label}</button>)}
  </div>
}
