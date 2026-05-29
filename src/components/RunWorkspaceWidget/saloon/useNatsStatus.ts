import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../../apiClient'

/** Observed NATS truth from the channel-server, mirrors the server's
 * NatsLiveStatus. `connection` is the live socket state; `subscriptions` are
 * the subjects the channel-server is *actually* on. */
export interface NatsLiveStatus {
  connection: 'open' | 'degraded' | 'down'
  subscriptions: string[]
  natsState?: string
}

export interface UseNatsStatus {
  status: NatsLiveStatus | null
  loading: boolean
  /** Re-probe now (panel open / dot click). */
  refresh: () => void
}

/**
 * Probe a session's live NATS state from the channel-server control socket.
 * Probes on mount (panel open) and exposes refresh() for dot-click. This is
 * the SSOT for the Saloon dot + topic list — never reads session.nats config.
 */
export function useNatsStatus(sessionName: string): UseNatsStatus {
  const [status, setStatus] = useState<NatsLiveStatus | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionName)}/nats-status`)
      if (res.ok) {
        const body = await res.json() as { data?: NatsLiveStatus }
        if (body?.data) setStatus(body.data)
      }
    } catch {
      // Leave the previous status in place — a failed probe isn't truth about
      // the connection, just about our ability to reach the API this instant.
    } finally {
      setLoading(false)
    }
  }, [sessionName])

  // Probe on mount (panel open) + gentle background poll so an open panel
  // stays fresh without a click. Probing is cheap (one socket round-trip);
  // 20s keeps it well inside the prompt-cache window and feels live.
  useEffect(() => {
    void refresh()
    const id = setInterval(() => { void refresh() }, 20_000)
    return () => clearInterval(id)
  }, [refresh])

  return { status, loading, refresh }
}
