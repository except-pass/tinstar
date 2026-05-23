import { useEffect, useRef, useState } from 'react'
import type { HudSnapshot } from '../server/observability/types'
import { apiFetch } from '../apiClient'
import { useWindowEvent } from '../lib/windowEvents'

export interface UseTelemetryHudResult {
  snapshot: HudSnapshot | null
}

export function useTelemetryHud(): UseTelemetryHudResult {
  const [snapshot, setSnapshot] = useState<HudSnapshot | null>(null)

  // If an SSE event arrives before the initial fetch resolves, the fetch
  // response is stale — skip its setSnapshot so we don't clobber fresh data.
  const hasLiveEventRef = useRef(false)

  useEffect(() => {
    let aborted = false
    apiFetch('/api/telemetry/hud')
      .then((r) => (r.ok ? r.json() : null))
      .then((snap: HudSnapshot | null) => {
        if (!aborted && snap && !hasLiveEventRef.current) setSnapshot(snap)
      })
      .catch(() => { /* leave snapshot null */ })
    return () => { aborted = true }
  }, [])

  useWindowEvent('tinstar:telemetry:hud', (detail) => {
    const snap = detail as HudSnapshot | undefined
    if (snap) {
      hasLiveEventRef.current = true
      setSnapshot(snap)
    }
  })

  return { snapshot }
}
