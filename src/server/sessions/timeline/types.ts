/**
 * Types for session time-usage reconstruction.
 *
 * See docs/brainstorms/2026-08-03-session-time-usage-requirements.md — R-IDs in
 * comments below refer to that document.
 */

/**
 * Band kinds in paint-priority order — earlier wins when observations overlap
 * (R2). Overlap is real and routine: a Codex `exec` script shells out to
 * `exec_command`, so one tool span sits entirely inside another.
 */
export const BAND_KINDS = ['approval', 'question', 'subagent', 'compact', 'tool', 'idle', 'think'] as const
export type BandKind = typeof BAND_KINDS[number]

/**
 * Default trailing window, in seconds.
 *
 * Never inline this number at a use site (R9a). It is threaded as a route query
 * parameter and a hook argument so that surfacing a window selector later is
 * adding a control, not re-plumbing three layers.
 */
export const DEFAULT_WINDOW_SEC = 3600

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
