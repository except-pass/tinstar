// The freshness lifecycle, made visible (plan U6, R18).
//
// `SurfaceAge` next door answers "how long since this was tended", which is a
// guess from a timestamp. This answers "what does the HOST know" — whether a typed
// trigger has fired, whether a job is waiting its turn, whether a worker is
// running, whether one failed, and whether a verification deadline has passed. The
// two live side by side deliberately: the age is a heuristic, this is evidence.
//
// COLOUR DISCIPLINE (Slate design language). Cyan is the live edge and is spent
// ONLY on `refreshing` — the one state where something is happening right now.
// `queued` is control ink (real work, not yet its turn), `possibly-stale` and
// `overdue` are amber (worth a second look, not a claim of wrongness), `failed` is
// rose. `current` renders NOTHING: a Slate where every card wears a green tick is
// a Slate where nobody reads any of them.

import type { SurfaceFreshness, SurfaceFreshnessPhase } from '../../types'

interface Look {
  glyph: string
  label: string
  className: string
}

const LOOKS: Record<Exclude<SurfaceFreshnessPhase, 'current'>, Look> = {
  'possibly-stale': { glyph: '◈', label: 'stale', className: 'text-amber-400/90' },
  queued: { glyph: '⋯', label: 'queued', className: 'text-ink-mid' },
  // The only cyan, and the only animation.
  refreshing: { glyph: '⟳', label: 'refreshing', className: 'text-primary' },
  failed: { glyph: '⚠', label: 'failed', className: 'text-rose-400/90' },
}

/** One sentence a human can act on, for the hover. Built from what the host
 *  actually recorded rather than from the phase name, so "stale" always comes with
 *  WHY it is stale. */
export function freshnessTitle(freshness: SurfaceFreshness): string {
  const why = freshness.staleReason?.detail
  const parts: string[] = []
  switch (freshness.phase) {
    case 'current':
      parts.push('Verified against its sources.')
      break
    case 'possibly-stale':
      parts.push(why ? `May be out of date — ${why}.` : 'May be out of date.')
      break
    case 'queued':
      parts.push('A refresh is queued and waiting for a free worker.')
      if (why) parts.push(`It was scheduled because ${why}.`)
      break
    case 'refreshing':
      parts.push('A refresh is running now.')
      if (why) parts.push(`It was scheduled because ${why}.`)
      break
    case 'failed':
      parts.push(freshness.failure ? `The last refresh failed: ${freshness.failure.message}` : 'The last refresh failed.')
      break
  }
  // Orthogonal to the phase, so it is appended rather than replacing anything —
  // a queued Surface can be overdue, and hiding that would make a retry loop look
  // like attention.
  if (freshness.overdue) parts.push('Its verification deadline has passed.')
  return parts.join(' ')
}

/**
 * The phase pill. Renders nothing for a verified Surface with no missed deadline
 * — the resting state is silence.
 *
 * `overdue` is drawn as a separate amber dot rather than folded into the phase,
 * because it genuinely IS separate: a Surface can be refreshing AND overdue, and
 * collapsing the two would let a retry loop paint over a deadline nobody met.
 */
export function FreshnessBadge({ freshness, className }: {
  freshness?: SurfaceFreshness
  className?: string
}) {
  if (!freshness) return null
  const look = freshness.phase === 'current' ? null : LOOKS[freshness.phase]
  if (!look && !freshness.overdue) return null
  const title = freshnessTitle(freshness)
  return (
    <span
      data-testid="freshness-badge"
      data-phase={freshness.phase}
      data-overdue={freshness.overdue ? 'true' : undefined}
      title={title}
      aria-label={title}
      className={`inline-flex shrink-0 items-center gap-1 font-mono text-[10px] leading-none ${className ?? ''}`}
    >
      {look && (
        <span className={look.className}>
          <span className={freshness.phase === 'refreshing' ? 'inline-block animate-spin' : 'inline-block'}>
            {look.glyph}
          </span>{' '}
          {look.label}
        </span>
      )}
      {freshness.overdue && (
        <span data-testid="freshness-overdue" className="text-amber-400/90">overdue</span>
      )}
    </span>
  )
}
