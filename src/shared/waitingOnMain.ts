/** All supported textual names for the main First Mate live here. */
export const MAIN_NAMES = /\bfirst\s+mate\b(?!\s*\((?!main\))[^)]*\))|\bmain\s*:|\bvia\s+main\b|\bmain\s+firstmate\b/i
export const namesMain = (value: unknown): boolean => typeof value === 'string' && MAIN_NAMES.test(value)
export const mainHomeLabel = (value: string | undefined): boolean => value?.toLowerCase() === 'main' || namesMain(value)
export const MAIN_WAIT_INTERVAL = 4 * 3600_000
export interface ParentAsk { key: string; corr: string | null; state: 'blocked' | 'needs-decision'; at: number; text: string }
export interface ParentAsks { status: 'known' | 'unknown'; observed_at: string; items: ParentAsk[] }
export interface MainWaitItem {
  id: string; source: string; kind: 'card' | 'mate'; label: string; key: string; text: string
  since: string | null; ageBasis: 'status timestamp' | 'at least'; url: string | null; fresh: boolean
  alert?: 'mentioned' | 'plain-comment' | 'unconfirmed' | 'failed' | 'disabled'
}
export interface MainWaitRead { items: MainWaitItem[]; unknown: string[]; error?: string }
export const waitAge = (since: string | null, now: number): number | null => {
  const at = Date.parse(since ?? '')
  return Number.isFinite(at) && at <= now ? now - at : null
}
export const waitAgeLabel = (since: string | null, now: number): string => {
  const age = waitAge(since, now)
  if (age === null) return 'age unknown'
  const minutes = Math.floor(age / 60_000)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
export const waitAlertDue = (since: string | null, lastAttempt: number | null, now: number): boolean =>
  (waitAge(since, now) ?? -1) >= MAIN_WAIT_INTERVAL && (lastAttempt === null || now - lastAttempt >= MAIN_WAIT_INTERVAL)
