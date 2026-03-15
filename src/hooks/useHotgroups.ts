// src/hooks/useHotgroups.ts
import { useState, useCallback, useEffect } from 'react'

export type HotgroupSlot = '1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'0'
type HotgroupStore = Record<string, string[]> // slot → runId[]

function storageKey(spaceId: string) {
  return `tinstar-hotgroups-v1-${spaceId}`
}

function load(spaceId: string): HotgroupStore {
  try {
    const raw = localStorage.getItem(storageKey(spaceId))
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function save(spaceId: string, store: HotgroupStore) {
  localStorage.setItem(storageKey(spaceId), JSON.stringify(store))
}

export function useHotgroups(spaceId: string, runIds: string[]) {
  const [store, setStore] = useState<HotgroupStore>(() => load(spaceId))

  // Re-load when space changes
  useEffect(() => {
    setStore(load(spaceId))
  }, [spaceId])

  // Prune deleted run IDs — skip when runIds is empty (before SSE snapshot arrives)
  useEffect(() => {
    if (runIds.length === 0) return
    const idSet = new Set(runIds)
    setStore(prev => {
      const next: HotgroupStore = {}
      let changed = false
      for (const [slot, ids] of Object.entries(prev)) {
        const filtered = ids.filter(id => idSet.has(id))
        next[slot] = filtered
        if (filtered.length !== ids.length) changed = true
      }
      if (changed) save(spaceId, next)
      return changed ? next : prev
    })
  }, [runIds, spaceId])

  const assign = useCallback((slot: HotgroupSlot, runId: string) => {
    setStore(prev => {
      const current = prev[slot] ?? []
      if (current.includes(runId)) return prev
      const next = { ...prev, [slot]: [...current, runId] }
      save(spaceId, next)
      return next
    })
  }, [spaceId])

  const remove = useCallback((slot: HotgroupSlot, runId: string) => {
    setStore(prev => {
      const current = prev[slot] ?? []
      if (!current.includes(runId)) return prev
      const next = { ...prev, [slot]: current.filter(id => id !== runId) }
      save(spaceId, next)
      return next
    })
  }, [spaceId])

  /** Returns all slots a given run belongs to */
  const slotsForRun = useCallback((runId: string): HotgroupSlot[] => {
    return (Object.entries(store) as [HotgroupSlot, string[]][])
      .filter(([, ids]) => ids.includes(runId))
      .map(([slot]) => slot)
  }, [store])

  /** Returns all runIds in a slot */
  const runsInSlot = useCallback((slot: HotgroupSlot): string[] => {
    return store[slot] ?? []
  }, [store])

  return { assign, remove, slotsForRun, runsInSlot, store }
}
