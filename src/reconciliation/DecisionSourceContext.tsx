import { cardSourceUrl, isJiraCard } from '../shared/workIdentity'
import { useEffect, useState } from 'react'
import { useDeskWorkspace } from '../ask/DeskWorkspace'
import { apiFetch } from '../apiClient'
import { cardTitle } from './overviewModel'
import { displayRequestText } from './requestText'
import './decisions.css'

export function DecisionCardContext({ id }: { id: string }) {
  const { scene } = useDeskWorkspace()
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
    <a href={cardSourceUrl(id)} target="_blank" rel="noreferrer">Read {isJiraCard(id) ? 'Jira' : 'Notion'} card ↗{card ? ` · ${cardTitle(card)}` : ''}</a>
    {context?.outcome === 'unavailable' && <p>Source details are unavailable. Use the source link.</p>}
    {!!context?.blocks?.length && <details className="decisions-evidence" open><summary>Question, choices and evidence</summary>{context.blocks.map(block => <p key={block.id}>{displayRequestText(block.text, 'Additional source details are available in Technical details.')}</p>)}</details>}
  </section>
}
