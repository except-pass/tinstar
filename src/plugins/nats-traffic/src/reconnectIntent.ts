/**
 * Decide what the Saloon header's reconnect button should actually do.
 *
 * The button used to always bounce the host's traffic *observer* — which does
 * nothing for an orphaned session (a different layer entirely), so the amber
 * "orphaned → click to reconnect" affordance was a lie. Now:
 *
 *   - any bound session is orphaned → recover *those sessions* (POST each to
 *     /api/sessions/:id/nats-reconnect, which restarts its channel-server)
 *   - otherwise → bounce the observer, i.e. re-sync the host's view of the bus
 *     (the only thing the observer-bounce was ever good for)
 */
export type ReconnectIntent =
  | { kind: 'recover-sessions'; sessionIds: string[] }
  | { kind: 'bounce-observer' }

export function reconnectIntent(
  bound: ReadonlyArray<{ sessionId: string; orphanedAt?: string | null }>,
): ReconnectIntent {
  const orphaned = bound.filter(b => b.orphanedAt).map(b => b.sessionId)
  return orphaned.length ? { kind: 'recover-sessions', sessionIds: orphaned } : { kind: 'bounce-observer' }
}

/** Tooltip text for the reconnect button, matching the resolved intent. */
export function reconnectTooltip(intent: ReconnectIntent): string {
  return intent.kind === 'recover-sessions'
    ? `NATS control socket orphaned — restart channel-server for ${intent.sessionIds.join(', ')}`
    : 'Re-sync NATS traffic view'
}
