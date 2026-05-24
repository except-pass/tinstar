// src/hooks/useConstellations.ts
import { useState, useCallback, useEffect, useMemo } from 'react'
import { familyKeys, readJSON, writeJSON } from '../lib/uiPrefs'

export type ConstellationSlot = '1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'
type ConstellationStore = Record<string, string[]> // slot → nodeId[]

function load(spaceId: string): ConstellationStore {
  return readJSON<ConstellationStore>(familyKeys.constellations(spaceId), {})
}

function save(spaceId: string, store: ConstellationStore) {
  writeJSON(familyKeys.constellations(spaceId), store)
}

export function useConstellations(spaceId: string, nodeIds: string[]) {
  const [store, setStore] = useState<ConstellationStore>(() => load(spaceId))

  // Re-load when space changes
  useEffect(() => {
    setStore(load(spaceId))
  }, [spaceId])

  // Prune deleted node IDs — skip when nodeIds is empty (before SSE snapshot arrives)
  useEffect(() => {
    if (nodeIds.length === 0) return
    const idSet = new Set(nodeIds)
    setStore(prev => {
      const next: ConstellationStore = {}
      let changed = false
      for (const [slot, ids] of Object.entries(prev)) {
        const filtered = ids.filter(id => idSet.has(id))
        next[slot] = filtered
        if (filtered.length !== ids.length) changed = true
      }
      if (changed) save(spaceId, next)
      return changed ? next : prev
    })
  }, [nodeIds, spaceId])

  const assign = useCallback((slot: ConstellationSlot, nodeId: string) => {
    setStore(prev => {
      const current = prev[slot] ?? []
      if (current.includes(nodeId)) return prev
      const next = { ...prev, [slot]: [...current, nodeId] }
      save(spaceId, next)
      return next
    })
  }, [spaceId])

  const remove = useCallback((slot: ConstellationSlot, nodeId: string) => {
    setStore(prev => {
      const current = prev[slot] ?? []
      if (!current.includes(nodeId)) return prev
      const next = { ...prev, [slot]: current.filter(id => id !== nodeId) }
      save(spaceId, next)
      return next
    })
  }, [spaceId])

  // Inverted index: nodeId → slots[], recomputed only when store changes
  const nodeToSlots = useMemo(() => {
    const map = new Map<string, ConstellationSlot[]>()
    for (const [slot, ids] of Object.entries(store) as [ConstellationSlot, string[]][]) {
      for (const id of ids) {
        const existing = map.get(id)
        if (existing) existing.push(slot)
        else map.set(id, [slot])
      }
    }
    return map
  }, [store])

  /** Returns all slots a given node belongs to */
  const slotsForNode = useCallback((nodeId: string): ConstellationSlot[] => {
    return nodeToSlots.get(nodeId) ?? []
  }, [nodeToSlots])

  /** Returns all node IDs in a slot */
  const nodesInSlot = useCallback((slot: ConstellationSlot): string[] => {
    return store[slot] ?? []
  }, [store])

  return { assign, remove, slotsForNode, nodesInSlot, store }
}
