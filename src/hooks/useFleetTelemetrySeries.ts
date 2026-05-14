import { useEffect, useState } from 'react'
import type { HudSnapshot } from '../server/observability/types'
import type { SeriesSnapshot } from './telemetrySeriesStore'

const MAX_SAMPLES = 320

function appendCapped<T>(arr: T[], v: T): T[] {
  const out = arr.length >= MAX_SAMPLES ? arr.slice(arr.length - MAX_SAMPLES + 1) : arr.slice()
  out.push(v)
  return out
}

/**
 * Fleet-level series buffer. No server backfill — accrues snapshot ticks over the
 * mount lifetime. CanvasHud is a singleton so a per-mount ring buffer is fine.
 *
 * Mirror of useTelemetrySeries's shape so the same <StatSpark> + computeDeltaChip
 * stack works for fleet data.
 */
export function useFleetTelemetrySeries(snapshot: HudSnapshot | null): SeriesSnapshot {
  const [series, setSeries] = useState<SeriesSnapshot>({
    tsSec: [], cost: [], tokens: [], cache: [], duty: [],
  })

  useEffect(() => {
    if (!snapshot || snapshot.state !== 'ready') return
    const tsSec = Math.floor(Date.now() / 1000)
    setSeries(prev => {
      // Dedup: if a snapshot re-emits in the same wall-clock second, skip.
      if (prev.tsSec.at(-1) === tsSec) return prev
      return {
        tsSec:  appendCapped(prev.tsSec, tsSec),
        cost:   appendCapped(prev.cost, snapshot.cost.total),
        tokens: appendCapped(prev.tokens, snapshot.rate.perMin),
        cache:  appendCapped(prev.cache, snapshot.cacheHitPct),
        duty:   appendCapped(prev.duty, snapshot.dutyCycle.value),
      }
    })
  }, [snapshot])

  return series
}
