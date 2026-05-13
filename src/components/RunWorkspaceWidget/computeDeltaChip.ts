export type ChipMetric = 'cost' | 'tokens' | 'cache' | 'duty'
export type ChipTone = 'up' | 'dn' | 'flat'

export interface DeltaChip {
  text: string
  tone: ChipTone
}

const ONE_MIN_SEC = 60
const MIN_SAMPLES = 12   // ~60s at 5s steps

function fmtTokens(v: number): string {
  // Tokens render in k always (deltas are typically in the hundreds-to-thousands range).
  return (v / 1000).toFixed(1) + 'k'
}

function nonNull(series: [number, number | null][]): [number, number][] {
  return series.filter((p): p is [number, number] => p[1] !== null)
}

/**
 * Returns the delta chip shown in the corner of a StatSpark, or null if there's
 * not enough history (need ~60s of samples). See spec for chip semantics per metric.
 *
 * Gate is on total series length so a series with nulls (e.g. backend hadn't reported
 * cache yet) still produces a chip once enough wall-time has elapsed. Mean & rate are
 * computed over non-null samples only.
 */
export function computeDeltaChip(
  metric: ChipMetric,
  series: [number, number | null][],
): DeltaChip | null {
  if (series.length < MIN_SAMPLES) return null

  const clean = nonNull(series)
  if (clean.length === 0) return null

  const last = clean[clean.length - 1][1]
  const lastTs = clean[clean.length - 1][0]
  const window = clean.filter(([ts]) => ts >= lastTs - ONE_MIN_SEC)
  if (window.length === 0) return null

  if (metric === 'cost') {
    // Cost is cumulative. Rate = (last - first-in-window) over actual elapsed seconds, normalized to /min.
    const firstInWindow = window[0]
    const elapsedSec = Math.max(1, lastTs - firstInWindow[0])
    const ratePerMin = ((last - firstInWindow[1]) * ONE_MIN_SEC) / elapsedSec
    const sign = ratePerMin >= 0 ? '+' : '−'
    const abs = Math.abs(ratePerMin)
    return { text: `${sign}$${abs.toFixed(2)}/min`, tone: 'flat' }   // cost is always neutral-toned
  }

  const mean = window.reduce((s, p) => s + p[1], 0) / window.length
  const delta = last - mean
  const absRel = mean !== 0 ? Math.abs(delta / mean) : Math.abs(delta)
  const tone: ChipTone = absRel < 0.01 ? 'flat' : delta > 0 ? 'up' : 'dn'
  const sign = delta >= 0 ? '+' : '−'
  const abs = Math.abs(delta)

  if (metric === 'tokens') {
    return { text: `${sign}${fmtTokens(abs)}`, tone }
  }
  // cache & duty are 0..1 fractions → render as percentage points
  return { text: `${sign}${(abs * 100).toFixed(1)}pp`, tone }
}
