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
  autonomy: { ratio: number | null; cliSeconds: number | null; userSeconds: number | null }
  staleSeconds?: number
  progress?: import('../infra/types.js').DownloadProgress[]
  error?: string
}
