import { useEffect, useState } from 'react'
import type { HudSnapshot } from '../server/observability/types'

export function useTelemetrySession(sessionName: string | null): HudSnapshot | null {
  const [snap, setSnap] = useState<HudSnapshot | null>(null)
  useEffect(() => {
    if (!sessionName) { setSnap(null); return }
    let aborted = false
    const fetchNow = async () => {
      try {
        const r = await fetch(`/api/telemetry/session/${encodeURIComponent(sessionName)}`)
        if (!r.ok) return
        const data = (await r.json()) as HudSnapshot
        if (!aborted) setSnap(data)
      } catch {
        // network glitch — next tick will retry
      }
    }
    fetchNow()
    const timer = setInterval(fetchNow, 1_500)
    return () => { aborted = true; clearInterval(timer) }
  }, [sessionName])
  return snap
}
