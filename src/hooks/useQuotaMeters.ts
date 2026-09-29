import { useSyncExternalStore } from 'react'
import { apiFetch } from '../apiClient'
import type { QuotaMeterSnapshot } from '../server/quota/parse'

const POLL_MS = 5_000

const EMPTY: QuotaMeterSnapshot = {
  checkedAt: null,
  fetchedAt: null,
  commandError: null,
  providers: [],
}

let state: QuotaMeterSnapshot = EMPTY
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let inflight = false
let mountCount = 0

function emit() { for (const listener of listeners) listener() }

async function doFetch() {
  if (inflight) return
  inflight = true
  try {
    const res = await apiFetch('/api/quota')
    if (res.ok) state = await res.json() as QuotaMeterSnapshot
  } catch {
    // Keep the last reading when the cockpit cannot reach the server.
  } finally {
    inflight = false
    emit()
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  mountCount += 1
  if (mountCount === 1) ensurePolling()
  return () => {
    listeners.delete(listener)
    mountCount -= 1
    if (mountCount === 0) stopPolling()
  }
}

export function useQuotaMeters(): QuotaMeterSnapshot {
  return useSyncExternalStore(subscribe, () => state, () => EMPTY)
}
