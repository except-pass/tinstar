import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import { DEFAULT_WINDOW_SEC } from '../domain/types'
import type { SessionTimeline } from '../server/sessions/timeline/types'

interface Opts {
  /** Poll interval; tests override it. */
  intervalMs?: number
}

export interface SessionTimelineState {
  /** null means the session has no resolvable transcript — a real answer (R18). */
  timeline: SessionTimeline | null
  windowSec: number
  loading: boolean
  /**
   * Set when the route is failing. Distinct from `timeline: null`, which is the
   * honest "this session has no transcript" answer — without this the two were
   * indistinguishable and a persistently broken route looked like a normal
   * empty state.
   */
  error: string | null
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
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const intervalMs = opts.intervalMs ?? 5000

  useEffect(() => {
    if (!sessionName) { setLoading(false); return }
    let cancelled = false
    inFlight.current = false

    const load = async (): Promise<void> => {
      // A cold parse of a large transcript can outlast the poll interval. Without
      // this guard each tick queued another request and the backlog never
      // drained while the session stayed active.
      if (inFlight.current) return
      inFlight.current = true
      try {
        const res = await apiFetch(
          `/api/sessions/${encodeURIComponent(sessionName)}/timeline?windowSec=${windowSec}`)
        if (cancelled) return
        if (!res.ok) { setError(`HTTP ${res.status}`); return }
        const json = await res.json()
        if (cancelled) return
        if (!json.ok) { setError(json.error?.message ?? 'request failed'); return }
        setError(null)
        setTimeline(json.data as SessionTimeline | null)
      } catch (err) {
        // The last good reconstruction is kept rather than flashing empty, but
        // the failure is now visible instead of silently swallowed.
        if (!cancelled) setError((err as Error).message)
      } finally {
        inFlight.current = false
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    const id = setInterval(() => { void load() }, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [sessionName, windowSec, intervalMs])

  return { timeline, windowSec, loading, error }
}
