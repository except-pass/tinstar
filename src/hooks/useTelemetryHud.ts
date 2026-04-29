import { useEffect, useState } from 'react'
import type { HudSnapshot } from '../server/observability/types'
import { apiFetch } from '../apiClient'

export interface UseTelemetryHudResult {
  snapshot: HudSnapshot | null
}

export function useTelemetryHud(): UseTelemetryHudResult {
  const [snapshot, setSnapshot] = useState<HudSnapshot | null>(null)

  useEffect(() => {
    let aborted = false
    // If an SSE event arrives before the initial fetch resolves, the fetch
    // response is stale — skip its setSnapshot so we don't clobber fresh data.
    let hasLiveEvent = false

    // Initial fetch so we have something before SSE pushes.
    apiFetch('/api/telemetry/hud')
      .then((r) => (r.ok ? r.json() : null))
      .then((snap: HudSnapshot | null) => {
        if (!aborted && snap && !hasLiveEvent) setSnapshot(snap)
      })
      .catch(() => { /* leave snapshot null */ })

    // Listen for window events dispatched by the shared SSE singleton.
    const onEvt = (e: Event) => {
      const detail = (e as CustomEvent<HudSnapshot>).detail
      if (detail) {
        hasLiveEvent = true
        setSnapshot(detail)
      }
    }
    window.addEventListener('tinstar:telemetry:hud', onEvt)

    return () => { aborted = true; window.removeEventListener('tinstar:telemetry:hud', onEvt) }
  }, [])

  return { snapshot }
}
