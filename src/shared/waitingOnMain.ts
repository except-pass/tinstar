/** Canonical aliases for identifying the main First Mate home. */
const MAIN_NAME = String.raw`(?:first mate(?: \(main\))?|main|main firstmate)`
export const MAIN_NAMES = new RegExp('^' + MAIN_NAME + '$', 'i')
export const namesMain = (value: unknown): boolean => typeof value === 'string' && MAIN_NAMES.test(value.trim())
export const mainHomeLabel = namesMain
export function waitDependency(waitingFor: string, waitingForId = ''): string {
  if (waitingForId.trim()) return waitingForId.trim()
  const entry = waitingFor.trim()
  const workflow = /^Dependency:\s*([^|]*)/i.exec(entry)
  if (workflow) return workflow[1]!.trim()
  const legacy = /^(.*?)(?::| -)/.exec(entry)
  if (legacy) return legacy[1]!.trim()
  return /\bvia main\b/i.test(entry) ? 'main' : entry
}
export const MAIN_WAIT_INTERVAL = 4 * 3600_000
/** Inbox re-nudge gap, and how long an open nudge stays quiet on Overview. */
export const MAIN_WAIT_NUDGE_INTERVAL = 2 * 3600_000
export interface ParentAsk { key: string; corr: string | null; state: 'blocked' | 'needs-decision'; at: number | null; text: string }
export interface ParentAsks { status: 'known' | 'unknown'; observed_at: string; items: ParentAsk[] }
/** One resolved key from a parent home's `state/<mate-id>.status`. */
export interface ParentResolution { key: string; at: number }
export interface ParentMateResolutions { status: 'known' | 'unknown'; keys: ParentResolution[] }
/** Resolved keys main recorded, keyed by secondmate id. Unknown mates close nothing. */
export interface ParentResolutions { status: 'known' | 'unknown'; observed_at: string; mates: Record<string, ParentMateResolutions> }
export interface MainWaitItem {
  id: string; source: string; kind: 'card' | 'mate'; label: string; key: string; text: string
  /** Owner mentions stay on Will's own waits. First Mate and mate waits use the inbox. */
  audience?: 'owner' | 'first-mate'
  since: string | null; ageBasis: 'status timestamp' | 'at least'; url: string | null; fresh: boolean
  alert?: 'mentioned' | 'plain-comment' | 'unconfirmed' | 'failed' | 'disabled'
  /** When the first inbox nudge for this still-open item was announced. */
  nudgedAt?: string | null
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
/** A fresh item is due on first sight and again once the last nudge is two hours old. */
export const nudgeDue = (lastAt: number | null, now: number): boolean =>
  lastAt === null || now - lastAt >= MAIN_WAIT_NUDGE_INTERVAL
/** The owner indicator waits until a nudge has stayed open for the full two hours. */
export const nudgeUnanswered = (nudgedAt: string | null | undefined, now: number): boolean => {
  const at = Date.parse(nudgedAt ?? '')
  return Number.isFinite(at) && at <= now && now - at >= MAIN_WAIT_NUDGE_INTERVAL
}
