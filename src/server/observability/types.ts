export type { ServiceState as ObservabilityState, DownloadProgress, SupervisorState } from '../infra/types.js'

export interface ModelBreakdown {
  [model: string]: number
}

export interface HudSnapshot {
  window: 'today'
  state: import('../infra/types.js').ServiceState
  cost: { total: number | null; byModel: ModelBreakdown }
  tokens: { total: number | null }
  rate: { perMin: number | null; perHour: number | null }
  cacheHitPct: number | null
  /**
   * Fraction of wall-clock time the agent was busy over the trailing `windowMinutes`.
   * Per-session: 0..1 (one CLI, at most fully busy).
   * Fleet/global: 0..N — summing across concurrent sessions exceeds 1 when hands run in parallel.
   */
  dutyCycle: { value: number | null; windowMinutes: number }
  /** Tinstar run IDs currently burning tokens (non-zero rate in the last 30s). */
  burningRunIds?: string[]
  staleSeconds?: number
  progress?: import('../infra/types.js').DownloadProgress[]
  error?: string
}

/**
 * Per-session 5-minute history returned by GET /api/telemetry/session/:name/series.
 * Each series is `[unixSeconds, value | null][]`, oldest → newest.
 * `null` means "Prometheus had no sample at this step" — render as a gap.
 */
export interface HudSeries {
  startedAt: string  // ISO timestamp of the leftmost sample
  endedAt: string    // ISO timestamp of the rightmost sample (≈ now)
  stepSec: number    // resolution of each series (e.g., 5)
  series: {
    cost:   [number, number | null][]
    tokens: [number, number | null][]  // tokens/min (rate)
    cache:  [number, number | null][]  // 0..1
    duty:   [number, number | null][]  // 0..1 per session, can exceed 1 for fleet
  }
}
