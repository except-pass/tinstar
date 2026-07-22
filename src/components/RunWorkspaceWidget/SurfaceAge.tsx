// The freshness signal for a Slate surface: "updated 3m ago", ambering past a
// session-cadence horizon. It makes surface staleness VISIBLE to both the user and
// the authoring agent — the fix for the "I shipped a PR but left the surface
// asserting the old truth" blind spot. Nothing here claims a surface is WRONG; it
// reports how long since it was last tended, so an old assertion draws a second look
// (and a refresh) instead of being trusted silently.
import { relativeAge, isStale } from '../../lib/relativeAge'

/** A surface untended for this long draws the eye amber — a "worth a refresh?" cue,
 *  not a claim of wrongness. Far shorter than the Roundup's 24h horizon: a Slate
 *  surface is meant to be tended within a working session. */
export const SLATE_STALE_AFTER_MS = 15 * 60_000

/** "updated 3m ago" for a surface, derived from its `amendedAt`; ambers past the
 *  stale horizon. `now` is passed in (the panel owns one ticking clock via useNow)
 *  so every surface's age agrees and there's no timer-per-row. Renders nothing for a
 *  non-finite/absent timestamp rather than "NaN". */
export function SurfaceAge({ amendedAt, now, className }: {
  amendedAt: number
  now: number
  className?: string
}) {
  const age = relativeAge(amendedAt, now)
  if (!age) return null
  const stale = isStale(amendedAt, now, SLATE_STALE_AFTER_MS)
  return (
    <span
      data-testid="surface-age"
      data-stale={stale ? 'true' : undefined}
      title={stale ? 'Not tended in a while — refresh to re-derive it' : `updated ${age}`}
      className={`text-[10px] leading-none ${stale ? 'text-amber-400/80' : 'text-slate-500'} ${className ?? ''}`}
    >
      updated {age}
    </span>
  )
}
