import { useCallback, useMemo, useSyncExternalStore } from 'react'

const MAX_ITEMS = 20

const store = new Map<string, readonly string[]>()
const listeners = new Map<string, Set<() => void>>()

const EMPTY: readonly string[] = Object.freeze([])

function notify(sessionId: string) {
  listeners.get(sessionId)?.forEach(fn => fn())
}

function getSnapshot(sessionId: string): readonly string[] {
  return store.get(sessionId) ?? EMPTY
}

function subscribe(sessionId: string, cb: () => void): () => void {
  let set = listeners.get(sessionId)
  if (!set) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(cb)
  return () => {
    set!.delete(cb)
    if (set!.size === 0) listeners.delete(sessionId)
  }
}

/**
 * Record a prompt without requiring the composer to be mounted. Session
 * creation uses this to preserve the initial prompt before provisioning (and
 * therefore before ttyd) has completed.
 */
export function pushPromptHistory(sessionId: string, text: string): void {
  const trimmed = text.trim()
  if (!sessionId || !trimmed) return
  const current = store.get(sessionId) ?? []
  const next = [trimmed, ...current].slice(0, MAX_ITEMS)
  store.set(sessionId, next)
  notify(sessionId)
}

/** Test-only reset for the module-scoped prompt store. */
export function _resetPromptHistoryForTests(): void {
  store.clear()
  listeners.clear()
}

export interface PromptHistory {
  history: readonly string[]
  push: (text: string) => void
}

export function usePromptHistory(sessionId: string | undefined): PromptHistory {
  const subscribeStable = useCallback(
    (cb: () => void) => (sessionId ? subscribe(sessionId, cb) : () => {}),
    [sessionId],
  )
  const getSnapshotStable = useCallback(
    () => (sessionId ? getSnapshot(sessionId) : EMPTY),
    [sessionId],
  )

  const history = useSyncExternalStore(subscribeStable, getSnapshotStable, getSnapshotStable)

  const push = useCallback(
    (text: string) => {
      if (!sessionId) return
      pushPromptHistory(sessionId, text)
    },
    [sessionId],
  )

  return useMemo(() => ({ history, push }), [history, push])
}
