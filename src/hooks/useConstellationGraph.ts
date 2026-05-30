import { useCallback, useMemo } from 'react'
import { useServerEvents } from './useServerEvents'
import { apiFetch } from '../apiClient'
import {
  emptyGraph, addMember, removeMember, addSnap, removeSnap,
  snapNeighbors as graphSnapNeighbors, slotsForNode as graphSlotsForNode,
  nodesInSlot as graphNodesInSlot,
  type ConstellationGraph, type ConstellationSlot,
} from '../domain/constellationGraph'

const ALL_SLOTS: ConstellationSlot[] = ['1','2','3','4','5','6','7','8','9']

export function nextFreeSlot(g: ConstellationGraph): ConstellationSlot | null {
  const occupied = new Set(g.members.map(m => m.slot))
  return ALL_SLOTS.find(s => !occupied.has(s)) ?? null
}

export function applyAssign(g: ConstellationGraph, slot: ConstellationSlot, nodeId: string): ConstellationGraph {
  return addMember(g, nodeId, slot)
}

export function applyRemove(g: ConstellationGraph, slot: ConstellationSlot, nodeId: string): ConstellationGraph {
  let next = removeMember(g, nodeId, slot)
  const remaining = graphNodesInSlot(next, slot)
  if (remaining.length === 1) next = removeMember(next, remaining[0]!, slot)
  return next
}

export function useConstellationGraph(spaceId: string) {
  const { state } = useServerEvents()
  const graph = useMemo<ConstellationGraph>(
    () => state.constellationGraphs.find(g => g.spaceId === spaceId) ?? emptyGraph(spaceId),
    [state.constellationGraphs, spaceId],
  )

  const persist = useCallback((next: ConstellationGraph) => {
    apiFetch(`/api/constellation-graph/${encodeURIComponent(spaceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => {})
  }, [spaceId])

  const assign = useCallback((slot: ConstellationSlot, nodeId: string) => persist(applyAssign(graph, slot, nodeId)), [graph, persist])
  const remove = useCallback((slot: ConstellationSlot, nodeId: string) => persist(applyRemove(graph, slot, nodeId)), [graph, persist])
  const addSnapEdge = useCallback((a: string, b: string) => persist(addSnap(graph, a, b)), [graph, persist])
  const removeSnapEdge = useCallback((a: string, b: string) => persist(removeSnap(graph, a, b)), [graph, persist])
  const applyGraph = useCallback((next: ConstellationGraph) => persist(next), [persist])

  const store = useMemo<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {}
    for (const m of graph.members) (out[m.slot] ??= []).push(m.widget)
    return out
  }, [graph])

  const slotsForNode = useCallback((nodeId: string) => graphSlotsForNode(graph, nodeId), [graph])
  const nodesInSlot = useCallback((slot: string) => graphNodesInSlot(graph, slot), [graph])
  const snapNeighbors = useCallback((nodeId: string) => graphSnapNeighbors(graph, nodeId), [graph])

  return { store, assign, remove, slotsForNode, nodesInSlot, snapNeighbors, addSnapEdge, removeSnapEdge, graph, applyGraph }
}
