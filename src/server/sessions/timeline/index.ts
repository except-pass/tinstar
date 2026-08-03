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

  const timeline: SessionTimeline = {
    t0: r.t0,
    t1: r.t1,
    bands: flatten(r.intervals, r.t0, r.t1),
    marks: r.marks,
    turns: r.turns,
    partial: false,
  }
  cache.set(input.name, { size, timeline })
  return timeline
}
