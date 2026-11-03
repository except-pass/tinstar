import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'
import type { PresentationAction, PresentationState } from './presentation'

/** S4 supplies ordered readiness; absence of that source is visible, never a
 * fabricated empty queue. Opening a card remains useful independently. */
export function QueuePanel({ state, send }: { state: PresentationState; send: (action: PresentationAction) => void }) {
  const [context, setContext] = useState<{ outcome?: string; blocks?: Array<{ id: string; text: string }> } | null>(null)
  useEffect(() => {
    setContext(null)
    if (!state.queueOpen || !state.queueCardId) return
    const controller = new AbortController()
    void apiFetch(`/api/reconciliation/card-context?id=${encodeURIComponent(state.queueCardId)}`, { signal: controller.signal })
      .then(res => res.json()).then(body => { if (!controller.signal.aborted) setContext(body.ok ? body.data : { outcome: 'unavailable' }) })
      .catch(() => { if (!controller.signal.aborted) setContext({ outcome: 'unavailable' }) })
    return () => controller.abort()
  }, [state.queueOpen, state.queueCardId])
  if (!state.queueOpen) return null
  return <section className="floor-coverage" aria-label="Your desk">
    <strong>{state.queueCardId ? `Card ${state.queueCardId}` : 'Your desk'}</strong>
    <span>Queue source unavailable in this build. No readiness or absence conclusions.</span>
    {state.queueCardId && <><span>Card context: {context?.outcome ?? 'reading'}</span>{context?.blocks?.map(block => <p key={block.id}>{block.text}</p>)}</>}
    <button type="button" onClick={() => send({ type: 'close-queue' })}>Close desk</button>
  </section>
}
