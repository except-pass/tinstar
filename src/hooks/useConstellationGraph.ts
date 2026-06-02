import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { useServerEvents } from './useServerEvents'
import { apiFetch } from '../apiClient'
import {
  emptyGraph, addMember, removeMember, addSnap, removeSnap,
  snapNeighbors as graphSnapNeighbors, slotsForNode as graphSlotsForNode,
  nodesInSlot as graphNodesInSlot, nextFreeSlot,
  type ConstellationGraph, type ConstellationSlot,
} from '../domain/constellationGraph'

// Re-exported from the pure domain module; kept here so existing importers
// (useAddWidget, InfiniteCanvas, tests) continue to resolve it from the hook.
export { nextFreeSlot }

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
  // single PUT each. Every write is stamped with a strictly increasing revision;
  // the overlay is dropped once the server's revision reaches ours (our echo
  // landed — or a newer external write superseded it). Revision-gating, not
  // value-equality, decides this, so an undo whose value happens to equal an
  // earlier server state is never mistaken for that state's echo, and an
  // intermediate echo of an earlier pipelined write (lower rev) never clears the
  // overlay early. Until the overlay clears the UI reflects local edits (snappy).
  const optimisticRef = useRef<ConstellationGraph | null>(null)
  const serverGraphRef = useRef(serverGraph)
  serverGraphRef.current = serverGraph
  // Highest revision we've PUT, keyed by spaceId. Lets same-tick writes keep
  // advancing the revision before the server echo updates serverGraph, and keeps a
  // space's counter monotonic across space switches and failed (rolled-back) PUTs.
  const lastRevRef = useRef<Map<string, number>>(new Map())
  const [, bump] = useReducer((n: number) => n + 1, 0)

  // The provider is reused across space switches, so clear the overlay the moment
  // spaceId changes — synchronously during render — to avoid leaking one space's
  // optimistic graph into another (which the next mutation would PUT cross-space).
  const lastSpaceIdRef = useRef(spaceId)
  if (lastSpaceIdRef.current !== spaceId) {
    lastSpaceIdRef.current = spaceId
    optimisticRef.current = null
  }

  // Drop the overlay once the server's revision is at or past our latest write:
  // either our own echo landed, or a newer write (another tab, a server-side
  // prune) superseded our intent — both make server state authoritative. A lower
  // server revision means our echo is still in flight (it may be replaying an
  // earlier pipelined write), so hold the overlay.
  useEffect(() => {
    if (!optimisticRef.current) return
    if ((serverGraph.rev ?? 0) >= (optimisticRef.current.rev ?? 0)) {
      optimisticRef.current = null
      bump()
    }
  }, [serverGraph])

  const graph = optimisticRef.current ?? serverGraph

  const apply = useCallback((compute: (g: ConstellationGraph) => ConstellationGraph) => {
    const base = optimisticRef.current ?? serverGraphRef.current
    const next = compute(base)
    // No-op click (the mutation returned an unchanged graph): nothing to persist,
    // and the overlay — if any — already reflects this value, so leave it be.
    if (JSON.stringify(next) === JSON.stringify(base)) return
    // Stamp a strictly increasing revision. Use the max of the server's revision
    // and our last-PUT revision so same-tick writes keep advancing before any echo
    // updates serverGraph, and so a write always out-revisions whatever it edits.
    const rev = Math.max(serverGraphRef.current.rev ?? 0, lastRevRef.current.get(spaceId) ?? 0) + 1
    lastRevRef.current.set(spaceId, rev)
    const stamped = { ...next, rev }
    optimisticRef.current = stamped
    bump()
    // On a failed persist, roll back the overlay so reads fall back to
    // serverGraph instead of compounding edits on state the backend rejected.
    // Only roll back if `stamped` is still the active overlay — a newer in-flight
    // edit may have replaced it, and that one owns its own persist/rollback.
    const rollback = () => {
      if (optimisticRef.current === stamped) { optimisticRef.current = null; bump() }
    }
    apiFetch(`/api/constellation-graph/${encodeURIComponent(spaceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stamped),
    }).then(async res => {
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.warn(`[constellation] persist failed: HTTP ${res.status}`, body)
        rollback()
      }
    }).catch(err => {
      console.warn('[constellation] persist failed:', err)
      rollback()
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

  return { store, assign, remove, slotsForNode, nodesInSlot, snapNeighbors, addSnapEdge, removeSnapEdge, graph, applyGraph, update: apply }
}
