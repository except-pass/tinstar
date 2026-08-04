import type { Interval, Mark } from './types'

export interface ParseResult {
  intervals: Interval[]
  marks: Mark[]
  turns: [number, number, boolean][]
  t0: number | null
  t1: number | null
}

export const secOf = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms / 1000
}

/** Tolerance for clock skew between whoever wrote the transcript and this process. */
const FUTURE_TOLERANCE_SEC = 300

/**
 * Reject a timestamp that cannot belong to this transcript.
 *
 * Only the future is rejected. A single future-dated entry stretches the span to
 * centuries — every real band collapses to a sub-pixel sliver — and the cache
 * then serves that poisoned reconstruction until the file next grows. An
 * unusually OLD timestamp is left alone deliberately: there is no honest
 * absolute floor (a resumed or imported transcript can legitimately reach back a
 * long way), and an arbitrary one would silently discard real history.
 */
export function plausibleTime(t: number, now: number): boolean {
  return t <= now + FUTURE_TOLERANCE_SEC
}

export const snip = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 110)

/** A tool call seen but not yet resolved. */
export interface PendingEntry {
  start: number
  name: string
  args: string
  /**
   * Timestamp of the first entry logged after this call started. Set while
   * streaming so a resumed parse never needs the full entry-time array (R14).
   */
  closedAt?: number
}

/**
 * Accumulated reader state.
 *
 * Held across incremental reads so a growing transcript is parsed once, not
 * from byte zero on every poll. Both adapters share this shape; only the
 * per-entry interpretation differs.
 */
export interface ReaderState {
  pending: Map<string, PendingEntry>
  intervals: Interval[]
  marks: Mark[]
  humans: number[]
  ends: number[]
  t0: number | null
  t1: number | null
  /** Claude only: the most recent assistant entry, which closes a turn. */
  lastAssistant: number | null
}

export function newReaderState(): ReaderState {
  return { pending: new Map(), intervals: [], marks: [], humans: [], ends: [], t0: null, t1: null, lastAssistant: null }
}

/**
 * Record an entry's timestamp and close out any call still waiting for one.
 *
 * Must be called BEFORE the entry is interpreted, so a call never closes itself.
 */
export function noteEntry(state: ReaderState, t: number): void {
  if (state.t0 === null || t < state.t0) state.t0 = t
  if (state.t1 === null || t > state.t1) state.t1 = t
  for (const p of state.pending.values()) {
    if (p.closedAt === undefined && p.start < t) p.closedAt = t
  }
}

/**
 * Turn accumulated state into a ParseResult.
 *
 * A call with no recorded output is NOT proof the agent is still parked on it:
 * Codex drops the output line when a call is interrupted, and stretching those
 * to "now" painted a 34.9-hour phantom band over real work. Only a call with
 * nothing logged after it is genuinely in flight (R4).
 */
export function finishState(state: ReaderState, now: number): ParseResult {
  const intervals = state.intervals.slice()
  for (const p of state.pending.values()) {
    const inFlight = p.closedAt === undefined
    intervals.push({
      start: p.start,
      end: inFlight ? now : p.closedAt!,
      kind: 'tool',
      name: inFlight ? p.name : `${p.name} (no result logged)`,
      detail: snip(p.args),
    })
  }
  if (state.t1 !== null) intervals.push(...idleIntervals(state.humans, state.ends, state.t1))
  return {
    intervals,
    marks: state.marks,
    turns: buildTurns(state.humans, state.ends, state.t1),
    t0: state.t0,
    t1: state.t1,
  }
}

/** True when a genuinely-in-flight call is outstanding — the live-stall case. */
export function inFlightStart(state: ReaderState): number | null {
  let earliest: number | null = null
  for (const p of state.pending.values()) {
    if (p.closedAt !== undefined) continue
    if (earliest === null || p.start < earliest) earliest = p.start
  }
  return earliest
}

/**
 * Idle = the agent finished and nothing happened until the user spoke.
 *
 * Pair each human message with the LAST turn end before it. Pairing with every
 * earlier end manufactures overlapping idle windows — the bug that made one
 * session report 138h of idle across a 96h life.
 */
export function idleIntervals(humans: number[], ends: number[], t1: number): Interval[] {
  const out: Interval[] = []
  const sortedEnds = [...ends].sort((a, b) => a - b)
  let i = 0
  for (const h of [...humans].sort((a, b) => a - b)) {
    let prev: number | null = null
    while (i < sortedEnds.length && sortedEnds[i]! < h) prev = sortedEnds[i++]!
    if (prev !== null && h - prev > 2) {
      out.push({ start: prev, end: h, kind: 'idle', name: 'waiting on you', detail: '' })
    }
  }
  const lastEnd = sortedEnds[sortedEnds.length - 1]
  const lastHuman = humans[humans.length - 1]
  if (lastEnd !== undefined && (lastHuman === undefined || lastEnd > lastHuman) && t1 - lastEnd > 2) {
    out.push({ start: lastEnd, end: t1, kind: 'idle', name: 'waiting on you', detail: '' })
  }
  return out
}

/** A turn runs from a human message to the next turn end, or to now if open. */
export function buildTurns(humans: number[], ends: number[], t1: number | null): [number, number, boolean][] {
  if (t1 === null) return []
  const sortedEnds = [...ends].sort((a, b) => a - b)
  return [...humans].sort((a, b) => a - b).map(h => {
    const e = sortedEnds.find(x => x > h)
    return [h, e ?? t1, e === undefined] as [number, number, boolean]
  })
}
