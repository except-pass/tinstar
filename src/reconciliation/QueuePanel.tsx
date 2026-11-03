import { useEffect, useState, type ReactNode } from 'react'
import { apiFetch } from '../apiClient'
import { decisionItems, type DeskQueue } from '../shared/reconciliationQueue'
import type { QueueItem } from '../server/reconciliation/queue'
import type { PresentationAction, PresentationState } from './presentation'

export function QueuePanel({ state, send, queue, error, now, requestControls }: { state: PresentationState; send: (action: PresentationAction) => void; queue: DeskQueue | null; error: string | null; now: number; requestControls?: (executionIds: string[], decisionKeys: string[]) => ReactNode }) {
  const ready = (item: QueueItem) => !error && item.readiness === 'ready-now' && item.sources.every(s => ['fresh', 'partial'].includes(s.status) && (!s.expiresAt || Date.parse(s.expiresAt) > now))
  const items = queue ? decisionItems(queue, now) : []
  const actionable = items.filter(ready)
  const selected = queue?.items.find(item => item.id === state.queueItemId) ?? (!state.queueItemId ? actionable[0] : undefined)
  const index = items.findIndex(item => item.id === selected?.id)
  const cardId = state.queueCardId
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
  const next = actionable.filter(item => item.id !== selected?.id).slice(Math.max(0, actionable.findIndex(item => item.id === selected?.id)), Math.max(0, actionable.findIndex(item => item.id === selected?.id)) + 3)
  const secondary = queue?.items.filter(item => !ready(item)) ?? []
  return <section className="ov-queue" aria-label="Desk queue" data-queue-item-id={selected?.id ?? ''}>
    {cardId ? <><button type="button" className="ov-back" onClick={() => send({ type: 'close-queue' })}>← Your desk</button><h3>Card context</h3><p>{context?.outcome === 'available' ? '' : context?.outcome === 'unavailable' ? 'Card unavailable. Try the source link.' : 'Reading card…'}</p>{context?.blocks?.map(block => <p key={block.id}>{block.text}</p>)}</> : <>
      {selected ? <><small className="ov-eyebrow">{ready(selected) ? selected.kind === 'merge' ? 'Review' : 'Decision' : 'Needs verification'}</small><h3>{selected.title}</h3><p>{selected.action ?? 'Read the source request for context.'}</p>
        {!ready(selected) && <p>Confirm the next actor and prerequisites before acting.</p>}
        {selected.evidence.map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer">{e.kind === 'pull-request' ? 'Read pull request' : e.kind === 'card' ? 'Read card' : 'Read evidence'} ↗</a>)}
        <div className="ov-queue-actions"><button type="button" disabled={index <= 0} onClick={() => send({ type: 'navigate-queue', direction: 'previous' })}>← Previous</button><button type="button" disabled={index >= items.length - 1} onClick={() => send({ type: 'navigate-queue', direction: 'next' })}>Next →</button></div>
        {requestControls?.(selected.executionIds, selected.decisionKeys)}
        <details><summary>Request sources & readiness</summary><pre>{JSON.stringify(selected, null, 2)}</pre></details>
      </> : <><h3>{!queue || error ? 'Desk unavailable' : 'No verified request ready'}</h3><p>{!queue || error ? 'Last known requests stay available below.' : 'Requests that need verification or a prerequisite are available below.'}</p></>}
      {next.length > 0 && <><h4>Coming up</h4>{next.map(item => <button className="ov-queue-next" key={item.id} type="button" onClick={() => send({ type: 'open-queue', itemId: item.id })}>{item.title}<small>{item.kind === 'merge' ? 'Review' : 'Decision'}</small></button>)}</>}
      {secondary.length > 0 && <details><summary>Later & needs verification · {secondary.length}</summary>{secondary.map(item => <button type="button" className="ov-queue-next" key={item.id} onClick={() => send({ type: 'open-queue', itemId: item.id })}>{item.title}<small>{item.readiness === 'future-or-conditional' ? 'Waiting on a prerequisite' : 'Needs verification'}</small></button>)}</details>}
    </>}
  </section>
}
