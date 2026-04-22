import { useCallback, useEffect, useState } from 'react'

const LS_KEY = 'tinstar-hidden-runs'

function readFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

function writeToStorage(ids: Set<string>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...ids]))
  } catch {
    /* quota or serialization — ignore */
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
