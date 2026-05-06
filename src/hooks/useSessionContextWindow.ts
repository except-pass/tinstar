import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'

export interface SessionContextWindow {
  usedPercentage: number
  windowSize: number
  fetchedAt: string
}

/**
 * Poll the session's live context-window % from the latest CC statusline push.
 * Returns null until a statusline payload for this session has been ingested.
 */
export function useSessionContextWindow(sessionId: string | null): SessionContextWindow | null {
  const [snap, setSnap] = useState<SessionContextWindow | null>(null)
  useEffect(() => {
    if (!sessionId) { setSnap(null); return }
    let aborted = false
    const fetchNow = async () => {
      try {
        const r = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-window`)
        if (!r.ok) return
        const json = await r.json() as { ok: boolean; data: SessionContextWindow | null }
        if (!aborted) setSnap(json.ok ? json.data : null)
      } catch {
        // transient; next tick retries
      }
    }
    fetchNow()
    const id = setInterval(fetchNow, 2_000)
    return () => { aborted = true; clearInterval(id) }
  }, [sessionId])
  return snap
}
