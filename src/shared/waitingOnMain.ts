/** All supported textual names for the main First Mate live here. */
const MAIN_NAME = String.raw`(?:first mate(?: \(main\))?|main|main firstmate)`
export const MAIN_NAMES = new RegExp('^' + MAIN_NAME + '$', 'i')
const MAIN_TEXT_PREFIX = new RegExp('^' + MAIN_NAME + '(?::| -)', 'i')
export const namesMain = (value: unknown): boolean => typeof value === 'string' && MAIN_NAMES.test(value.trim())
export const mainHomeLabel = namesMain
/** A populated dependency ID is authoritative; prose mentions are not routing. */
export function mainWaitField(waitingFor: string, waitingForId: string): 'Waiting For' | 'Waiting For ID' | null {
  if (waitingForId.trim()) return namesMain(waitingForId) ? 'Waiting For ID' : null
  return MAIN_TEXT_PREFIX.test(waitingFor.trim()) || /\bvia main\b/i.test(waitingFor) ? 'Waiting For' : null
}
export const MAIN_WAIT_INTERVAL = 4 * 3600_000
export interface ParentAsk { key: string; corr: string | null; state: 'blocked' | 'needs-decision'; at: number | null; text: string }
export interface ParentAsks { status: 'known' | 'unknown'; observed_at: string; items: ParentAsk[] }
/** One resolved key from a parent home's `state/<mate-id>.status`. */
export interface ParentResolution { key: string; at: number }
export interface ParentMateResolutions { status: 'known' | 'unknown'; keys: ParentResolution[] }
/** Resolved keys main recorded, keyed by secondmate id. Unknown mates close nothing. */
export interface ParentResolutions { status: 'known' | 'unknown'; observed_at: string; mates: Record<string, ParentMateResolutions> }
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
