// Humanized relative age for a timestamp — "just now", "3m ago", "2h ago", "4d ago".
// Pure: no React, no schema. Promoted out of the Roundup plugin (was
// plugins/roundup/src/age.ts) so the Slate's surface-freshness signal and the
// Roundup's notice-recede logic share ONE implementation instead of drifting copies.

/** A thing untouched for this long reads as stale by default. One day is the
 *  Roundup's "I've been away and come back" horizon; callers that live at a
 *  different cadence (e.g. a Slate surface within a session) pass their own. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const YEAR = 365 * DAY

/** A compact relative age like "3d ago", for a timestamp in epoch millis.
 *  Coarse on purpose: the reader wants "is this fresh or old", not a duration.
 *  Anything under a minute (or in the future, from clock skew) reads "just now";
 *  a non-finite timestamp yields '' so a malformed item renders no age rather
 *  than "NaNd ago". */
export function relativeAge(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return ''
  const delta = now - timestamp
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`
  if (delta < YEAR) return `${Math.floor(delta / WEEK)}w ago`
  return `${Math.floor(delta / YEAR)}y ago`
}

/** True when something last tended at `timestamp` has gone stale. A non-finite
 *  timestamp is never stale — an unreadable date is not evidence of age. */
export function isStale(timestamp: number, now: number = Date.now(), threshold: number = STALE_AFTER_MS): boolean {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return false
  return now - timestamp >= threshold
}
