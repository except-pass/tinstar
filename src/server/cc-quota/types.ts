export interface UsageBucket {
  utilization: number
  resets_at: string
}

export interface ExtraUsage {
  is_enabled: boolean
  used_credits: number | null
  currency: string
}

export interface RawUsage {
  five_hour: UsageBucket | null
  seven_day: UsageBucket | null
  seven_day_opus: UsageBucket | null
  seven_day_sonnet: UsageBucket | null
  extra_usage: ExtraUsage | null
}

export type FetchErrorCode =
  | 'no_creds'
  | 'expired_token'
  | 'http_4xx'
  | 'http_5xx'
  | 'network'

export interface FetchError {
  code: FetchErrorCode
  message: string
}

export class CcQuotaFetchError extends Error {
  constructor(public readonly info: FetchError) {
    super(info.message)
    this.name = 'CcQuotaFetchError'
  }
}

export interface CcQuotaSnapshot {
  fetchedAt: string          // ISO timestamp of the last completed attempt (success or failure)
  data: RawUsage | null      // last good data; null only if no fetch has ever succeeded
  error: FetchError | null   // set when the most recent fetch failed
}
