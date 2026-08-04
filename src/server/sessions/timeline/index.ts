import { statSync } from 'node:fs'
import { readClaudeTranscript } from './claude'
import { readCodexTranscript } from './codex'
import { flatten } from './flatten'
import type { SessionTimeline } from './types'

export * from './types'
export { findCodexCandidates, pickCodexRollout } from './codex'
export type { RolloutCandidate } from './codex'

export interface TimelineInput {
  name: string
  adapter: 'claude' | 'codex' | string
  /** null when no transcript could be resolved — marshal-class sessions (R18) */
  transcriptPath: string | null
  createdSec: number
}

interface CacheEntry { size: number; timeline: SessionTimeline }

const cache = new Map<string, CacheEntry>()

/** Test seam — the cache is module state, so tests must be able to clear it. */
export function __resetTimelineCache(): void { cache.clear() }

/**
 * Build (or serve from cache) a session's timeline.
 *
 * Keyed on session name and invalidated by file size. The largest live
 * transcript is 72MB across 40,826 lines; re-parsing that on every 5s poll is
 * not viable. A transcript is append-only, so size is a sound invalidation
 * signal — if the byte count has not moved, nothing was written (R14).
 */
export function buildSessionTimeline(
  input: TimelineInput,
  now = Date.now() / 1000,
): SessionTimeline | null {
  if (!input.transcriptPath) return null

  let size: number
  try { size = statSync(input.transcriptPath).size } catch { return null }

  const hit = cache.get(input.name)
  if (hit && hit.size === size) return hit.timeline

  const read = input.adapter === 'codex' ? readCodexTranscript : readClaudeTranscript
  const r = read(input.transcriptPath, now)
  if (r.t0 === null || r.t1 === null) return null

  // The right edge is the last transcript entry — EXCEPT when a call is still in
  // flight. A session parked on an unanswered approval prompt writes nothing
  // while it waits, so its last entry is the moment the prompt appeared; without
  // this, `flatten` clips the pending band to zero width and an 8-hour live
  // stall renders as an empty strip. `closeUnmatched` only reaches past t1 for a
  // genuinely-last unmatched call, so this cannot resurrect the R4 phantom.
  const t1 = r.intervals.reduce((max, i) => (i.end > max ? i.end : max), r.t1)
  const turns: [number, number, boolean][] =
    r.turns.map(([a, b, open]) => (open ? [a, Math.max(b, t1), true] : [a, b, open]))

  const timeline: SessionTimeline = {
    t0: r.t0,
    t1,
    bands: flatten(r.intervals, r.t0, t1),
    marks: r.marks,
    turns,
    partial: false,
  }
  cache.set(input.name, { size, timeline })
  return timeline
}
