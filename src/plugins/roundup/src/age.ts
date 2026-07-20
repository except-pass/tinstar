// Derived staleness for Roundup notices. Pure — no clock reads, no React, no
// schema. Age is computed from the notice's existing `amendedAt` (the last time
// the AGENT tended it), so an old card recedes on its own without anyone acting
// and without a new field, a status enum, or a background job.

/** A notice untouched for this long reads as stale and is de-emphasized. One
 *  day is the "I've been away and come back" horizon the Roundup is built for. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const YEAR = 365 * DAY

/** A compact relative age like "3d ago", for a timestamp in epoch millis.
 *  Coarse on purpose: the user wants "is this fresh or old", not a duration.
 *  Anything under a minute (or in the future, from clock skew) reads "just now";
 *  a non-finite timestamp yields '' so a malformed notice renders no age rather
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

/** True when a notice last tended at `timestamp` has gone stale. A non-finite
 *  timestamp is never stale — an unreadable date is not evidence of age. */
export function isStale(timestamp: number, now: number = Date.now(), threshold: number = STALE_AFTER_MS): boolean {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return false
  return now - timestamp >= threshold
}
