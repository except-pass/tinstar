import { useEffect, useRef, useState } from 'react'
import type { Draft, OutboxMessage, SubmitResult, Worker } from '../cockpit/shell/types'
import { findLinkedWorker, homeName } from '../cockpit/overviewQuery'
import { apiFetch } from '../apiClient'
import { decisionItems, type DeskQueue } from '../shared/reconciliationQueue'
import { Composer } from '../cockpit/shell/present'
import { SlideToDismiss } from '../cockpit/shell/NeedsYouPanel'
import { cardTitle, cardStatus } from './overviewModel'
import { requestAnchor } from '../shared/deskSource'
import type { QueueSource, QueueItem } from '../server/reconciliation/queue'
import type { FloorScene, PresentationAction, PresentationState } from './presentation'

export function QueuePanel({ scene, state, send, queue, error, now, workers, submit, messages }: { scene?: FloorScene; messages: OutboxMessage[]; submit: (draft: Draft) => Promise<SubmitResult>; workers: Worker[]; state: PresentationState; send: (action: PresentationAction) => void; queue: DeskQueue | null; error: string | null; now: number }) {
  const ready = (item: QueueItem) => !error && item.readiness === 'ready-now' && item.sources.every(s => ['fresh', 'partial'].includes(s.status) && (!s.expiresAt || Date.parse(s.expiresAt) > now))
  const items = queue ? decisionItems(queue, now) : []
  const actionable = items.filter(ready)
  const selected = queue?.items.find(item => item.id === state.queueItemId) ?? (!state.queueItemId ? actionable[0] : undefined)
  const index = items.findIndex(item => item.id === selected?.id)
  const cardId = state.queueCardId
  const requestText = (value: string) => /ask-user\s+findings=|(?:^|\s)\/(?:home|tmp|srv)\/|\b(?:needs-readiness-verification|liveness-not-observed)\b/.test(value) ? 'First Mate request' : value.replace(/^[a-z-]+\s+(?:\[[^\]]+\]\s*)+:?\s*/i, '')
  const [context, setContext] = useState<{ outcome?: string; blocks?: Array<{ id: string; text: string }> } | null>(null)
  useEffect(() => {
    setContext(null)
    if (!cardId) return
    const controller = new AbortController()
    void apiFetch(`/api/reconciliation/card-context?id=${encodeURIComponent(cardId)}`, { signal: controller.signal })
      .then(res => res.json()).then(body => { if (!controller.signal.aborted) setContext(body.ok ? body.data : { outcome: 'unavailable' }) })
      .catch(() => { if (!controller.signal.aborted) setContext({ outcome: 'unavailable' }) })
    return () => controller.abort()
  }, [cardId])
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const deskCards = (item: QueueItem, focused = false) => item.cardIds.length ? item.cardIds.map(id => {
    const card = scene?.cards.find(card => card.id === id)
    return <button type="button" className={`ov-desk-card${focused ? ' focused' : ''}`} key={id} data-desk-card-id={id} aria-current={state.navigation?.cardId === id ? 'true' : undefined} onClick={() => {
      if (scene && !card) { setUnavailable(id); return }
      setUnavailable(null); send({ type: 'navigate-card', cardId: id })
    }}><small>{ready(item) ? item.kind === 'merge' ? 'Review' : 'Decision' : item.readiness === 'future-or-conditional' ? 'Waiting on a prerequisite' : 'Needs verification'}</small><strong>{card ? cardTitle(card) : requestText(item.title)}</strong>{card && <small>{cardStatus(card)}</small>}</button>
  }) : <h3>{requestText(item.title)}</h3>
  const readyCards = actionable.filter(item => item.cardIds.length > 0)
  const next = readyCards.filter(item => item.id !== selected?.id)
  return <section className="ov-queue" aria-label="Desk queue" data-queue-item-id={selected?.id ?? ''}>
    {unavailable && <p role="status">Card not on the floor right now. <a href={`https://www.notion.so/${encodeURIComponent(unavailable)}`} target="_blank" rel="noreferrer">Read source card ↗</a></p>}
    {cardId ? <><button type="button" className="ov-back" onClick={() => send({ type: 'close-queue' })}>← Your desk</button><h3>Card context</h3><p>{context?.outcome === 'partial' ? 'Some content omitted. Use the source link for the full card.' : context?.outcome === 'available' ? '' : context?.outcome === 'unavailable' ? 'Card unavailable. Try the source link.' : 'Reading card…'}</p>{context?.blocks?.map(block => <p key={block.id}>{block.text}</p>)}</> : <>
      {selected ? <details className="ov-selected-request" open={selected.cardIds.length > 0 ? true : undefined}><summary>{requestText(selected.title)}</summary><small className="ov-eyebrow">{ready(selected) ? selected.kind === 'merge' ? 'Review' : 'Decision' : 'Needs verification'}</small>{deskCards(selected, true)}<p>{selected.action ? requestText(selected.action) : 'Read the source request for context.'}</p>
        {!ready(selected) && <p>Confirm the next actor and prerequisites before acting.</p>}
        {selected.evidence.map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer">{e.kind === 'pull-request' ? 'Read pull request' : e.kind === 'card' ? 'Read card' : 'Read evidence'} ↗</a>)}
        <div className="ov-queue-actions"><button type="button" disabled={index <= 0} onClick={() => send({ type: 'navigate-queue', direction: 'previous' })}>← Previous</button><button type="button" disabled={index >= items.length - 1} onClick={() => send({ type: 'navigate-queue', direction: 'next' })}>Next →</button></div>
        <section aria-label="Request inspector">{selected.sources.filter(source => source.request).map((source, index) => {
          const request = source.request
          if (request?.kind === 'notion-card') return <details key={source.id}><summary>Notion card</summary><a href={`https://www.notion.so/${request.id}`} target="_blank" rel="noreferrer">Read source card ↗</a><details><summary>Source evidence</summary><pre>{JSON.stringify(source, null, 2)}</pre></details></details>
          const pending = messages.find(message => !!source.responseAnchor && message.kind === 'answer' && message.sourceAnchor === source.responseAnchor)
          const matches = workers.filter(worker => worker.home === request?.home && worker.id === request?.taskId)
          const worker = matches.length === 1 ? matches[0] : null
          const route = worker ? { worker: worker.id, home: homeName(worker.home), key: null, q: '' } : null
          const resolved = route ? findLinkedWorker(workers, route) : null
          const href = worker && route && resolved?.home === worker.home && resolved.id === worker.id ? `?${new URLSearchParams({ worker: route.worker, home: route.home })}` : null
          return <details key={`${source.id}:${source.field}:${index}`}><summary>First Mate {request?.kind === 'hold' ? 'hold' : 'request'} · {index + 1}</summary>
            {href ? <a href={href} target="_blank" rel="noreferrer">Open source terminal ↗</a> : <p>Source terminal unavailable</p>}
            <p>{request?.taskId ?? 'First Mate backlog'} · {request?.home ? homeName(request.home) : 'Unknown home'}</p>
            {source.action && <p>{requestText(source.action)}</p>}
            {pending ? <p role="status">{['saved', 'acknowledged', 'done'].includes(pending.state) ? 'Answer saved. See Receipts for delivery.' : 'Response pending. Check Receipts before sending again.'}</p> : ready(selected) && source.readiness === 'ready-now' && request && source.responseAnchor === requestAnchor(request) && <SourceActions key={source.responseAnchor} source={source} submit={submit} />}
            <details><summary>Source evidence</summary><pre>{JSON.stringify(source, null, 2)}</pre></details>
          </details>
        })}</section>
        <details><summary>Request sources & readiness</summary><pre>{JSON.stringify(selected, null, 2)}</pre></details>
      </details> : (error || state.queueItemId) && <p role="status">{error ? 'Requests could not refresh.' : 'Selected request unavailable'}</p>}
      {next.length > 0 && <>{next.map(item => <div key={item.id}>{item.cardIds.length ? deskCards(item) : <button className="ov-queue-next" type="button" onClick={() => send({ type: 'open-queue', itemId: item.id })}>{requestText(item.title)}</button>}</div>)}</>}

    </>}
  </section>
}

