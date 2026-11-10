import { useLayoutEffect, useRef, useState } from 'react'
import { useDeskWorkspace } from '../ask/DeskWorkspace'
import { useViewSnapshot } from '../ask/workspaceHistory'
import { AskSurface } from '../ask/AskSurface'
import type { QueueItem } from '../server/reconciliation/queue'
import { cardTitle } from './overviewModel'
import './decisions.css'
import '../ask/ask-actions.css'
import type { NeedsWillItem } from '../server/reconciliation/needsWill'
import { useWorkSave } from './WorkActions'
import { decodeRequestText } from './requestText'

export const readinessLabels = {
  'ready-now': 'Ready now',
  'needs-readiness-verification': 'Needs readiness verification',
  'future-or-conditional': 'Future or conditional',
}
interface DecisionEntry { key: string; item: QueueItem; id: string | null; title: string; action: string | null }
const sourceStale = (item: QueueItem, now: number) => item.sources.some(source => !['fresh', 'partial'].includes(source.status) || !!source.expiresAt && Date.parse(source.expiresAt) <= now)

/** The list is a projection of the existing queue; card focus belongs to the
 * shared presentation, including when this section unmounts. */
export function Decisions() {
  const { scene, error, queue, queueError, state, send, connection, bridgeError, now, views } = useDeskWorkspace()
  const [query, setQuery] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const interaction = useRef(0)
  const [expiredFlash, setExpiredFlash] = useState<number | null>(null)
  const selectedId = state.selection?.kind === 'card' ? state.selection.id : null
  const flash = state.flash && state.flash.until > Date.now() && state.flash.until !== expiredFlash ? state.flash : null
  useViewSnapshot(views, 'decisions', () => ({ query }), saved => setQuery(saved.query))
  const queueItems = queue?.needsWill ?? queue?.items ?? []
  const entries = queueItems.flatMap<DecisionEntry>(item => {
    if (!item.cardIds.length) return [{ key: item.id, item, id: null, title: decodeRequestText(item.title), action: item.action ? decodeRequestText(item.action) : null }]
    return item.cardIds.map(id => {
      const card = scene?.cards.find(card => card.id === id)
      return { key: `${item.id}:${id}`, item, id, title: card ? cardTitle(card) : decodeRequestText(item.title), action: item.action ? decodeRequestText(item.action) : null }
    })
  })
  const selected = selectedId ? entries.find(entry => entry.id === selectedId) : undefined
  const matches = (entry: typeof entries[number]) => `${entry.title} ${entry.id ?? ''} ${entry.item.title} ${entry.action ?? ''} ${readinessLabels[entry.item.readiness]}`.toLowerCase().includes(query.trim().toLowerCase())
  const visible = entries.filter(entry => matches(entry) || !!entry.id && entry.id === selectedId || !!entry.id && flash?.ids.includes(`card:${entry.id}`))
  const unavailable = !!queueError || !!error
  const incomplete = !!queue?.pullCoverage && (!queue.pullCoverage.associationsComplete || queue.pullCoverage.repositories.some(repo => repo.status !== 'fresh' || !repo.complete)) || queue && [queue.coverage.intentions, ...queue.coverage.fleet].some(source => !['fresh', 'partial'].includes(source.status) || source.coverage !== 'complete' || !!source.expiresAt && Date.parse(source.expiresAt) <= now)
  const canFocus = (id: string) => !unavailable && !!scene?.cards.some(card => card.id === id)
  useLayoutEffect(() => {
    if (!selectedId) return
    list.current?.querySelector<HTMLElement>(`[data-card-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [state.selection, !!selected])
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
  return <section className="decisions" aria-label="Decisions" data-presentation-scene data-scene-id={connection?.scene_id} data-revision={state.revision}>
    <header><span className="cockpit-eyebrow">SHARED QUEUE</span><h1>Decisions</h1><p>Needs Will: outstanding asks and merge requests with their current evidence. Select a card to work on it from Your desk.</p></header>
    {bridgeError && <p role="status">MCP connection delayed. Local browsing remains available.</p>}
    {unavailable && <p role="status">{queueError ?? error} Shared card focus is unavailable until sources recover.</p>}
    {incomplete && <p role="status">Some sources are stale or unavailable. Retained requests are last-known; this list cannot establish that all work is clear.</p>}
    {queue?.warnings?.map(warning => <p role="status" key={warning}>{warning}</p>)}
    <ExecutionWarnings warnings={queue?.operationalExceptions} onFocus={id => send({ type: 'focus', target: { kind: 'card', id }, origin: 'manual' })} canFocus={canFocus} />
    <label className="decisions-search">Search decisions<input type="search" value={query} onChange={event => { interaction.current++; setQuery(event.target.value) }} placeholder="Title, card ID or next action" /></label>
    <div className="decisions-layout">
      <div className="decisions-list" ref={list} aria-label="Decision requests">
        {!queue && !queueError && <p role="status">Reading decision sources…</p>}
        {queue && !visible.length && <p role="status">{unavailable || incomplete ? 'No matching requests in available records. Source coverage is incomplete.' : query ? 'No matching requests.' : 'No requests in the current queue. This does not certify all work is clear.'}</p>}
        {visible.map(entry => {
          const { item, id } = entry
          const flashed = !!id && !!flash?.ids.includes(`card:${id}`)
          const details = <><strong>{entry.title}</strong><small>{readinessLabels[item.readiness]}{sourceStale(item, now) ? ' · Source stale / unavailable' : ''}</small>{entry.action && <span>{entry.action}</span>}<RequestEvidence item={item} now={now} />{!matches(entry) && <small>Shared target shown outside search</small>}</>
          return id ? <AskSurface as="div" subject={{ cardId: id }} key={entry.key}><button type="button" className={`decisions-row${selectedId === id ? ' selected' : ''}${flashed ? ' flashed' : ''}`} data-card-id={id} aria-pressed={selectedId === id} disabled={!canFocus(id)} onClick={() => send({ type: 'focus', target: { kind: 'card', id }, origin: 'manual' })}>{details}{!canFocus(id) && <small>Card unavailable in the source scene. <span>Use the source link below.</span></small>}</button>{!canFocus(id) && <a href={`https://www.notion.so/${id}`} target="_blank" rel="noreferrer">Read source card ↗</a>}</AskSurface> : <details className="decisions-request" key={entry.key}><summary>{details}</summary><p>No linked card; card focus and flash are unavailable.</p>{item.sources.map((source, index) => <p key={index}>{source.request?.kind} · {source.request?.taskId ?? source.id}{source.action ? ` · ${decodeRequestText(source.action)}` : ''}</p>)}{item.evidence.map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer">Read evidence ↗</a>)}</details>
        })}
      </div>
      <aside className="decisions-summary" aria-label="Selected decision">
        {selected ? <AskSurface as="div" subject={{ cardId: selected.id! }}><small>SELECTED CARD</small><h2>{selected.title}</h2><p>{readinessLabels[selected.item.readiness]}</p><DecisionChoices key={selected.key} entry={selected} items={queueItems} /><p>{selected.action ?? 'Next action not published. Read the source card for context.'}</p><a href={`https://www.notion.so/${selected.id}`} target="_blank" rel="noreferrer">Read Notion card ↗</a>{selected.item.evidence.filter(e => e.kind !== 'card').map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer">Read evidence ↗</a>)}<small>{selected.id}</small>{selected.item.reasons.map(reason => <p key={reason}>{reason}</p>)}</AskSurface> : <p>{selectedId ? 'Selected card is unavailable in the current queue. Selection is retained while sources refresh.' : 'Select a card to share its focus with MCP.'}</p>}
      </aside>
    </div>
  </section>
}

function RequestEvidence({ item, now }: { item: QueueItem; now: number }) {
  const request = item as Partial<NeedsWillItem>
  if (!request.pulls) return null
  const age = request.requestSince ? Math.max(0, Math.floor((now - Date.parse(request.requestSince)) / 3600_000)) : null
  return <>{request.prDetails && <small>{request.prDetails}</small>}<small>{age === null ? 'Request age unknown' : `Oldest recorded open ask: ${age}h (${request.requestSince})`}</small>{request.requests?.map(ask => <small key={ask.id}>{ask.question ?? ask.action} · request {ask.id}</small>)}{request.pulls.map(pull => <small key={pull.id}>{pull.repository} #{pull.number} · {pull.freshness === 'fresh' && pull.readiness?.status === 'fresh' && (!pull.readiness.expiresAt || Date.parse(pull.readiness.expiresAt) > now) ? pull.readiness.checks : 'checks unknown / stale'} · PR opened {pull.createdAt} (not request age)</small>)}</>
}
function ExecutionWarnings({ warnings, onFocus, canFocus }: { warnings: import('../server/reconciliation/workflowViews').ExecutionWarning[] | undefined; onFocus: (id: string) => void; canFocus: (id: string) => boolean }) {
  if (!warnings) return null
  return <details className="decisions-exceptions"><summary>Execution warnings ({warnings.filter(warning => warning.state === 'no-running-worker').length}) · unknown ({warnings.filter(warning => warning.state === 'unknown').length})</summary><p>Advisory observations. Review the card and source before changing its status.</p>{!warnings.length && <p>No execution warnings in observed In Progress cards.</p>}{warnings.map(warning => <article key={warning.cardId}><button type="button" disabled={!canFocus(warning.cardId)} onClick={() => onFocus(warning.cardId)}>{warning.title}</button><strong>{warning.state === 'unknown' ? 'Execution unknown' : 'No running linked worker observed'}</strong>{warning.reasons.map(reason => <p key={reason}>{reason}</p>)}{warning.sources.map(source => <small key={source.home}>{source.home} · {source.status} · observed {source.observedAt ?? 'unknown'} · expires {source.expiresAt ?? 'unknown'}</small>)}</article>)}</details>
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
    {proposal.options!.map(option => <button className="ask-action-choice" key={option.id} disabled={busy || !!result?.decision_resolution} onClick={() => void save('update', {
      kind: 'answer_decision', card_id: cardId, request_id: proposal.id, option_id: option.id, answer: option.label,
      next: { owner: 'Firstmate', status: 'Queued' },
    })}>{option.label}</button>)}
  </div>
}
