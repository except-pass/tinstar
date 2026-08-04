import { BAND_KINDS, type Band, type BandKind, type Interval } from './types'

const PRIORITY: Record<BandKind, number> =
  Object.fromEntries(BAND_KINDS.map((k, i) => [k, i])) as Record<BandKind, number>

/**
 * Collapse overlapping observations into one non-overlapping track covering
 * [t0, t1]. Uncovered time is the model thinking — a residual, not a
 * measurement (R20).
 *
 * A sweep line is used rather than sort-and-merge because intervals nest: a
 * Codex `exec` script shells out to `exec_command`, so a tool span can sit
 * entirely inside another, and an approval stall can sit inside that. Whichever
 * covering interval has the best priority owns the stretch until the next
 * boundary (R2).
 *
 * The bands this returns always sum to `t1 - t0`. That property is what lets
 * the UI print honest percentages, so the tests assert it directly.
 */
export function flatten(intervals: Interval[], t0: number, t1: number): Band[] {
  const usable = intervals.filter(i => i.end > i.start)
  if (usable.length === 0) {
    return [{ start: t0, end: t1, kind: 'think', name: 'model thinking', detail: '' }]
  }

  const bounds = [...new Set([t0, t1, ...usable.flatMap(i => [i.start, i.end])])]
    .filter(b => b >= t0 && b <= t1)
    .sort((a, b) => a - b)

  const byStart = [...usable].sort((a, b) => a.start - b.start)
  let cursor = 0
  let active: Interval[] = []
  const out: Band[] = []

  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i]!
    const hi = bounds[i + 1]!
    if (hi <= lo) continue
    while (cursor < byStart.length && byStart[cursor]!.start <= lo) active.push(byStart[cursor++]!)
    active = active.filter(a => a.end > lo)

    let best: Interval | null = null
    for (const a of active) {
      if (!best || PRIORITY[a.kind] < PRIORITY[best.kind]) best = a
    }
    out.push(best
      ? { start: lo, end: hi, kind: best.kind, name: best.name, detail: best.detail }
      : { start: lo, end: hi, kind: 'think', name: 'model thinking', detail: '' })
  }

  // Merge neighbours a boundary split apart, so one tool call reads as one band
  // rather than a run of adjacent slices with identical labels.
  const merged: Band[] = []
  for (const b of out) {
    const prev = merged[merged.length - 1]
    if (prev && prev.kind === b.kind && prev.name === b.name && prev.end === b.start) prev.end = b.end
    else merged.push({ ...b })
  }
  return merged
}
