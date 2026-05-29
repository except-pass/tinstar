import { useCallback, useEffect, useState } from 'react'
import { familyKeys, readJSON, writeJSON } from '../lib/uiPrefs'

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
 * Tracks which run IDs have been hidden by the user (Figma-style eyeball).
 * Hidden runs do not appear on the canvas and are skipped by session cycling,
 * but they still appear (dimmed) in the hierarchy sidebar so the user can
 * re-show them.
 *
 * State is persisted to localStorage and synced across tabs.
 */
export function useHiddenRuns() {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => readFromStorage())

  // Sync when another tab mutates localStorage.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== LS_KEY) return
      setHiddenIds(readFromStorage())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
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

  return { hiddenIds, isHidden, toggleHidden }
}
