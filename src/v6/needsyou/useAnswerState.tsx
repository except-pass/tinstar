import { useEffect, useState } from 'react'
import type { NeedsYouType } from '../contract/needsyou'
import { NeedsYouIcon } from './icons'
import {
  TYPE_LABEL,
  impactLabel,
  originParts,
  visibleStatus,
  type AnswerKind,
  type AttentionRow,
} from './model'

export type AttentionCommit = (
  row: AttentionRow,
  kind: AnswerKind,
  body: Record<string, unknown>,
  key: string,
) => Promise<{ row: AttentionRow; error: string | null }>

const TYPE_CLASS: Record<NeedsYouType, string> = {
  decision: 'text-hue-open',
  blocked: 'text-hue-waiting',
  failure: 'text-hue-error',
  'schedule-drift': 'text-hue-discussing',
  contradiction: 'text-hue-superseded',
  'review-ready': 'text-primary',
}

export function useAnswerState(row: AttentionRow, commit: AttentionCommit) {
  const [view, setView] = useState(row)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setView(row)
  }, [row])

  async function run(kind: AnswerKind, body: Record<string, unknown>, key: string) {
    setPending(true)
    setError(null)
    try {
      const result = await commit(view, kind, body, key)
      setView(result.row)
      setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'answer failed')
    } finally {
      setPending(false)
    }
  }

  return { view, pending, error: error ?? view.lastError, open, setOpen, run }
}

export function cardAttrs(row: AttentionRow, pending: boolean, component: string) {
  const status = pending ? 'pending' : visibleStatus(row)
  return {
    'data-testid': `needsyou-card-${row.item.id}`,
    'data-type': row.item.type,
    'data-layout': row.item.type,
    'data-icon': row.item.type,
    'data-component': component,
    'data-fixture': row.fixture ? 'true' : 'false',
    'data-state': row.item.state,
    'data-delivery': pending ? 'pending' : row.delivery,
    'data-status': status,
    'data-applied': row.delivery === 'applied' ? 'true' : 'false',
    className: 'border border-hairline bg-surface-panel px-3 py-2 text-ink-mid',
    'aria-label': `${TYPE_LABEL[row.item.type]}: ${row.item.headline}`,
  }
}

export function CardIdentity({ row, pending }: { row: AttentionRow; pending: boolean }) {
  const item = row.item
  const status = pending ? 'pending' : visibleStatus(row)
  return (
    <>
      <div data-region="type" className={`flex items-center gap-2 font-display text-2xs uppercase tracking-wider ${TYPE_CLASS[item.type]}`}>
        <NeedsYouIcon type={item.type} />
        <span>{TYPE_LABEL[item.type]}</span>
        {row.fixture ? <span data-testid="needsyou-fixture">fixture</span> : null}
      </div>
      <h3 data-region="headline" className="font-display text-sm text-ink-high">{item.headline}</h3>
      <p data-region="origin" data-testid={`needsyou-origin-${item.id}`}>{originParts(item).join(' · ')}</p>
      <p data-region="impact">{impactLabel(item.executionImpact)}</p>
      <p data-region="status" data-testid={`needsyou-status-${item.id}`}>
        <span data-testid={`needsyou-state-${item.id}`}>state {item.state}</span>
        {' '}
        <span>{status}</span>
      </p>
    </>
  )
}
