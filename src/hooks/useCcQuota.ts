import { useSyncExternalStore } from 'react'

// -------- types mirrored from the server (keep in sync with src/server/cc-quota/types.ts) --------
export interface UsageBucket { utilization: number; resets_at: string }
export interface RawUsage {
  five_hour: UsageBucket | null
  seven_day: UsageBucket | null
}
export interface CcQuotaSnapshot {
  fetchedAt: string
  data: RawUsage | null
  error: { code: string; message: string } | null
}

export interface UseCcQuota {
  snapshot: CcQuotaSnapshot | null
}

const POLL_MS = 5 * 60 * 1000

// -------- module-scoped singleton so the whole app shares one timer/fetch --------
interface SingletonState {
  snapshot: CcQuotaSnapshot | null
}
let state: SingletonState = { snapshot: null }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let inflight = false
let mountCount = 0

function emit() { for (const l of listeners) l() }
function setState(patch: Partial<SingletonState>) { state = { ...state, ...patch }; emit() }

async function doFetch() {
  if (inflight) return
  inflight = true
  try {
    const res = await fetch('/api/cc-quota')
    if (res.ok) {
      const body = (await res.json()) as CcQuotaSnapshot
      setState({ snapshot: body })
    }
  } catch {
    // network down; keep previous snapshot
  } finally {
    inflight = false
  }
}

function ensurePolling() {
  if (timer) return
  void doFetch()
  timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void doFetch()
  }, POLL_MS)
  document.addEventListener('visibilitychange', onVisibility)
}

function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
  document.removeEventListener('visibilitychange', onVisibility)
}

function onVisibility() {
  if (document.visibilityState === 'visible') void doFetch()
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
const getServerSnapshot = () => ({ snapshot: null }) as SingletonState

export function useCcQuota(): UseCcQuota {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return { snapshot: s.snapshot }
}

// Only used by tests. Keeps the module pure.
export function __resetCcQuotaSingletonForTests(): void {
  stopPolling()
  state = { snapshot: null }
  listeners.clear()
  inflight = false
  mountCount = 0
}
