import { useEffect, useState } from 'react'
import type { HudSnapshot } from '../server/observability/types'
import { subscribe } from './telemetryStore'

/**
 * Subscribe to telemetry for a single session.
 *
 * Thin wrapper around the shared `telemetryStore` singleton — N callers across
 * the app result in ONE batched request per 1.5s tick, not N. See
 * `src/hooks/telemetryStore.ts` for why this matters.
 */
export function useTelemetrySession(sessionName: string | null): HudSnapshot | null {
  const [snap, setSnap] = useState<HudSnapshot | null>(null)
  useEffect(() => {
    if (!sessionName) { setSnap(null); return }
    const unsubscribe = subscribe(sessionName, setSnap)
    return unsubscribe
  }, [sessionName])
  return snap
}
