import { statSync, openSync, readSync, closeSync } from 'node:fs'
import { feedClaudeEntry, skipClaudeEntry } from './claude'
import { feedCodexEntry } from './codex'
import { flatten } from './flatten'
import {
  newReaderState, finishState, inFlightStart, secOf, plausibleTime,
  type ReaderState,
} from './shared'
import type { Band, SessionTimeline } from './types'

export * from './types'
export { findCodexCandidates, pickCodexRollout, ROLLOUT_MATCH_TOLERANCE_SEC } from './codex'
export type { RolloutCandidate } from './codex'
export { readClaudeTranscript } from './claude'
export { readCodexTranscript } from './codex'

export interface TimelineInput {
  name: string
  adapter: 'claude' | 'codex' | string
  /** null when no transcript could be resolved — marshal-class sessions (R18) */
  transcriptPath: string | null
  createdSec: number
}

interface CacheEntry {
  /** Identity of the parsed file, so a path swap is a miss rather than stale data. */
  path: string
  /** Bytes consumed so far. */
  offset: number
  /** Trailing partial line held back until the rest of it arrives. */
  carry: string
  state: ReaderState
  timeline: SessionTimeline
  /** Start of the genuinely-in-flight call, if any — drives the O(1) live edge. */
  inFlightSince: number | null
}

/**
 * Bounded so a long-lived server with session churn cannot accumulate parsed
 * timelines forever. A large session's entry measured ~2.9MB.
 */
const MAX_CACHED_SESSIONS = 24

const cache = new Map<string, CacheEntry>()

/**
 * Resolved transcript paths, memoised per session.
 *
 * Codex discovery walks the whole `~/.codex/sessions` tree and reads a header
 * out of every candidate — measured at 506ms against 149 candidates, and near a
 * second on a 1.7GB tree. It ran on every poll, before the cache was consulted,
 * so a warm timeline still paid full discovery cost. A session's transcript
 * does not move, so this is resolved once and re-checked only when the file
 * disappears.
 */
const pathCache = new Map<string, { path: string; at: number }>()
const PATH_TTL_SEC = 300

/** Test seam — the caches are module state, so tests must be able to clear them. */
export function __resetTimelineCache(): void { cache.clear(); pathCache.clear() }

/**
 * Memoise an expensive transcript-path resolution for a session.
 *
 * `resolve` is only called on a cold entry, an expired one, or when the
 * previously resolved file has vanished (a Codex `resume` writes a new rollout).
 */
export function resolveTranscriptPath(
  sessionName: string,
  resolve: () => string | null,
  now = Date.now() / 1000,
): string | null {
  const hit = pathCache.get(sessionName)
  if (hit && now - hit.at < PATH_TTL_SEC) {
    try {
      statSync(hit.path)
      return hit.path
    } catch { /* vanished — fall through and re-resolve */ }
  }
  const path = resolve()
  if (path) pathCache.set(sessionName, { path, at: now })
  else pathCache.delete(sessionName)
  return path
}

/** Insertion-ordered eviction: drop the least recently refreshed entry. */
function remember(name: string, entry: CacheEntry): void {
  cache.delete(name)
  cache.set(name, entry)
  while (cache.size > MAX_CACHED_SESSIONS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** Read bytes [from, to) without pulling the whole file into memory. */
function readRange(path: string, from: number, to: number): string {
  const length = to - from
  if (length <= 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, from)
    return buf.toString('utf-8', 0, n)
  } finally {
    closeSync(fd)
  }
}

/**
 * Advance a cached timeline's right edge to `now` without re-parsing.
 *
 * A session parked on an unanswered prompt writes nothing while it waits, so
 * its file size never changes — but the stall is still growing. Without this the
 * rail would freeze the stall at whatever it measured when the prompt appeared.
 */
function withLiveEdge(entry: CacheEntry, now: number): SessionTimeline {
  if (entry.inFlightSince === null || now <= entry.timeline.t1) return entry.timeline
  const bands = entry.timeline.bands.slice()
  const last = bands[bands.length - 1]
  if (last && last.end >= entry.timeline.t1) bands[bands.length - 1] = { ...last, end: now }
  return {
    ...entry.timeline,
    t1: now,
    bands,
    turns: entry.timeline.turns.map(([a, b, open]) => (open ? [a, Math.max(b, now), true] : [a, b, open])),
  }
}

function assemble(state: ReaderState, now: number): SessionTimeline | null {
  const r = finishState(state, now)
  if (r.t0 === null || r.t1 === null) return null

  // The right edge is the last transcript entry — EXCEPT when a call is still in
  // flight, in which case the stall runs to now. `finishState` only reaches past
  // t1 for a genuinely-last unmatched call, so this cannot resurrect the R4
  // phantom band.
  const t1 = r.intervals.reduce((max: number, i) => (i.end > max ? i.end : max), r.t1)
  const turns: [number, number, boolean][] =
    r.turns.map(([a, b, open]) => (open ? [a, Math.max(b, t1), true] : [a, b, open]))

  return {
    t0: r.t0,
    t1,
    bands: flatten(r.intervals, r.t0, t1) as Band[],
    marks: r.marks,
    turns,
    partial: false,
  }
}

/**
 * Build (or incrementally extend) a session's timeline.
 *
 * A transcript is append-only, so a poll reads only the bytes added since the
 * last one and folds them into retained reader state (R14). Re-parsing from
 * byte zero on every size change — which is what an active session does
 * constantly — cost ~1.9s of blocked event loop per poll per card, against a 5s
 * poll interval. The cache is keyed on session name AND the resolved path, so a
 * recreated session cannot inherit its predecessor's timeline.
 */
export function buildSessionTimeline(
  input: TimelineInput,
  now = Date.now() / 1000,
): SessionTimeline | null {
  const path = input.transcriptPath
  if (!path) return null

  let size: number
  try { size = statSync(path).size } catch { return null }

  const hit = cache.get(input.name)
  const reusable = hit && hit.path === path && size >= hit.offset

  if (reusable && size === hit.offset) return withLiveEdge(hit, now)

  const entry: CacheEntry = reusable
    ? hit
    : { path, offset: 0, carry: '', state: newReaderState(), timeline: null as unknown as SessionTimeline, inFlightSince: null }

  const chunk = entry.carry + readRange(path, entry.offset, size)
  const lines = chunk.split('\n')
  // The final element is either an empty string (file ended with a newline) or a
  // half-written line; either way it waits for the next read.
  entry.carry = lines.pop() ?? ''

  const feed = input.adapter === 'codex' ? feedCodexEntry : feedClaudeEntry
  for (const line of lines) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try { o = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (input.adapter !== 'codex' && skipClaudeEntry(o)) continue
    const t = secOf(o.timestamp)
    if (t === null || !plausibleTime(t, now)) continue
    feed(entry.state, t, o)
  }
  entry.offset = size

  const timeline = assemble(entry.state, now)
  if (!timeline) return null
  entry.timeline = timeline
  entry.inFlightSince = inFlightStart(entry.state)
  remember(input.name, entry)
  return timeline
}
