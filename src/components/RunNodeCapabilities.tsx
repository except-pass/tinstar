import { useEffect } from 'react'
import type { RunData } from '../domain/types'
import { capabilityRegistry } from '../core/constellationCapabilities'
import { apiFetch } from '../apiClient'

// Legacy runs predate `natsSubscriptions` and only stored a single `natsSubject`.
// A 6-part subject (`tinstar.<space>.<init>.<epic>.<task>.<agent>`) is a direct
// agent subject, so the run also listens on its task-level broadcast. Anything
// else (wildcards, shorter subjects) is used verbatim.
function deriveLegacySubscriptions(natsSubject: string | undefined): string[] {
  if (!natsSubject) return []
  const parts = natsSubject.split('.')
  if (parts.length === 6 && !natsSubject.includes('*') && !natsSubject.includes('>')) {
    return [parts.slice(0, 5).join('.'), natsSubject]
  }
  return [natsSubject]
}

/** Publishes the session.* capabilities for a run's canvas node, independent of
 *  which view component renders it. Mounted by renderNode for every run node.
 *  Keyed by `run-${run.id}` — the unchanged RPC contract the Saloon and
 *  constellation peers invoke; `run.sessionId` is carried in the session.nats payload. */
export function RunNodeCapabilities({ run }: { run: RunData }) {
  // session.prompt: peers RPC into us to send text into the underlying tmux session.
  useEffect(() => {
    return capabilityRegistry.publish(`run-${run.id}`, 'session.prompt', async (args) => {
      const { text } = args as { text: string }
      const res = await apiFetch(`/api/sessions/${run.id}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error(`session.prompt failed: ${res.status}`)
      return null
    })
  }, [run.id])

  // session.nats: constellation peers (e.g. Saloon) retrieve the run's NATS
  // subscriptions, session id, accent color, and broker-health signal.
  useEffect(() => {
    return capabilityRegistry.publish(`run-${run.id}`, 'session.nats', async () => ({
      sessionId: run.sessionId,
      status: run.status,
      subscriptions: run.natsSubscriptions ?? deriveLegacySubscriptions(run.natsSubject),
      color: run.color,
      orphanedAt: run.natsControlOrphanedAt ?? null,
    }))
  }, [run.id, run.sessionId, run.status, run.natsSubscriptions, run.natsSubject, run.color, run.natsControlOrphanedAt])

  return null
}
