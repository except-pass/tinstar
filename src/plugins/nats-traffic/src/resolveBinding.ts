export interface PeerLike { id: string; kind: string; capabilities: string[]; snapped?: boolean }

export type Binding =
  | { mode: 'all' }                       // not in a constellation → firehose
  | { mode: 'runs'; runIds: string[] }    // bound to one or more sessions
  | { mode: 'empty' }                     // in a group with no runs

export function resolveBinding(input: { inConstellation: boolean; peers: PeerLike[] }): Binding {
  if (!input.inConstellation) return { mode: 'all' }
  const runs = input.peers.filter(p => p.kind === 'run')
  if (runs.length === 0) return { mode: 'empty' }
  const snappedRuns = runs.filter(r => r.snapped)
  const chosen = snappedRuns.length > 0 ? snappedRuns : runs
  return { mode: 'runs', runIds: chosen.map(r => r.id) }
}
