// src/domain/constellationGraph.ts
// Pure, serializable model of constellation membership as a graph.
// Nodes are widget ids (e.g. 'run-R-241', 'pw-abc') and constellation nodes
// (identified by their keyboard slot '1'..'9'). Edges are relationships:
//  - `snapped` : undirected widget↔widget, written by the magnetic snap.
//  - `member`  : widget→constellation-node (the slot it belongs to).
// All functions are pure and return a new graph; never mutate the input.

export type ConstellationSlot = '1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'

export type SnapEdge = [string, string]
export interface MemberEdge { widget: string; slot: ConstellationSlot }

export interface ConstellationGraph {
  spaceId: string
  snapped: SnapEdge[]
  members: MemberEdge[]
}

export function emptyGraph(spaceId: string): ConstellationGraph {
  return { spaceId, snapped: [], members: [] }
}

function canon(a: string, b: string): SnapEdge {
  return a <= b ? [a, b] : [b, a]
}

export function addSnap(g: ConstellationGraph, a: string, b: string): ConstellationGraph {
  if (a === b) return g
  const [x, y] = canon(a, b)
  if (g.snapped.some(([p, q]) => p === x && q === y)) return g
  return { ...g, snapped: [...g.snapped, [x, y]] }
}

export function removeSnap(g: ConstellationGraph, a: string, b: string): ConstellationGraph {
  const [x, y] = canon(a, b)
  const snapped = g.snapped.filter(([p, q]) => !(p === x && q === y))
  return snapped.length === g.snapped.length ? g : { ...g, snapped }
}

export function snapNeighbors(g: ConstellationGraph, id: string): string[] {
  const out: string[] = []
  for (const [p, q] of g.snapped) {
    if (p === id) out.push(q)
    else if (q === id) out.push(p)
  }
  return out
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

export interface BreakPlan { removeFromSlot: string[]; newGroup: string[] }

export function planBreak(g: ConstellationGraph, aId: string, bId: string, slot: ConstellationSlot, liveIds?: ReadonlySet<string>): BreakPlan {
  // Connectivity is computed over the snap edges among this slot's members.
  // `liveIds`, when given, restricts planning to currently-rendered widgets so
  // stale membership (e.g. deleted widgets not yet pruned from the graph) isn't
  // miscounted when choosing the larger side.
  const ids = new Set<string>(nodesInSlot(g, slot).filter(id => !liveIds || liveIds.has(id)))
  const adj = new Map<string, Set<string>>()
  for (const id of ids) adj.set(id, new Set())
  for (const [p, q] of g.snapped) {
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
  const removeFromSlot = [...other]
  if (keep.length < 2) removeFromSlot.push(...keep)
  const newGroup = other.length >= 2 ? [...other] : []
  return { removeFromSlot, newGroup }
}
