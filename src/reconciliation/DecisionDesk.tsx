import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useDecisionDesk } from './useDecisionDesk'
import { useDeskWorkspace } from '../ask/DeskWorkspace'
import { WorkerNotes } from '../cockpit/shell/present'
import { cardSourceUrl } from '../shared/workIdentity'
import type { DecisionPacket } from '../shared/decisionPacket'
import { refillSize } from '../shared/decisionDeskQueue'
import './decision-desk.css'

const safeLink = (url: string) => {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? url : undefined } catch { return undefined }
}

function SourceLinks({ packet }: { packet: DecisionPacket }) {
  return <section className="dd-section">
    <a className="dd-reference" href={cardSourceUrl(packet.card_id)} target="_blank" rel="noreferrer">Open card ↗</a>
    {packet.links.map(({ url, label }, index) => {
      const href = safeLink(url)
      return href ? <a key={index} className="dd-reference" href={href} target="_blank" rel="noreferrer">{label} ↗</a> : null
    })}
  </section>
}

export function DecisionDesk() {
  const workspace = useDeskWorkspace()
  const intent = workspace.decisionTarget
  const entries = workspace.queue?.needsWill ?? workspace.queue?.items ?? []
  const target = intent ? { ...intent, cardId: intent.cardId ?? entries.find(item => item.id === intent.requestKey)?.cardIds[0] } : undefined
  const desk = useDecisionDesk(target, workspace.consumeDecisionTarget)
  const [tab, setTab] = useState<'review' | 'preparation'>('review')
  const packet = desk.claim?.packet?.packet
  const counts = desk.snapshot?.counts
  const retained = (workspace.messages ?? []).filter(message => message.kind === 'message' &&
    !(workspace.workers ?? []).some(worker => worker.home === message.home && worker.id === message.taskId))

  return <section className="decision-desk" aria-label="Decision Desk" data-presentation-scene data-scene-id={workspace.connection?.scene_id} data-revision={workspace.state?.revision}>
    <header className="dd-top">
      <div className="dd-brand">Tin Star <span className="dd-slash">/</span> <strong>Decision Desk</strong></div>
      <nav aria-label="Decision Desk views">
        <button type="button" aria-current={tab === 'review' ? 'page' : undefined} onClick={() => setTab('review')}>Review</button>
        <button type="button" aria-current={tab === 'preparation' ? 'page' : undefined} onClick={() => setTab('preparation')}>Preparation</button>
      </nav>
    </header>
    <div className="dd-status" aria-label="Queue status">
      <span>Ready <b>{counts ? `${counts.ready} / ${refillSize}` : '—'}</b></span>
      <span>Preparing <b>{counts?.preparing ?? '—'}</b></span>
      <span>Leased <b>{counts?.leased ?? '—'}</b></span>
    </div>
    {!desk.snapshot && <p className="dd-coverage">Queue status unavailable.</p>}
    {desk.snapshot?.omissions?.map(text => <p className="dd-coverage" key={text}>{text}</p>)}
    {tab === 'preparation' ? <main className="dd-preparation">
      <h1>Preparation</h1>
      <p>{desk.snapshot?.runner?.explanation ?? 'Loading the queue…'}</p>
      <ul>{desk.snapshot?.pending?.map(row => <li key={row.card_id}><a href={cardSourceUrl(row.card_id)} target="_blank" rel="noreferrer">{row.title}</a> · {row.state}</li>)}</ul>
      {!!retained.length && <details className="dd-rules">
        <summary>Source delivery details</summary>
        <WorkerNotes messages={retained} submit={workspace.submit} />
      </details>}
    </main> : <div className="dd-layout">
      <aside className="dd-rail" aria-label="Ready cards">
        <h2 className="dd-eyebrow">Ready cards</h2>
        {desk.snapshot?.ready?.map(item => <button className="dd-ready-row" key={item.id} type="button" disabled={desk.busy || desk.saving || !!desk.claim?.lease}
          onClick={() => void desk.claimCard(item.card_id)}>{item.title}</button>)}
      </aside>
      <main className="dd-main">
        {desk.message && <p className="dd-notice" role="status">{desk.message}</p>}
        {packet ? <form className="dd-review-content" onSubmit={event => { event.preventDefault(); void desk.submit() }}>
          <h1 className="dd-identifiers" data-semantic-id={`card:${packet.card_id}`}>{packet.title}</h1>
          <ReactMarkdown skipHtml allowedElements={['p', 'ul', 'ol', 'li', 'em', 'strong', 'code', 'blockquote', 'h2', 'h3']} unwrapDisallowed>{packet.summary}</ReactMarkdown>
          <section className="dd-recommendation">
            <h2 className="dd-eyebrow">Recommendation</h2>
            <p>{packet.recommendation}</p>
          </section>
          <fieldset className="dd-choices" disabled={desk.busy || desk.saving}>
            <legend>Choose an option</legend>
            {packet.options.map(option => <label key={option.id} className={`dd-option ${desk.option === option.id ? 'dd-selected' : ''}`}>
              <input type="radio" name="decision-option" checked={desk.option === option.id} onChange={() => desk.setOption(option.id)} />
              <span>{option.label}</span>
            </label>)}
          </fieldset>
          <label className="dd-section">Your answer
            <textarea value={desk.answer} onChange={event => desk.setAnswer(event.target.value)} maxLength={12000} disabled={desk.saving || desk.busy} />
          </label>
          <details className="dd-inline-evidence"><summary>Source links</summary><SourceLinks packet={packet} /></details>
          <div className="dd-actions">
            <button className="dd-secondary" type="button" disabled={desk.busy || desk.saving} onClick={() => void desk.release('skip')}>Skip</button>
            <button className="dd-primary" type="submit" disabled={desk.busy || !desk.saving && (!desk.option || !desk.answer.trim())}>
              {desk.saving ? 'Retry save' : 'Record answer & next'}
            </button>
          </div>
        </form> : <div className="dd-empty">
          <h1>{desk.busy ? 'Opening decision…' : desk.claim?.code === 'card-held' ? 'This decision is held by another review session.' : desk.claim?.lease ? 'Card changed or unavailable' : !desk.claim && desk.message ? 'Decision Desk unavailable.' : 'No prepared decision open'}</h1>
          {desk.saving ? <button className="dd-primary" type="button" disabled={desk.busy} onClick={() => void desk.submit()}>Retry save</button> :
            <div className="dd-modal-actions">
              {desk.claim?.lease_token && <button className="dd-secondary" type="button" disabled={desk.busy} onClick={() => void desk.release('release')}>Release card</button>}
              <button className="dd-primary" type="button" disabled={desk.busy} onClick={() => {
                if (target) workspace.consumeDecisionTarget(target.id)
                workspace.clearOrigin?.()
                void desk.claimCard()
              }}>{desk.claim?.lease && !desk.claim.code ? 'Retry card' : 'Claim next prepared decision'}</button>
              {desk.lastCard && !desk.claim?.lease_token && <button className="dd-secondary" type="button" disabled={desk.busy}
                onClick={() => void desk.claimCard(desk.lastCard)}>Try this decision again</button>}
            </div>}
        </div>}
      </main>
    </div>}
  </section>
}
