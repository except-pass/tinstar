import { useCallback, useEffect, useState } from 'react'
import { familyKeys, readJSON, writeJSON } from '../lib/uiPrefs'

const LS_KEY = familyKeys.hiddenRuns

/** Same-tab change signal. The DOM `storage` event only fires in *other* tabs,
 *  so a mutation made outside the React hook (e.g. the SSE run-removed reducer
 *  calling `removeHiddenRunId`) needs its own event for the hook in this tab to
 *  re-read. Cross-tab sync still rides the native `storage` event. */
const CHANGE_EVENT = 'tinstar-hidden-runs-changed'

function readFromStorage(): Set<string> {
  const arr = readJSON<string[]>(LS_KEY, [])
  if (!Array.isArray(arr)) return new Set()
  return new Set(arr.filter((v): v is string => typeof v === 'string'))
}

function writeToStorage(ids: Set<string>): void {
  writeJSON(LS_KEY, [...ids])
}

/**
 * Remove a single run id from the hidden set, outside React.
 *
 * This is the load-bearing fix for hidden-runs "ghosting": run ids are the
 * (reusable) session name, so a hidden-then-deleted run leaves its id in the
 * set forever, and a later same-named run is born hidden. Pruning on removal —
 * the universal signal every tab sees via the SSE run-removed delta — stops the
 * stale id from ever outliving the run that created it.
 *
 * No-ops (no write, no event) when the id is absent, so it's cheap to call on
 * every run removal. Dispatches CHANGE_EVENT so a `useHiddenRuns` hook in the
 * same tab picks up the change without a reload.
 */
export function removeHiddenRunId(runId: string): void {
  const ids = readFromStorage()
  if (!ids.delete(runId)) return
  writeToStorage(ids)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  }
}

/**
 * Tracks which run IDs have been hidden by the user (Figma-style eyeball).
 * Hidden runs do not appear on the canvas and are skipped by session cycling,
 * but they still appear (dimmed) in the hierarchy sidebar so the user can
 * re-show them.
 *
 * State is persisted to localStorage and synced across tabs.
 */
export function useHiddenRuns() {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => readFromStorage())

  // Sync when another tab mutates localStorage (native `storage` event), or
  // when this tab mutates it outside the hook via `removeHiddenRunId`
  // (same-tab CHANGE_EVENT — `storage` does not fire in the writing tab).
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== LS_KEY) return
      setHiddenIds(readFromStorage())
    }
    function onLocalChange() {
      setHiddenIds(readFromStorage())
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(CHANGE_EVENT, onLocalChange)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(CHANGE_EVENT, onLocalChange)
    }
  }, [])

  const toggleHidden = useCallback((runId: string) => {
    setHiddenIds(prev => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      writeToStorage(next)
      return next
    })
  }, [])

  const isHidden = useCallback((runId: string) => hiddenIds.has(runId), [hiddenIds])

  // Unconditionally drop a run from the hidden set (used on delete). Unlike
  // toggleHidden, this never re-hides; shares the same storage + CHANGE_EVENT
  // path as removeHiddenRunId so React and non-React callers stay in sync.
  const removeHidden = useCallback((runId: string) => {
    removeHiddenRunId(runId)
  }, [])

  return { hiddenIds, isHidden, toggleHidden, removeHidden }
}
