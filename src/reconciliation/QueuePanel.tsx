import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import { decisionItems, type DeskQueue } from '../shared/reconciliationQueue'
import type { QueueItem } from '../server/reconciliation/queue'
import type { PresentationAction, PresentationState } from './presentation'

export function QueuePanel({ state, send, queue, error, now }: { state: PresentationState; send: (action: PresentationAction) => void; queue: DeskQueue | null; error: string | null; now: number }) {
  const items = queue ? decisionItems(queue) : []
  const selected = queue?.items.find(item => item.id === state.queueItemId)
  const index = items.findIndex(item => item.id === state.queueItemId)
  const cardId = state.queueCardId ?? selected?.cardIds[0]
  const [context, setContext] = useState<{ outcome?: string; blocks?: Array<{ id: string; text: string }> } | null>(null)
  const desk = useRef<HTMLElement>(null)
  const readiness = (item: QueueItem) => item.readiness === 'future-or-conditional' ? item.readiness : error || item.sources.some(s => s.status === 'stale' || s.status === 'unknown' || !!s.expiresAt && Date.parse(s.expiresAt) <= now)
    ? 'needs-readiness-verification · last-known source' : item.readiness
  useEffect(() => {
    if (state.queueOpen) desk.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }, [state.queueOpen, state.queueItemId, state.queueCardId])
  useEffect(() => {
    setContext(null)
    if (!state.queueOpen || !cardId) return
    const controller = new AbortController()
    void apiFetch(`/api/reconciliation/card-context?id=${encodeURIComponent(cardId)}`, { signal: controller.signal })
      .then(res => res.json()).then(body => { if (!controller.signal.aborted) setContext(body.ok ? body.data : { outcome: 'unavailable' }) })
      .catch(() => { if (!controller.signal.aborted) setContext({ outcome: 'unavailable' }) })
    return () => controller.abort()
  }, [state.queueOpen, cardId])
  if (!state.queueOpen) return <section className="floor-desk" aria-label="Desk preview">
    <strong>Your desk · {queue ? `${items.length} ready / verification candidates` : 'queue source unavailable'}</strong>
    {error && <span>{error}</span>}
    {items.slice(0, 3).map(item => <button key={item.id} type="button" onClick={() => send({ type: 'open-queue', itemId: item.id })}>{item.title} · {readiness(item)}</button>)}
    <span>Presentation only. Future items stay in their work context; no empty queue all-clear.</span>
  </section>
  return <section className="floor-desk" aria-label="Your desk" ref={desk} data-queue-item-id={state.queueItemId ?? ''}>
    <strong>{state.queueCardId ? `Card ${state.queueCardId}` : selected?.title ?? 'Your desk'}</strong>
    {error && <span>{error}</span>}
    {!queue && <span>Queue source unavailable. No readiness or absence conclusions.</span>}
    {selected && <><span>{readiness(selected)} · {selected.kind}</span><p>{selected.action ?? 'Concrete next action requires verification'}</p>{selected.reasons.map(reason => <span key={reason}>{reason}</span>)}
      <span>Checkpoint {selected.checkpoint ?? 'not published'} · {selected.sources.map(s => `${s.kind}: ${s.status}, observed ${s.observedAt ?? 'unknown'}`).join(' · ')}</span>
      {selected.evidence.map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer">{e.kind}: {e.url}</a>)}
    </>}
    {queue && !selected && !state.queueCardId && <span>{state.queueItemId ? 'Selected decision is no longer in the current queue. No completion inferred.' : 'No ready or verification candidates in the configured observations. This does not certify all-clear.'}</span>}
    <div><button type="button" disabled={index <= 0} onClick={() => send({ type: 'navigate-queue', direction: 'previous' })}>Previous item</button>
      <button type="button" disabled={!items.length || index >= items.length - 1} onClick={() => send({ type: 'navigate-queue', direction: 'next' })}>Next item</button>
      <button type="button" onClick={() => send({ type: 'close-queue' })}>Close desk</button></div>
    <div>{items.slice(Math.max(0, index + 1), Math.max(0, index + 1) + 3).map(item => <button key={item.id} type="button" onClick={() => send({ type: 'open-queue', itemId: item.id })}>{item.title} · {readiness(item)}</button>)}</div>
    {cardId && <details open={!!state.queueCardId}><summary>Card context · {context?.outcome ?? 'reading'} · {cardId}</summary>{context?.blocks?.map(block => <p key={block.id}>{block.text}</p>)}</details>}
    {queue && <details><summary>Future / conditional · {queue.items.length - items.length}</summary>{queue.items.filter(item => item.readiness === 'future-or-conditional').map(item => <p key={item.id}>{item.title} · {item.action ?? 'No concrete action'} · {item.reasons.join('; ')}</p>)}</details>}
  </section>
}
