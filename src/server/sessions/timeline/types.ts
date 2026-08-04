/**
 * Types for session time-usage reconstruction.
 *
 * See docs/brainstorms/2026-08-03-session-time-usage-requirements.md — R-IDs in
 * comments below refer to that document.
 */

// Shared with the frontend, so these live in src/domain/types.ts — the
// frontend may not runtime-import from src/server (docs/conventions.md).
// Re-exported here so server-internal callers keep one import site.
export { BAND_KINDS, DEFAULT_WINDOW_SEC } from '../../../domain/types'
export type { BandKind } from '../../../domain/types'
import type { BandKind } from '../../../domain/types'

/** An observation before flattening. May overlap other intervals. */
export interface Interval {
  /** epoch seconds */
  start: number
  /** epoch seconds */
  end: number
  kind: BandKind
  /** tool name, or a human label like 'waiting on you' */
  name: string
  /** command or argument snippet, for the tooltip */
  detail: string
}

/** A flattened band. Bands never overlap and always tile [t0, t1] (R2). */
export type Band = Interval

export type MarkKind = 'tool-failed' | 'subagent-interrupted'

export interface Mark {
  /** epoch seconds */
  at: number
  kind: MarkKind
  name: string
  detail: string
}

export interface SessionTimeline {
  /** epoch seconds of the first transcript entry */
  t0: number
  /** epoch seconds of the last transcript entry */
  t1: number
  bands: Band[]
  marks: Mark[]
  /** [start, end, isOpen] per turn, epoch seconds */
  turns: [number, number, boolean][]
  /** true when a cold parse yielded early and more remains (R15) */
  partial: boolean
}
