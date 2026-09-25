import type { ScheduleDriftPayload } from '../contract/needsyou'
import { formatDuration, type AttentionRow } from './model'
import { CardIdentity, cardAttrs, useAnswerState, type AttentionCommit } from './useAnswerState'

/** Schedule-drift card: planned versus elapsed, and work continues. */
export function ScheduleDriftCard({ row, commit }: { row: AttentionRow; commit: AttentionCommit }) {
  const { view, pending, error, open, setOpen, run } = useAnswerState(row, commit)
  const payload = view.item.payload as ScheduleDriftPayload
  const overrun = payload.elapsedMs - payload.plannedMs
  const progress = typeof payload.lastProgress === 'string' ? payload.lastProgress : 'last progress unknown'
  return (
    <article {...cardAttrs(view, pending, 'ScheduleDriftCard')}>
      <CardIdentity row={view} pending={pending} />
      <div
        data-region="clock"
        data-planned-ms={payload.plannedMs}
        data-elapsed-ms={payload.elapsedMs}
        data-continues={payload.continues ? 'true' : 'false'}
      >
        <p>Planned {formatDuration(payload.plannedMs)} · elapsed {formatDuration(payload.elapsedMs)} · overrun {formatDuration(overrun)}</p>
        <p>Activity: {payload.activity}</p>
        <p>{progress}</p>
      </div>
      <p data-region="continues">Work continues</p>
      <div data-region="primary">
        <button
          type="button"
          data-action="acknowledge"
          disabled={pending}
          onClick={() => void run('schedule.acknowledge', { acknowledge: true }, 'acknowledge')}
        >
          Acknowledge
        </button>
        <button type="button" data-action="details" aria-expanded={open} onClick={() => setOpen(!open)}>
          Inspect
        </button>
      </div>
      {open ? (
        <div>
          <p>Baseline {payload.plannedMs} ms</p>
          <p>Evidence: {payload.evidence}</p>
          <p>Explanation: {payload.explanation}</p>
        </div>
      ) : null}
      {view.acknowledgement ? (
        <p data-testid={`needsyou-ack-${view.item.id}`}>acknowledged {view.acknowledgement.delivery}</p>
      ) : null}
      {error ? <p data-testid={`needsyou-error-${view.item.id}`} role="alert">{error}</p> : null}
    </article>
  )
}
