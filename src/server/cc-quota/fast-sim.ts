import type { RawUsage } from './types'

export function makeFakeCcQuota(nowMs: number = Date.now()): RawUsage {
  const resetFiveHour = new Date(nowMs + 3 * 60 * 60 * 1000 + 12 * 60 * 1000).toISOString() // +3h12m
  const resetWeek     = new Date(nowMs + 7 * 60 * 60 * 1000 + 23 * 60 * 1000).toISOString() // +7h23m
  const resetSonnet   = new Date(nowMs + 8 * 60 * 60 * 1000).toISOString()

  return {
    five_hour:        { utilization: 67, resets_at: resetFiveHour },
    seven_day:        { utilization: 89, resets_at: resetWeek },
    seven_day_opus:   null,
    seven_day_sonnet: { utilization: 2,  resets_at: resetSonnet },
    extra_usage:      { is_enabled: true, used_credits: 8148, currency: 'USD' },
  }
}
