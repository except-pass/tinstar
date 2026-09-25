import type { ReviewReadyPayload } from '../contract/needsyou'
import type { AttentionRow } from './model'
import { CardIdentity, cardAttrs, useAnswerState, type AttentionCommit } from './useAnswerState'

function ciPresentation(ci: string | undefined): { text: string; known: 'success' | 'failure' | 'pending' | 'unknown'; className: string } {
  if (ci === 'success') return { text: 'CI success', known: 'success', className: 'text-accent-green' }
  if (ci === 'failure') return { text: 'CI failure', known: 'failure', className: 'text-accent-red' }
  if (ci === 'pending') return { text: 'CI pending', known: 'pending', className: 'text-ink-mid' }
  return { text: 'CI unknown', known: 'unknown', className: 'text-ink-low' }
}

/** Review card: headline, repository, number, and an https link. A click is not an answer. */
export function ReviewReadyCard({ row, commit }: { row: AttentionRow; commit: AttentionCommit }) {
  const { view, pending, error } = useAnswerState(row, commit)
  const payload = view.item.payload as ReviewReadyPayload
  const shown = ciPresentation(view.ci)
  const pr = payload.pr
  const https = pr !== undefined && pr.url.startsWith('https://')
  return (
    <article {...cardAttrs(view, pending, 'ReviewReadyCard')}>
      <CardIdentity row={view} pending={pending} />
      <div data-region="pull-request">
        {pr && https ? (
          <>
            <p data-testid={`review-repo-${view.item.id}`}>{pr.repo}</p>
            <p data-testid={`review-number-${view.item.id}`}>#{pr.number}</p>
            <a
              data-region="primary"
              data-action="open-review"
              data-testid={`review-link-${view.item.id}`}
              href={pr.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open pull request
            </a>
          </>
        ) : (
          <p data-region="primary">{payload.summary} · {payload.target}</p>
        )}
      </div>
      <p data-region="ci" data-testid={`review-ci-${view.item.id}`} data-ci={shown.known} className={shown.className}>
        {shown.text}
      </p>
      <p>{payload.summary}</p>
      {error ? <p data-testid={`needsyou-error-${view.item.id}`} role="alert">{error}</p> : null}
    </article>
  )
}
