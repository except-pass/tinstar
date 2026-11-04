import { useEffect, useState } from 'react'
import type { Worker } from '../cockpit/shell/types'
import { findLinkedWorker, homeName } from '../cockpit/overviewQuery'
import { apiFetch } from '../apiClient'
import { decisionItems, type DeskQueue } from '../shared/reconciliationQueue'
import type { QueueItem } from '../server/reconciliation/queue'
import type { PresentationAction, PresentationState } from './presentation'

export function QueuePanel({ state, send, queue, error, now, workers }: { workers: Worker[]; state: PresentationState; send: (action: PresentationAction) => void; queue: DeskQueue | null; error: string | null; now: number }) {
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
  const readyIndex = actionable.findIndex(item => item.id === selected?.id)
  const next = actionable.slice(readyIndex + 1, readyIndex + 4)
  const secondary = queue?.items.filter(item => !ready(item)) ?? []
  return <section className="ov-queue" aria-label="Desk queue" data-queue-item-id={selected?.id ?? ''}>
    {cardId ? <><button type="button" className="ov-back" onClick={() => send({ type: 'close-queue' })}>← Your desk</button><h3>Card context</h3><p>{context?.outcome === 'available' ? '' : context?.outcome === 'unavailable' ? 'Card unavailable. Try the source link.' : 'Reading card…'}</p>{context?.blocks?.map(block => <p key={block.id}>{block.text}</p>)}</> : <>
      {selected ? <><small className="ov-eyebrow">{ready(selected) ? selected.kind === 'merge' ? 'Review' : 'Decision' : 'Needs verification'}</small><h3>{requestText(selected.title)}</h3><p>{selected.action ? requestText(selected.action) : 'Read the source request for context.'}</p>
        {!ready(selected) && <p>Confirm the next actor and prerequisites before acting.</p>}
        {selected.evidence.map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer">{e.kind === 'pull-request' ? 'Read pull request' : e.kind === 'card' ? 'Read card' : 'Read evidence'} ↗</a>)}
        <div className="ov-queue-actions"><button type="button" disabled={index <= 0} onClick={() => send({ type: 'navigate-queue', direction: 'previous' })}>← Previous</button><button type="button" disabled={index >= items.length - 1} onClick={() => send({ type: 'navigate-queue', direction: 'next' })}>Next →</button></div>
        <section aria-label="Request inspector">{selected.sources.filter(source => source.kind === 'firstmate').map((source, index) => {
          const request = source.request
          const matches = workers.filter(worker => worker.home === request?.home && worker.id === request?.taskId)
          const worker = matches.length === 1 ? matches[0] : null
          const route = worker ? { worker: worker.id, home: homeName(worker.home), key: null, q: '' } : null
          const resolved = route ? findLinkedWorker(workers, route) : null
          const href = worker && route && resolved?.home === worker.home && resolved.id === worker.id ? `?${new URLSearchParams({ worker: route.worker, home: route.home })}` : null
          return <details key={`${source.id}:${source.field}:${index}`}><summary>First Mate {request?.kind === 'hold' ? 'hold' : 'request'} · {index + 1}</summary>
            {href ? <a href={href} target="_blank" rel="noreferrer">Open source terminal ↗</a> : <p>Source terminal unavailable</p>}
            <pre>{JSON.stringify(source, null, 2)}</pre>
          </details>
        })}</section>
        <details><summary>Request sources & readiness</summary><pre>{JSON.stringify(selected, null, 2)}</pre></details>
      </> : <><h3>{!queue || error ? 'Desk unavailable' : state.queueItemId ? 'Selected request unavailable' : 'No verified request ready'}</h3><p>{!queue || error ? 'Last known requests stay available below.' : state.queueItemId ? 'Choose another request below.' : 'Requests that need verification or a prerequisite are available below.'}</p></>}
      {next.length > 0 && <><h4>Coming up</h4>{next.map(item => <button className="ov-queue-next" key={item.id} type="button" onClick={() => send({ type: 'open-queue', itemId: item.id })}>{requestText(item.title)}<small>{item.kind === 'merge' ? 'Review' : 'Decision'}</small></button>)}</>}
      {secondary.length > 0 && <details><summary>Later & needs verification · {secondary.length}</summary>{secondary.map(item => <button type="button" className="ov-queue-next" key={item.id} onClick={() => send({ type: 'open-queue', itemId: item.id })}>{requestText(item.title)}<small>{item.readiness === 'future-or-conditional' ? 'Waiting on a prerequisite' : 'Needs verification'}</small></button>)}</details>}
    </>}
  </section>
}
