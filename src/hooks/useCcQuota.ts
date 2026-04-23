import { useEffect, useSyncExternalStore } from 'react'

// -------- types mirrored from the server (keep in sync with src/server/cc-quota/types.ts) --------
export interface UsageBucket { utilization: number; resets_at: string }
export interface ExtraUsage   { is_enabled: boolean; used_credits: number | null; currency: string }
export interface RawUsage {
  five_hour: UsageBucket | null
  seven_day: UsageBucket | null
  seven_day_opus: UsageBucket | null
  seven_day_sonnet: UsageBucket | null
  extra_usage: ExtraUsage | null
}
export interface CcQuotaSnapshot {
  fetchedAt: string
  data: RawUsage | null
  error: { code: string; message: string } | null
}

export interface UseCcQuota {
  snapshot: CcQuotaSnapshot | null
  lastRefreshedAt: string | null
  refreshing: boolean
  refresh: () => void
}

const POLL_MS = 5 * 60 * 1000

// -------- module-scoped singleton so the whole app shares one timer/fetch --------
interface SingletonState {
  snapshot: CcQuotaSnapshot | null
  refreshing: boolean
}
let state: SingletonState = { snapshot: null, refreshing: false }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let inflight = false
let mountCount = 0

function emit() { for (const l of listeners) l() }
function setState(patch: Partial<SingletonState>) { state = { ...state, ...patch }; emit() }

async function doFetch(force: boolean) {
  if (inflight) return
  inflight = true
  setState({ refreshing: true })
  try {
    const res = await fetch(force ? '/api/cc-quota?force=1' : '/api/cc-quota')
    if (res.ok) {
      const body = (await res.json()) as CcQuotaSnapshot
      setState({ snapshot: body })
    }
  } catch {
    // network down; keep previous snapshot
  } finally {
    inflight = false
    setState({ refreshing: false })
  }
}

function ensurePolling() {
  if (timer) return
  void doFetch(false)
  timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void doFetch(false)
  }, POLL_MS)
  document.addEventListener('visibilitychange', onVisibility)
}

function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
  document.removeEventListener('visibilitychange', onVisibility)
}

function onVisibility() {
  if (document.visibilityState === 'visible') void doFetch(false)
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  mountCount += 1
  if (mountCount === 1) ensurePolling()
  return () => {
    listeners.delete(l)
    mountCount -= 1
    if (mountCount === 0) stopPolling()
  }
}

const getSnapshot = () => state
const getServerSnapshot = () => ({ snapshot: null, refreshing: false }) as SingletonState

export function useCcQuota(): UseCcQuota {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  useEffect(() => { /* no-op: subscription handles lifecycle */ }, [])
  return {
    snapshot: s.snapshot,
    lastRefreshedAt: s.snapshot?.fetchedAt ?? null,
    refreshing: s.refreshing,
    refresh: () => void doFetch(true),
  }
}

// Only used by tests. Keeps the module pure.
export function __resetCcQuotaSingletonForTests(): void {
  stopPolling()
  state = { snapshot: null, refreshing: false }
  listeners.clear()
  inflight = false
  mountCount = 0
}
