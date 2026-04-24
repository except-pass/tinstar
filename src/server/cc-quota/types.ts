export interface UsageBucket {
  utilization: number       // 0..100
  resets_at: string         // ISO timestamp
}

/**
 * Normalized quota snapshot derived from Claude Code's statusline push.
 *
 * Only five_hour and seven_day are available via the statusline; per-model
 * weekly buckets and extra-usage state are not exposed through that channel.
 */
export interface RawUsage {
  five_hour: UsageBucket | null
  seven_day: UsageBucket | null
}

export type IngestErrorCode =
  | 'malformed_json'
  | 'missing_rate_limits'

export interface IngestError {
  code: IngestErrorCode
  message: string
}

export interface CcQuotaSnapshot {
  /** ISO timestamp of the last ingested payload. Zero-epoch when none. */
  fetchedAt: string
  /** Last good data; null only if no ingest has arrived yet. */
  data: RawUsage | null
  /** Set when the most recent ingest failed to parse. */
  error: IngestError | null
}

/**
 * Per-session context-window snapshot carved out of a statusline payload.
 * Separate from rate-limit quota because context_window is scoped to one
 * conversation, while rate_limits are global to the CC user.
 */
export interface SessionContextSnapshot {
  /** 0..100 — how full the context window is right now. */
  usedPercentage: number
  /** Token budget for this model/session. */
  windowSize: number
  /** ISO timestamp of the statusline push that produced this snapshot. */
  fetchedAt: string
}
