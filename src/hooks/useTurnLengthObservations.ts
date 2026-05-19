import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'

export interface Observation {
  tsSec: number
  sec: number
  session: string
  ccConvId: string
}

export const TURN_LENGTH_BUCKETS = [1, 3, 10, 30, 60, 120, 300, 600, 1800, 3600] as const

export const TURN_LENGTH_HELP =
  'How long each turn took (user submit → assistant done), over the last 60m. ' +
  'X axis: duration bucket (≤1s on the left, ≤1h on the right). ' +
  'Y axis: number of turns that fell into that bucket. ' +
  'p50 / p95: median and 95th-percentile turn length across the window. ' +
  'n: total turns counted.'

const NUM_TIME_COLS = 30
const NUM_VALUE_BUCKETS = TURN_LENGTH_BUCKETS.length  // 10

export interface TurnLengthData {
  observations: Observation[]
  p50: number | undefined
  p95: number | undefined
  n: number
  cells: number[][]  // [valueBucket][timeColumn], 10 x 30
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

export function deriveData(observations: Observation[], windowSec: number): TurnLengthData {
  const n = observations.length
  const cells: number[][] = Array.from({ length: NUM_VALUE_BUCKETS }, () => Array(NUM_TIME_COLS).fill(0))

  if (n === 0) return { observations, p50: undefined, p95: undefined, n: 0, cells }

  const nowSec = Math.floor(Date.now() / 1000)
  const windowStart = nowSec - windowSec
  const columnSec = windowSec / NUM_TIME_COLS

  for (const o of observations) {
    const col = Math.min(NUM_TIME_COLS - 1, Math.max(0, Math.floor((o.tsSec - windowStart) / columnSec)))
    let row = NUM_VALUE_BUCKETS - 1
    for (let i = 0; i < NUM_VALUE_BUCKETS; i++) {
      if (o.sec <= TURN_LENGTH_BUCKETS[i]) { row = i; break }
    }
    cells[row][col]++
  }

  // Percentiles over raw observation `sec` values
  const sorted = [...observations].map(o => o.sec).sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]

  return { observations, p50, p95, n, cells }
}
