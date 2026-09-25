import { useState } from 'react'
import type { ContradictionPayload } from '../contract/needsyou'
import type { AttentionRow } from './model'
import { CardIdentity, cardAttrs, useAnswerState, type AttentionCommit } from './useAnswerState'

/** Contradiction card: two claims side by side. Blocking is read from the payload. */
export function ContradictionCard({ row, commit }: { row: AttentionRow; commit: AttentionCommit }) {
  const { view, pending, error, open, setOpen, run } = useAnswerState(row, commit)
  const payload = view.item.payload as ContradictionPayload
  const [judgment, setJudgment] = useState('')
  return (
    <article {...cardAttrs(view, pending, 'ContradictionCard')}>
      <CardIdentity row={view} pending={pending} />
      <div data-region="claims" data-testid={`contradiction-claims-${view.item.id}`} className="grid grid-cols-2 gap-2">
        <p>Claim A: {payload.a.claim}</p>
        <p>Claim B: {payload.b.claim}</p>
        <p className="col-span-2">{payload.blocking ? 'blocking' : 'not blocking'}</p>
      </div>
      <div data-region="primary">
        <button type="button" data-action="compare" aria-expanded={open} onClick={() => setOpen(true)}>
          Compare
        </button>
      </div>
      {open ? (
        <div data-testid={`contradiction-evidence-${view.item.id}`} className="grid grid-cols-2 gap-2">
          <p>Evidence A: {payload.a.evidence}</p>
          <p>Evidence B: {payload.b.evidence}</p>
          <p>Source A: {payload.a.source}</p>
          <p>Source B: {payload.b.source}</p>
          <p className="col-span-2">Impact: {payload.impact}</p>
          <form
            className="col-span-2"
            onSubmit={event => {
              event.preventDefault()
              void run('attention.answer', { judgment }, 'judgment')
            }}
          >
            <textarea data-testid={`contradiction-judgment-${view.item.id}`} value={judgment} onChange={event => setJudgment(event.target.value)} />
            <button type="submit" disabled={pending}>Record judgment</button>
          </form>
        </div>
      ) : null}
      {error ? <p data-testid={`needsyou-error-${view.item.id}`} role="alert">{error}</p> : null}
    </article>
  )
}
