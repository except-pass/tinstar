import type { FailurePayload } from '../contract/needsyou'
import type { AttentionRow } from './model'
import { CardIdentity, cardAttrs, useAnswerState, type AttentionCommit } from './useAnswerState'

/** Failure card: the failed operation and a retry that is an inbox intent. */
export function FailureCard({ row, commit }: { row: AttentionRow; commit: AttentionCommit }) {
  const { view, pending, error, open, setOpen, run } = useAnswerState(row, commit)
  const payload = view.item.payload as FailurePayload
  return (
    <article {...cardAttrs(view, pending, 'FailureCard')}>
      <CardIdentity row={view} pending={pending} />
      <p data-region="operation">{payload.operation}: {payload.error}</p>
      <div data-region="primary">
        <button
          type="button"
          data-action="retry"
          disabled={pending}
          onClick={() => void run('attention.answer', { action: 'retry' }, 'retry')}
        >
          Retry
        </button>
        <button type="button" data-action="details" aria-expanded={open} onClick={() => setOpen(!open)}>
          Details
        </button>
      </div>
      {open ? (
        <div>
          <p>Evidence: {payload.evidence}</p>
          <ul>{payload.attempts.map(attempt => <li key={attempt}>{attempt}</li>)}</ul>
          <p>Next: {payload.proposedNextAction}</p>
        </div>
      ) : null}
      {error ? <p data-testid={`needsyou-error-${view.item.id}`} role="alert">{error}</p> : null}
    </article>
  )
}
