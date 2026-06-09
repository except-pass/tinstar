// src/domain/constellationGraph.ts
// Pure, serializable model of constellation membership as a graph.
// Nodes are widget ids (e.g. 'run-R-241', 'pw-abc') and constellation nodes
// (identified by their keyboard slot '1'..'9'). Edges are relationships:
//  - `snapped` : undirected widget↔widget, written by the magnetic snap.
//  - `member`  : widget→constellation-node (the slot it belongs to).
// All functions are pure and return a new graph; never mutate the input.

import type { AnchorPair } from './anchors'

export type ConstellationSlot = '1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'

export interface SnapEdge {
  nodes: [string, string]            // canon-ordered (nodes[0] <= nodes[1])
  anchors?: AnchorPair               // aligned to nodes order; undefined = legacy/edge-flush
}
export interface MemberEdge { widget: string; slot: ConstellationSlot }

export interface ConstellationGraph {
  spaceId: string
  snapped: SnapEdge[]
  members: MemberEdge[]
  // Monotonic write revision. Each persisted write carries a strictly increasing
  // rev so the server can reject out-of-order/stale writes and the client can tell
  // its own echo from a coincidentally-equal earlier state. Absent on legacy/empty
  // graphs and treated as 0.
  rev?: number
}

export function emptyGraph(spaceId: string): ConstellationGraph {
  return { spaceId, snapped: [], members: [] }
}

function canon(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a]
}

export function addSnap(g: ConstellationGraph, a: string, b: string, anchors?: AnchorPair): ConstellationGraph {
  if (a === b) return g
  const [x, y] = canon(a, b)
  if (g.snapped.some(e => e.nodes[0] === x && e.nodes[1] === y)) return g
  // Align the anchor pair to canon order: anchors arg is [anchorOnA, anchorOnB];
  // if canon swapped the nodes, swap the anchors too so anchors[i] ↔ nodes[i].
  const aligned: AnchorPair | undefined = anchors ? (a <= b ? anchors : [anchors[1], anchors[0]]) : undefined
  const edge: SnapEdge = aligned ? { nodes: [x, y], anchors: aligned } : { nodes: [x, y] }
  return { ...g, snapped: [...g.snapped, edge] }
}

export function removeSnap(g: ConstellationGraph, a: string, b: string): ConstellationGraph {
  const [x, y] = canon(a, b)
  const snapped = g.snapped.filter(e => !(e.nodes[0] === x && e.nodes[1] === y))
  return snapped.length === g.snapped.length ? g : { ...g, snapped }
}

export function snapNeighbors(g: ConstellationGraph, id: string): string[] {
  const out: string[] = []
  for (const { nodes: [p, q] } of g.snapped) {
    if (p === id) out.push(q)
    else if (q === id) out.push(p)
  }
  return out
}

/** Normalize a graph that may contain legacy `[a,b]` tuple edges into structured
 *  edges. Idempotent on already-structured graphs. Call on hydrate / on PUT. */
export function migrateSnapEdges(g: ConstellationGraph): ConstellationGraph {
  let changed = false
  const snapped: SnapEdge[] = g.snapped.map(e => {
    if (Array.isArray(e)) {
      changed = true
      const [x, y] = canon((e as unknown as [string, string])[0], (e as unknown as [string, string])[1])
      return { nodes: [x, y] }
    }
    return e
  })
  return changed ? { ...g, snapped } : g
}

export function addMember(g: ConstellationGraph, widget: string, slot: ConstellationSlot): ConstellationGraph {
  if (g.members.some(m => m.widget === widget && m.slot === slot)) return g
  return { ...g, members: [...g.members, { widget, slot }] }
}

export function removeMember(g: ConstellationGraph, widget: string, slot: ConstellationSlot): ConstellationGraph {
  const members = g.members.filter(m => !(m.widget === widget && m.slot === slot))
  return members.length === g.members.length ? g : { ...g, members }
}

export function slotsForNode(g: ConstellationGraph, widget: string): ConstellationSlot[] {
  return g.members.filter(m => m.widget === widget).map(m => m.slot)
}

export function nodesInSlot(g: ConstellationGraph, slot: string): string[] {
  return g.members.filter(m => m.slot === slot).map(m => m.widget)
}

const ALL_SLOTS: ConstellationSlot[] = ['1','2','3','4','5','6','7','8','9']

/** The lowest-numbered slot with no members, or null when all nine are taken. */
export function nextFreeSlot(g: ConstellationGraph): ConstellationSlot | null {
  const occupied = new Set(g.members.map(m => m.slot))
  return ALL_SLOTS.find(s => !occupied.has(s)) ?? null
}

export interface BreakPlan { removeFromSlot: string[]; newGroup: string[] }

export function planBreak(g: ConstellationGraph, aId: string, bId: string, slot: ConstellationSlot, liveIds?: ReadonlySet<string>): BreakPlan {
  // Connectivity is computed over the snap edges among this slot's members.
  // `liveIds`, when given, restricts planning to currently-rendered widgets so
  // stale membership (e.g. deleted widgets not yet pruned from the graph) isn't
  // miscounted when choosing the larger side.
  const slotMembers = nodesInSlot(g, slot)
  const ids = new Set<string>(slotMembers.filter(id => !liveIds || liveIds.has(id)))
  // Stale members (in the slot but no longer live) are always pruned so the slot
  // doesn't stay silently occupied by a deleted widget after the break.
  const stale = liveIds ? slotMembers.filter(id => !liveIds.has(id)) : []
  const adj = new Map<string, Set<string>>()
  for (const id of ids) adj.set(id, new Set())
  for (const { nodes: [p, q] } of g.snapped) {
    if (!ids.has(p) || !ids.has(q)) continue
    if ((p === aId && q === bId) || (p === bId && q === aId)) continue // the broken edge
    adj.get(p)!.add(q)
    adj.get(q)!.add(p)
  }
  const compA = new Set<string>([aId])
  const queue = [aId]
  while (queue.length) {
    const cur = queue.shift()!
    for (const nb of adj.get(cur) ?? []) if (!compA.has(nb)) { compA.add(nb); queue.push(nb) }
  }
  if (compA.has(bId)) return { removeFromSlot: [], newGroup: [] } // still connected
  const sideA = [...ids].filter(id => compA.has(id))
  const sideB = [...ids].filter(id => !compA.has(id))
  // `other` is the smaller side by construction, so it always leaves the slot.
  // `keep` only leaves too when it's been reduced to a lone widget (no 1-member
  // constellations). `other` forms its own group only if it still has ≥2 members.
  const [keep, other] = sideA.length >= sideB.length ? [sideA, sideB] : [sideB, sideA]
  const removeFromSlot = [...other, ...stale]
  if (keep.length < 2) removeFromSlot.push(...keep)
  const newGroup = other.length >= 2 ? [...other] : []
  return { removeFromSlot, newGroup }
}
