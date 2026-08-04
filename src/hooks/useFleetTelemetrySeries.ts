import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'
import type { HudSnapshot } from '../server/observability/types'
import type { HudSeries } from '../server/observability/types'
import {
  mergeSeriesSnapshots,
  seriesSnapshotFromHudSeries,
  type SeriesSnapshot,
} from './telemetrySeriesStore'

const MAX_SAMPLES = 320

function appendCapped<T>(arr: T[], v: T): T[] {
  const out = arr.length >= MAX_SAMPLES ? arr.slice(arr.length - MAX_SAMPLES + 1) : arr.slice()
  out.push(v)
  return out
}

/**
 * Fleet-level series buffer. Restores five minutes from the shared server
 * history, then appends live snapshot ticks.
 *
 * Mirror of useTelemetrySeries's shape so the same <StatSpark> + computeDeltaChip
 * stack works for fleet data.
 */
export function useFleetTelemetrySeries(snapshot: HudSnapshot | null): SeriesSnapshot {
  const [series, setSeries] = useState<SeriesSnapshot>({
    tsSec: [], cost: [], tokens: [], cache: [], duty: [],
  })

  useEffect(() => {
    const controller = new AbortController()
    void apiFetch('/api/telemetry/hud/series', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) return
        const backfill = seriesSnapshotFromHudSeries(await response.json() as HudSeries)
        setSeries(current => mergeSeriesSnapshots(backfill, current))
      })
      .catch(() => {
        // Backfill is best-effort; live snapshots still build a useful tail.
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!snapshot || snapshot.state !== 'ready') return
    const tsSec = Math.floor(Date.now() / 1000)
    setSeries(prev => {
      // Dedup: if a snapshot re-emits in the same wall-clock second, skip.
      if (prev.tsSec.at(-1) === tsSec) return prev
      return {
        tsSec:  appendCapped(prev.tsSec, tsSec),
        cost:   appendCapped(prev.cost, snapshot.cost.total),
        tokens: appendCapped(prev.tokens, snapshot.tokens.total),
        cache:  appendCapped(prev.cache, snapshot.cacheHitPct),
        duty:   appendCapped(prev.duty, snapshot.dutyCycle.value),
      }
    })
  }, [snapshot])

  return series
}
