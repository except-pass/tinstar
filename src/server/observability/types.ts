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
