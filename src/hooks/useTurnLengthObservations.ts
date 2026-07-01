import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'

export interface Observation {
  tsSec: number
  sec: number
  session: string
  ccConvId: string
  toolUses?: number
}

/** Per-duration-bucket distribution of tool_use counts (for the whisker glyph). */
export interface BucketToolStats {
  p10: number
  p50: number
  p90: number
  n: number
}

export const TURN_LENGTH_BUCKETS = [1, 3, 10, 30, 60, 120, 300, 600, 1800, 3600] as const

export const TURN_LENGTH_HELP =
  'How long each turn took (user submit → assistant done), over the last 60m. ' +
  'X axis: duration bucket (≤1s on the left, ≤1h on the right). ' +
  'Y axis: number of turns that fell into that bucket. ' +
  'The whisker over each bar shows the tool-call distribution for that bucket ' +
  '(cap-to-cap = p10→p90, dot = p50, on the right-side "tools" scale) — ' +
  'e.g. how tool-heavy the ~5m turns were. ' +
  'p50 / p95: median and 95th-percentile turn length across the window. ' +
  'tools p50/p90: median and 90th-percentile tool calls per turn. ' +
  'n: total turns counted.'

const NUM_TIME_COLS = 30
const NUM_VALUE_BUCKETS = TURN_LENGTH_BUCKETS.length  // 10

export interface TurnLengthData {
  observations: Observation[]
  p50: number | undefined
  p95: number | undefined
  n: number
  cells: number[][]  // [valueBucket][timeColumn], 10 x 30
  toolStats: (BucketToolStats | null)[]  // one per value bucket (10), null when the bucket has no turns
  toolP50: number | undefined            // overall tool_use median across the window
  toolP90: number | undefined            // overall tool_use 90th percentile across the window
}

interface Opts {
  intervalMs?: number  // default 5000; tests override
}

export function useTurnLengthObservations(
  sessionName: string | null,
  windowSec: number = 3600,
  opts: Opts = {},
): TurnLengthData {
  const [observations, setObservations] = useState<Observation[]>([])
  const intervalMs = opts.intervalMs ?? 5000

  useEffect(() => {
    let cancelled = false
    const fetchNow = () => {
      const qs = new URLSearchParams({ windowSec: String(windowSec) })
      if (sessionName) qs.set('session', sessionName)
      apiFetch(`/api/telemetry/turn-length?${qs}`)
        .then(r => r.json())
        .then(j => { if (!cancelled && Array.isArray(j?.observations)) setObservations(j.observations) })
        .catch(() => { /* swallow; next tick retries */ })
    }
    fetchNow()
    const id = setInterval(fetchNow, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [sessionName, windowSec, intervalMs])

  return deriveData(observations, windowSec)
}

/** Nearest-rank percentile matching the p50/p95 convention used for durations. */
function percentile(sortedAsc: number[], q: number): number | undefined {
  if (sortedAsc.length === 0) return undefined
  return sortedAsc[Math.floor(sortedAsc.length * q)] ?? sortedAsc[sortedAsc.length - 1]
}

function valueBucketRow(sec: number): number {
  for (let i = 0; i < NUM_VALUE_BUCKETS; i++) {
    const bucket = TURN_LENGTH_BUCKETS[i]
    if (bucket !== undefined && sec <= bucket) return i
  }
  return NUM_VALUE_BUCKETS - 1
}

export function deriveData(observations: Observation[], windowSec: number): TurnLengthData {
  const n = observations.length
  const cells: number[][] = Array.from({ length: NUM_VALUE_BUCKETS }, () => Array(NUM_TIME_COLS).fill(0))
  const emptyToolStats: (BucketToolStats | null)[] = Array.from({ length: NUM_VALUE_BUCKETS }, () => null)

  if (n === 0) {
    return { observations, p50: undefined, p95: undefined, n: 0, cells, toolStats: emptyToolStats, toolP50: undefined, toolP90: undefined }
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const windowStart = nowSec - windowSec
  const columnSec = windowSec / NUM_TIME_COLS

  // Collect tool_use counts per value bucket for the whisker glyph.
  const toolsByBucket: number[][] = Array.from({ length: NUM_VALUE_BUCKETS }, () => [])

  for (const o of observations) {
    const col = Math.min(NUM_TIME_COLS - 1, Math.max(0, Math.floor((o.tsSec - windowStart) / columnSec)))
    const row = valueBucketRow(o.sec)
    const rowCells = cells[row]
    if (rowCells) rowCells[col] = (rowCells[col] ?? 0) + 1
    toolsByBucket[row]?.push(o.toolUses ?? 0)
  }

  const toolStats: (BucketToolStats | null)[] = toolsByBucket.map(counts => {
    if (counts.length === 0) return null
    const sorted = [...counts].sort((a, b) => a - b)
    return {
      p10: percentile(sorted, 0.1)!,
      p50: percentile(sorted, 0.5)!,
      p90: percentile(sorted, 0.9)!,
      n: sorted.length,
    }
  })

  // Percentiles over raw observation `sec` values
  const sorted = [...observations].map(o => o.sec).sort((a, b) => a - b)
  const p50 = percentile(sorted, 0.5)
  const p95 = percentile(sorted, 0.95)

  const sortedTools = observations.map(o => o.toolUses ?? 0).sort((a, b) => a - b)
  const toolP50 = percentile(sortedTools, 0.5)
  const toolP90 = percentile(sortedTools, 0.9)

  return { observations, p50, p95, n, cells, toolStats, toolP50, toolP90 }
}
