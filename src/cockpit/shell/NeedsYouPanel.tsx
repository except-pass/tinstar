import { useEffect, useRef, useState } from 'react'
import { Composer, Face } from './present'
import type { AttentionCard, Draft, OutboxMessage, SubmitResult, Worker } from './types'
import { reviewIdentity, separatePullReview, type ReviewItem, type ReviewView } from '../../shared/reviews'
import { apiFetch } from '../../apiClient'
import { useWorkSave } from '../../reconciliation/WorkActions'

function DeliverableReview({ item: initial, onOpen }: { item: ReviewItem; onOpen?: (id: string) => void }) {
  const [detail, setDetail] = useState<{ review: ReviewItem; sourceIdentity: string | null } | null>(null), [loadError, setLoadError] = useState<string | null>(null)
  const sourceIdentity = initial.submission ? reviewIdentity(initial.cardId, initial.submission) : null
  const item = detail && (sourceIdentity === detail.sourceIdentity || sourceIdentity === null || detail.review.submission && sourceIdentity === reviewIdentity(detail.review.cardId, detail.review.submission)) ? detail.review : initial
  async function loadEvidence() {
    try {
      const response = await apiFetch('/api/reconciliation/workflow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify({ operation: 'get', input: { card_id: item.cardId, details: true, refresh: true } }) })
      const body = await response.json()
      if (!response.ok || !body.ok || body.data?.outcome !== 'available' || !body.data.review) throw new Error('Current review unavailable')
      setDetail({ review: body.data.review, sourceIdentity }); setLoadError(null)
    } catch { setLoadError('Review evidence unavailable; open the canonical card and refresh before acting.') }
  }
  const [feedback, setFeedback] = useState(''), [remaining, setRemaining] = useState(''), [complete, setComplete] = useState(false)
  const knownSubmission = useRef<string | null>(null)
  useEffect(() => {
    if (!item.submission) return
    const identity = reviewIdentity(item.cardId, item.submission)
    if (knownSubmission.current && knownSubmission.current !== identity) { setFeedback(''); setRemaining(''); setComplete(false) }
    knownSubmission.current = identity
  }, [item.cardId, item.submission, item.submissionKey])
  const { save, busy, result } = useWorkSave(async () => {})
  const respond = (kind: 'accept_review' | 'request_review_changes') => save({ kind, card_id: item.cardId, submission_key: item.submissionKey,
    feedback: feedback.trim() || 'Will explicitly accepted this deliverable in Review.', remaining_scope: remaining.split('\n').map(line => line.trim()).filter(Boolean), scope_complete: complete })
  return <article className="cockpit-attention-card cockpit-attention-review" aria-label={item.title}>
    <div className="cockpit-attention-type"><span className="material-symbols-outlined" aria-hidden="true">rate_review</span><strong>Review Ready</strong><span>{item.status}</span></div>
    <h3>{item.title}</h3>
    <div className="cockpit-review-links">
      {onOpen ? <button type="button" onClick={() => onOpen(item.cardId)}>Open card</button> : <a href={item.cardUrl} target="_blank" rel="noopener noreferrer">Open card ↗</a>}
      {item.liveUrl && <a href={item.liveUrl} target="_blank" rel="noopener noreferrer">Open live feature ↗</a>}
      {item.evidenceUrls.map((url, index) => <a key={url + index} href={url} target="_blank" rel="noopener noreferrer">{index ? `Screenshot ${index}` : 'Evidence'} ↗</a>)}
    </div>
    {item.instructions && <p>{item.instructions}</p>}
    {item.evidenceWarning && <><p role="note">{item.evidenceWarning}</p><button type="button" onClick={() => void loadEvidence()}>Load current review evidence</button></>}
    {loadError && <p role="alert">{loadError}</p>}
    <label>Feedback<textarea value={feedback} onChange={event => setFeedback(event.target.value)} rows={2} /></label>
    <label>Remaining scope (one item per line)<textarea value={remaining} onChange={event => setRemaining(event.target.value)} rows={2} /></label>
    <label className="cockpit-review-check"><input type="checkbox" checked={complete} onChange={event => setComplete(event.target.checked)} />This card's full scope is finished; no dependencies remain.</label>
    <small>Approval records Will's acceptance. Unfinished scope keeps the card open with Firstmate.</small>
    <div className="cockpit-review-links">
      <button type="button" disabled={busy} onClick={() => void respond('accept_review')}>Approve deliverable</button>
      <button type="button" disabled={busy || !feedback.trim()} onClick={() => void respond('request_review_changes')}>Request changes</button>
    </div>
    {result && <p role="status">{result.message}</p>}
  </article>
}

export const attentionLabels = { decision: 'Decision', blocked: 'Blocked', failure: 'Failure', review: 'Review Ready' } as const
export const attentionIcons = { decision: 'help', blocked: 'front_hand', failure: 'error', review: 'rate_review' } as const

export function dismissNote(card: AttentionCard): string {
  const key = card.decisionKey ?? ''
  return card.taskId ? `Dismiss decision ${key} on task ${card.taskId}.` : `Dismiss decision ${key}.`
}

export function sameDismiss(card: AttentionCard, message: OutboxMessage): boolean {
  return message.kind === 'answer' && message.home === card.home && message.text === dismissNote(card) && message.taskId === card.taskId && message.decisionKey === card.decisionKey
}

export function SlideToDismiss({ onConfirm }: { onConfirm: () => void }) {
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

export function NeedsYouPanel({ cards, workers, errors, waiting, submit, dismissing, dismissed, dismissError, onOpen, onDismiss, reviews, onCardOpen }: {
  reviews?: ReviewView
  onCardOpen?: (id: string) => void
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
  cards = cards.filter(card => card.type !== 'review' || !reviews || separatePullReview(card.prUrl, card.reviewStatus, reviews))
  return <div className="cockpit-attention-list" aria-label="Needs You">
    {errors.length > 0 && <p className="cockpit-attention-empty" role="alert">Needs You unavailable — {errors.join('; ')}</p>}
    {reviews?.warning && <p role="status">{reviews.warning}</p>}
    {reviews?.items.map(item => <DeliverableReview key={item.cardId} item={item} onOpen={onCardOpen} />)}
    {cards.length ? cards.map(card => <AttentionCardView key={card.key} card={card} worker={workers.find(worker => worker.key === card.workerKey) ?? null} open={() => onOpen(card)} submit={submit} dismissing={dismissing(card)} dismissed={dismissed(card)} dismissError={dismissError(card)} onDismiss={onDismiss} />)
      : errors.length > 0 || reviews?.items.length || reviews && !reviews.complete ? null : <p className="cockpit-attention-empty">{waiting ? 'Loading Needs You…' : 'Nothing needs you right now.'}</p>}
  </div>
}
