import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'
import { DEFAULT_WINDOW_SEC, type SessionTimeline } from '../server/sessions/timeline/types'

interface Opts {
  /** Poll interval; tests override it. */
  intervalMs?: number
}

export interface SessionTimelineState {
  /** null means the session has no resolvable transcript — a real answer (R18). */
  timeline: SessionTimeline | null
  windowSec: number
  loading: boolean
}

/**
 * Poll a session's time-usage reconstruction.
 *
 * Mirrors useTurnLengthObservations: an effect with a cancelled flag, an
 * interval, and cleanup that clears it. The window is an argument rather than a
 * literal so surfacing a selector later is additive (R9a).
 */
export function useSessionTimeline(
  sessionName: string | null,
  windowSec: number = DEFAULT_WINDOW_SEC,
  opts: Opts = {},
): SessionTimelineState {
  const [timeline, setTimeline] = useState<SessionTimeline | null>(null)
  const [loading, setLoading] = useState(true)
  const intervalMs = opts.intervalMs ?? 5000

  useEffect(() => {
    if (!sessionName) { setLoading(false); return }
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        const res = await apiFetch(
          `/api/sessions/${encodeURIComponent(sessionName)}/timeline?windowSec=${windowSec}`)
        if (!res.ok) return
        const json = await res.json()
        if (cancelled) return
        setTimeline(json.ok ? (json.data as SessionTimeline | null) : null)
      } catch {
        // Transient — the next poll retries. The rail keeps showing the last
        // good reconstruction rather than flashing empty.
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    const id = setInterval(() => { void load() }, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [sessionName, windowSec, intervalMs])

  return { timeline, windowSec, loading }
}
