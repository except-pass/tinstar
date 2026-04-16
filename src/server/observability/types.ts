export type ObservabilityState =
  | 'idle'         // not started
  | 'downloading'  // fetching binaries
  | 'starting'     // binaries present, children starting
  | 'ready'        // all healthy
  | 'degraded'        // repeated crashes, retry blocked
  | 'download-failed' // binary download failed after retries
  | 'disabled'        // TINSTAR_TELEMETRY=0

export interface DownloadProgress {
  component: 'prometheus' | 'alloy'
  bytesReceived: number
  bytesTotal: number
}

export interface ModelBreakdown {
  [model: string]: number
}

export interface HudSnapshot {
  window: 'today'
  state: ObservabilityState
  cost: { total: number | null; byModel: ModelBreakdown }
  tokens: { total: number | null }
  rate: { perMin: number | null; perHour: number | null }
  /** Cache-hit fraction in range 0..1 (not 0..100 — the `Pct` suffix is historical). */
  cacheHitPct: number | null
  autonomy: { ratio: number | null; cliSeconds: number | null; userSeconds: number | null }
  staleSeconds?: number
  progress?: DownloadProgress[]
  error?: string
}

export interface SupervisorState {
  pid: number
  binaryPath: string
  binaryHash: string
  port: number
  startedAt: number
}
