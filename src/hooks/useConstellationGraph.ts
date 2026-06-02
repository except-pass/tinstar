import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
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
  const serverGraph = useMemo<ConstellationGraph>(
    () => state.constellationGraphs.find(g => g.spaceId === spaceId) ?? emptyGraph(spaceId),
    [state.constellationGraphs, spaceId],
  )

  // Optimistic working copy held in a ref so back-to-back mutations in the same
  // tick compose off the latest value (not a stale render snapshot), then fire a
  // single PUT each. The overlay is dropped once the server echoes the matching
  // graph back via SSE; until then the UI reflects the local edits immediately
  // (snappy). The server stores the doc verbatim, so the echo equals what we set.
  const optimisticRef = useRef<ConstellationGraph | null>(null)
  const serverGraphRef = useRef(serverGraph)
  serverGraphRef.current = serverGraph
  // Count of PUTs we still expect an echo for. While zero, any server graph that
  // diverges from our overlay came from elsewhere (another tab/client, server
  // normalization) and means our overlay is stale — drop it rather than pin it.
  const pendingWrites = useRef(0)
  const [, bump] = useReducer((n: number) => n + 1, 0)

  // The provider is reused across space switches, so clear the overlay the moment
  // spaceId changes — synchronously during render — to avoid leaking one space's
  // optimistic graph into another (which the next mutation would PUT cross-space).
  const lastSpaceIdRef = useRef(spaceId)
  if (lastSpaceIdRef.current !== spaceId) {
    lastSpaceIdRef.current = spaceId
    optimisticRef.current = null
    pendingWrites.current = 0
  }

  useEffect(() => {
    if (!optimisticRef.current) return
    // Server echoed our optimistic write — confirmed, drop the overlay.
    if (JSON.stringify(optimisticRef.current) === JSON.stringify(serverGraph)) {
      optimisticRef.current = null
      bump()
      return
    }
    // Divergent server graph with no write in flight: the overlay is stale, so
    // surface the authoritative server state instead of pinning the overlay.
    if (pendingWrites.current === 0) {
      optimisticRef.current = null
      bump()
    }
  }, [serverGraph])

  const graph = optimisticRef.current ?? serverGraph

  const apply = useCallback((compute: (g: ConstellationGraph) => ConstellationGraph) => {
    const base = optimisticRef.current ?? serverGraphRef.current
    const next = compute(base)
    // No-op vs the server's current doc: skip the PUT (the docstore would
    // short-circuit it and emit no echo, which would leave the overlay stuck)
    // and drop any overlay so reads fall back to serverGraph.
    if (JSON.stringify(next) === JSON.stringify(serverGraphRef.current)) {
      if (optimisticRef.current) { optimisticRef.current = null; bump() }
      return
    }
    optimisticRef.current = next
    bump()
    // On a failed persist, roll back the overlay so reads fall back to
    // serverGraph instead of compounding edits on state the backend rejected.
    // Only roll back if `next` is still the active overlay — a newer in-flight
    // edit may have replaced it, and that one owns its own persist/rollback.
    const rollback = () => {
      if (optimisticRef.current === next) { optimisticRef.current = null; bump() }
    }
    pendingWrites.current++
    apiFetch(`/api/constellation-graph/${encodeURIComponent(spaceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).then(async res => {
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.warn(`[constellation] persist failed: HTTP ${res.status}`, body)
        rollback()
      }
    }).catch(err => {
      console.warn('[constellation] persist failed:', err)
      rollback()
    }).finally(() => {
      pendingWrites.current = Math.max(0, pendingWrites.current - 1)
    })
  }, [spaceId])

  const assign = useCallback((slot: ConstellationSlot, nodeId: string) => apply(g => applyAssign(g, slot, nodeId)), [apply])
  const remove = useCallback((slot: ConstellationSlot, nodeId: string) => apply(g => applyRemove(g, slot, nodeId)), [apply])
  const addSnapEdge = useCallback((a: string, b: string) => apply(g => addSnap(g, a, b)), [apply])
  const removeSnapEdge = useCallback((a: string, b: string) => apply(g => removeSnap(g, a, b)), [apply])
  const applyGraph = useCallback((next: ConstellationGraph) => apply(() => next), [apply])

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
