import { useState } from 'react'
import type { BlockedPayload } from '../contract/needsyou'
import type { AttentionRow } from './model'
import { CardIdentity, cardAttrs, useAnswerState, type AttentionCommit } from './useAnswerState'

/** Blocked card: what is needed, why, and a supply field. Not a choice between options. */
export function BlockedCard({ row, commit }: { row: AttentionRow; commit: AttentionCommit }) {
  const { view, pending, error, open, setOpen, run } = useAnswerState(row, commit)
  const payload = view.item.payload as BlockedPayload
  const [supplied, setSupplied] = useState('')
  const [supplying, setSupplying] = useState(false)
  return (
    <article {...cardAttrs(view, pending, 'BlockedCard')}>
      <CardIdentity row={view} pending={pending} />
      <p data-region="needed">Needed: {payload.needed}</p>
      <p data-region="why">Why: {payload.why}</p>
      <div data-region="primary">
        <button type="button" data-action="supply" disabled={pending} onClick={() => setSupplying(true)}>
          Supply
        </button>
        <button type="button" data-action="details" aria-expanded={open} onClick={() => setOpen(!open)}>
          Details
        </button>
      </div>
      {supplying ? (
        <form
          onSubmit={event => {
            event.preventDefault()
            void run('attention.answer', { supplied }, 'supply')
          }}
        >
          <textarea data-testid={`blocked-supply-${view.item.id}`} value={supplied} onChange={event => setSupplied(event.target.value)} />
          <button type="submit" disabled={pending}>Send</button>
        </form>
      ) : null}
      {open ? (
        <div>
          <ul>{payload.attempts.map(attempt => <li key={attempt}>{attempt}</li>)}</ul>
          <p>Unblock: {payload.unblockCondition}</p>
        </div>
      ) : null}
      {error ? <p data-testid={`needsyou-error-${view.item.id}`} role="alert">{error}</p> : null}
    </article>
  )
}
