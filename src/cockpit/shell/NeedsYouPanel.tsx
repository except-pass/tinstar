import { useRef, useState } from 'react'
import { Composer, Face } from './present'
import type { AttentionCard, Draft, OutboxMessage, SubmitResult, Worker } from './types'

export const attentionLabels = { decision: 'Decision', blocked: 'Blocked', failure: 'Failure', review: 'Review Ready' } as const
export const attentionIcons = { decision: 'help', blocked: 'front_hand', failure: 'error', review: 'rate_review' } as const

export function dismissNote(card: AttentionCard): string {
  const key = card.decisionKey ?? ''
  return card.taskId ? `Dismiss decision ${key} on task ${card.taskId}.` : `Dismiss decision ${key}.`
}

export function sameDismiss(card: AttentionCard, message: OutboxMessage): boolean {
  return message.kind === 'answer' && message.home === card.home && message.text === dismissNote(card) && message.taskId === card.taskId && message.decisionKey === card.decisionKey
}

function SlideToDismiss({ onConfirm }: { onConfirm: () => void }) {
  const track = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLSpanElement>(null)
  const pos = useRef(0)
  const dragging = useRef(false)
  const [x, setX] = useState(0)
  const [travel, setTravel] = useState(1)

  const limit = () => {
    const width = track.current?.clientWidth ?? 0
    const knobWidth = knob.current?.offsetWidth ?? 0
    return width > 0 ? Math.max(0, width - knobWidth - 4) : 0
  }
  const moveTo = (next: number) => {
    const max = limit()
    const clamped = Math.min(max, Math.max(0, next))
    pos.current = clamped
    setTravel(max || 1)
    setX(clamped)
    return { clamped, max }
  }
  const reset = () => { pos.current = 0; setX(0) }
  const release = () => {
    const max = limit()
    const confirmed = max > 0 && pos.current >= max - 4
    reset()
    if (confirmed) onConfirm()
  }

  return <div
    className="cockpit-slide"
    ref={track}
    role="slider"
    tabIndex={0}
    aria-label="Slide to dismiss"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.min(100, Math.round((x / travel) * 100))}
    onKeyDown={event => {
      const max = limit()
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        event.preventDefault()
        const { clamped, max: travelMax } = moveTo(pos.current + max / 6)
        if (travelMax > 0 && clamped >= travelMax - 4) { reset(); onConfirm() }
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'Home' || event.key === 'Escape') {
        event.preventDefault()
        reset()
      } else if (event.key === ' ' || event.key === 'Enter') event.preventDefault()
    }}
    onBlur={() => { if (!dragging.current) reset() }}
  >
    <span className="cockpit-slide-label">Slide to dismiss</span>
    <span
      ref={knob}
      className={`cockpit-slide-knob${dragging.current ? ' dragging' : ''}`}
      style={{ transform: `translateX(${x}px)` }}
      onPointerDown={event => {
        if (event.button !== 0) return
        dragging.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        event.preventDefault()
      }}
      onPointerMove={event => {
        if (!dragging.current || !track.current) return
        const rect = track.current.getBoundingClientRect()
        moveTo(event.clientX - rect.left - 2 - (knob.current?.offsetWidth ?? 0) / 2)
      }}
      onPointerUp={() => { if (!dragging.current) return; dragging.current = false; release() }}
      onPointerCancel={() => { dragging.current = false; reset() }}
    />
  </div>
}

function DismissControl({ card, held, dismissed, error, onDismiss }: { card: AttentionCard; held: boolean; dismissed: boolean; error: string | null; onDismiss: (card: AttentionCard) => void }) {
  if (card.type !== 'decision' || !card.decisionKey) return null
  if (dismissed) return <p className="cockpit-dismissed" role="status">dismissed</p>
  if (held) return <p className="cockpit-dismissing" role="status">dismissing…</p>
  return <>
    <SlideToDismiss onConfirm={() => onDismiss(card)} />
    {error && <p className="cockpit-dismiss-error" role="alert">{error}</p>}
  </>
}

