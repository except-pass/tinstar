import { useEffect, useState } from 'react'
import { subscribeSeries, pushTick, type SeriesSnapshot } from './telemetrySeriesStore'
import { subscribe as subscribeSnapshot } from './telemetryStore'

/**
 * Subscribe to per-session 5-min series. Two subscriptions under the hood:
 *
 *  1. The series store (backfill + cached ring buffer).
 *  2. The existing snapshot store — every time a new snapshot lands, we
 *     append a sample to the series store. This is what makes the tail tick.
 */
export function useTelemetrySeries(sessionName: string | null): SeriesSnapshot | null {
  const [snap, setSnap] = useState<SeriesSnapshot | null>(null)
  useEffect(() => {
    if (!sessionName) { setSnap(null); return }

    const unsubSeries = subscribeSeries(sessionName, setSnap)

    // Bridge: snapshot store → series store push.
    const unsubSnap = subscribeSnapshot(sessionName, (hud) => {
      if (!hud) return
      pushTick(sessionName, {
        tsSec: Math.floor(Date.now() / 1000),
        cost:   hud.cost.total,
        tokens: hud.tokens.total,
        cache:  hud.cacheHitPct,
        duty:   hud.dutyCycle.value,
      })
    })

    return () => { unsubSeries(); unsubSnap() }
  }, [sessionName])
  return snap
}
