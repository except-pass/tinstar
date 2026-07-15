import { useCallback, useEffect, useState } from 'react'
import { familyKeys, readJSON, writeJSON } from '../lib/uiPrefs'
import { EV, dispatchWindowEvent, useWindowEvent } from '../lib/windowEvents'

const LS_KEY = familyKeys.hiddenRuns

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
 * every run removal. Dispatches the same-tab `hiddenRunsChanged` event so a
 * `useHiddenRuns` hook in this tab picks up the change without a reload — the
 * native `storage` event only fires in *other* tabs.
 */
export function removeHiddenRunId(runId: string): void {
  const ids = readFromStorage()
  if (!ids.delete(runId)) return
  writeToStorage(ids)
  dispatchWindowEvent(EV.hiddenRunsChanged, undefined)
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

  // Cross-tab sync: another tab mutating localStorage fires the native
  // `storage` event (which never fires in the writing tab).
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== LS_KEY) return
      setHiddenIds(readFromStorage())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Same-tab sync: a non-React writer in THIS tab (e.g. the SSE run-removed
  // prune calling `removeHiddenRunId`) fires `hiddenRunsChanged` so the hook
  // re-reads without a reload — `storage` alone would miss it.
  useWindowEvent(EV.hiddenRunsChanged, () => setHiddenIds(readFromStorage()))

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