export function AttentionCardView({ card, worker, open, submit, dismissing, dismissed, dismissError, onDismiss }: {
  card: AttentionCard; worker: Worker | null; open: () => void; submit: (draft: Draft) => Promise<SubmitResult>
  dismissing: boolean; dismissed: boolean; dismissError: string | null; onDismiss: (card: AttentionCard) => void
}) {
  const origin = worker ? <span className="cockpit-attention-origin"><Face worker={worker} size={25} /><span>{worker.id}</span></span>
    : <span className="cockpit-attention-origin cockpit-attention-origin-empty"><span className="material-symbols-outlined">account_tree</span>First Mate backlog</span>
  return <article className={`cockpit-attention-card cockpit-attention-${card.type}`}>
    <div className="cockpit-attention-type"><span className="material-symbols-outlined" aria-hidden="true">{attentionIcons[card.type]}</span><strong>{attentionLabels[card.type]}</strong></div>
    {card.type === 'review' ? <>
      <div className="cockpit-attention-review-ref"><span>{card.repository}</span><strong>#{card.prNumber}</strong></div>
      <p title={card.headline}>{card.headline}</p>
      <div className="cockpit-attention-review-meta"><span>CI {card.ci}</span>{card.reviewStatus === 'unknown' && <span>PR status unknown</span>}</div>
      <div className="cockpit-attention-bottom">{origin}<a className="cockpit-attention-action" href={card.prUrl!} target="_blank" rel="noopener noreferrer">Open GitHub ↗</a></div>
      <button type="button" className="cockpit-attention-message-link" onClick={open}>Tell First Mate about this</button>
    </> : <>
      <p title={card.headline}>{card.headline}</p>
      {card.type === 'decision' && <small className="cockpit-attention-age">Age {card.ageDays === null ? 'unknown' : `${card.ageDays}d`}</small>}
      {card.type === 'blocked' && card.detail && <small className="cockpit-attention-needed">NEEDED · {card.detail}</small>}
      {card.type === 'failure' && card.detail && <small className="cockpit-attention-failure-detail">{card.detail}</small>}
      <div className="cockpit-attention-bottom">{origin}<button type="button" className="cockpit-attention-action" onClick={open}>Open →</button></div>
      {card.type === 'decision' && <details className="cockpit-card-composer"><summary>Answer</summary><Composer anchorKey={card.key} kind="answer" submit={submit} /></details>}
      <DismissControl card={card} held={dismissing} dismissed={dismissed} error={dismissError} onDismiss={onDismiss} />
      <button type="button" className="cockpit-attention-message-link" onClick={open}>Tell First Mate about this</button>
    </>}
  </article>
}

export function NeedsYouPanel({ cards, workers, errors, waiting, submit, dismissing, dismissed, dismissError, onOpen, onDismiss }: {
  cards: AttentionCard[]
  workers: Worker[]
  errors: string[]
  waiting: boolean
  submit: (draft: Draft) => Promise<SubmitResult>
  dismissing: (card: AttentionCard) => boolean
  dismissed: (card: AttentionCard) => boolean
  dismissError: (card: AttentionCard) => string | null
  onOpen: (card: AttentionCard) => void
  onDismiss: (card: AttentionCard) => void
}) {
  return <div className="cockpit-attention-list" aria-label="Needs You">
    {errors.length > 0 && <p className="cockpit-attention-empty" role="alert">Needs You unavailable — {errors.join('; ')}</p>}
    {cards.length ? cards.map(card => <AttentionCardView key={card.key} card={card} worker={workers.find(worker => worker.key === card.workerKey) ?? null} open={() => onOpen(card)} submit={submit} dismissing={dismissing(card)} dismissed={dismissed(card)} dismissError={dismissError(card)} onDismiss={onDismiss} />)
      : errors.length > 0 ? null : <p className="cockpit-attention-empty">{waiting ? 'Loading Needs You…' : 'Nothing needs you right now.'}</p>}
  </div>
}
