// The canonical Surface store's degraded marker (plan U1, KTD5).
//
// It exists for exactly one state: `faulted-read-only`, when neither Surface
// snapshot could be read and both are being preserved as evidence. In that state
// the server keeps rendering the FROZEN legacy Slate — that is the user's only
// remaining copy, so hiding it would be worse — but the plan's success criterion
// is that no surface presents stale data as current. This banner is what makes
// the difference between "showing you an old copy" and "lying about it".
//
// Three properties are deliberate, not stylistic:
//   · NON-DISMISSABLE. There is no ✕. A marker a user can close is a marker that
//     is absent for the rest of the session, and the fault outlives the session;
//   · it NAMES A TIME. "Frozen" with no date reads as a transient glitch; a date
//     is what tells someone whether they are looking at this morning's work or
//     last week's;
//   · it renders NOTHING when healthy or recovered. `recovered` means the backup
//     supplied current records — nothing on screen is stale, so a warning there
//     would train the user to ignore this one.
import { useSurfaceHealth } from '../../hooks/useServerEvents'

/** Absolute time, spelled out. A relative "3 days ago" would need a ticking clock
 *  to stay honest, and this marker's whole job is to be honest about time. */
function formatFrozen(iso?: string): string {
  if (!iso) return 'an unknown time'
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? 'an unknown time' : at.toLocaleString()
}

export function SurfaceDegradedBanner() {
  const health = useSurfaceHealth()
  if (health.health !== 'faulted-read-only') return null
  return (
    <div
      data-testid="surface-degraded-marker"
      role="status"
      className="border-b border-hue-error/40 bg-hue-error/10 px-3 py-1.5 font-sans text-[11px] leading-snug text-ink-high"
    >
      <span className="font-mono uppercase tracking-[0.12em] text-hue-error">Not current</span>
      {' — '}
      Canonical Surfaces could not be read, so this Slate is the frozen copy saved at{' '}
      <span className="font-mono">{formatFrozen(health.frozenAt)}</span>. Nothing here is being
      updated and edits are not being saved.
      {health.detail ? <span className="text-ink-low"> ({health.detail})</span> : null}
    </div>
  )
}
