// The session/agent that "backs" a canvas node, resolved at runtime from
// constellation membership (there is no persisted node.sessionId). Lifted from
// BrowserWidget's note-submit logic so every widget can submit a pin.

interface ConstellationLike {
  slotsForNode(nodeId: string): string[]
  nodesInSlot(slot: string): string[]
}

const RUN_PREFIX = 'run-'

export function resolveBackingSession(nodeId: string, ctx: ConstellationLike): string | null {
  // 1. A run node IS its session: "run-<sessionId>".
  if (nodeId.startsWith(RUN_PREFIX)) return nodeId.slice(RUN_PREFIX.length) || null
  // 2. Otherwise, a run peer sharing any of this node's slots.
  for (const slot of ctx.slotsForNode(nodeId)) {
    const peer = ctx.nodesInSlot(slot).find(id => id.startsWith(RUN_PREFIX) && id !== nodeId)
    if (peer) return peer.slice(RUN_PREFIX.length) || null
  }
  return null
}