/** The source anchor is resolved against the current explicit request inventory
 * by the existing fleet endpoints. A queue item id is never a response target. */
function SourceActions({ source, submit }: { source: QueueSource; submit: (draft: Draft) => Promise<SubmitResult> }) {
  const anchor = source.responseAnchor!
  const [state, setState] = useState<'idle' | 'busy' | 'answered' | 'dismissed'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const inFlight = useRef(false)
  if (state === 'answered' || state === 'dismissed') return <p role="status">{state === 'answered' ? receipt ?? 'Answer saved. See Receipts for delivery.' : 'Request dismissed.'}</p>
  return <fieldset className="ov-source-actions" disabled={state === 'busy'} aria-busy={state === 'busy'}>
    <details><summary>Answer</summary><Composer anchorKey={anchor} kind="answer" submit={async draft => {
      if (inFlight.current) return { saved: false, error: 'A response is already being sent.', canReceive: 'unknown' }
      inFlight.current = true; setState('busy')
      try {
        const result = await submit(draft)
        if (result.saved) { setReceipt(result.error ?? (result.canReceive === false ? 'Answer saved, not yet read. See Receipts for delivery.' : null)); setState('answered') }
        else setState('idle')
        return result
      } catch (reason) { setState('idle'); throw reason }
      finally { inFlight.current = false }
    }} /></details>
    <SlideToDismiss onConfirm={() => {
      if (inFlight.current) return
      inFlight.current = true; setState('busy'); setError(null)
      void apiFetch('/api/fleet/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: anchor }) })
        .then(res => res.json()).then(body => {
          if (!body.ok || !body.data?.dismissed) throw new Error(body.error?.message ?? body.data?.error ?? 'Source request is no longer available. Refresh the Desk.')
          setState('dismissed')
        }).catch(reason => { setError((reason as Error).message); setState('idle') }).finally(() => { inFlight.current = false })
    }} />
    {state === 'busy' && <p role="status">Sending response…</p>}
    {error && <p role="alert">{error}</p>}
  </fieldset>
}
