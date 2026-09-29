import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SSEBroadcaster } from './sse.js'
import type { HudSnapshot, ObservabilityState } from '../observability/types.js'
import { log } from '../logger.js'
import type { TelemetryQuery } from '../observability/query.js'
import type {
  ProviderHistoricalTelemetry,
  ProviderObservationSnapshotFor,
} from '../../domain/provider-capabilities.js'

// How often to broadcast a fresh HUD snapshot to connected SSE clients.
const POLL_INTERVAL_MS = 1_500

type ProviderTelemetryQuery = Pick<TelemetryQuery, 'providerSessionSeries' | 'unifiedTodayHud' | 'unifiedFleetSeries'>

export interface TelemetryApiDeps {
  sse: SSEBroadcaster
  /** Provider-neutral history emitted from normalized native observation events. */
  providerQuery: ProviderTelemetryQuery | null // null when state is 'disabled' or 'downloading'
  getState: () => ObservabilityState
  getProgress: () => HudSnapshot['progress']
  /** Last captured startup/runtime error from the observability stack. Null when healthy or never attempted. */
  getLastError: () => string | null
  restart: () => Promise<void>
  getDefaultUserEmail: () => string
}

export function createTelemetryRoutes(deps: TelemetryApiDeps) {
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let lastSent: string | null = null

  async function buildSnapshot(): Promise<HudSnapshot> {
    const state = deps.getState()
    const base: HudSnapshot = {
      window: 'today',
      state,
      cost: { total: null, byModel: {} },
      tokens: { total: null },
      rate: { perMin: null, perHour: null },
      cacheHitPct: null,
      dutyCycle: { value: null, windowMinutes: 5 },
      progress: deps.getProgress(),
    }
    const lastError = deps.getLastError()
    if (lastError) base.error = lastError
    if (state !== 'ready' || !deps.providerQuery) return base
    try {
      return await deps.providerQuery.unifiedTodayHud({
        userEmail: deps.getDefaultUserEmail(),
        tzOffsetMinutes: new Date().getTimezoneOffset(),
      })
    } catch (err) {
      return { ...base, state: 'degraded', error: (err as Error).message }
    }
  }

  function startPolling(): void {
    if (pollTimer) return
    pollTimer = setInterval(async () => {
      try {
        const snap = await buildSnapshot()
        const serialized = JSON.stringify(snap)
        if (serialized !== lastSent) {
          deps.sse.broadcastEvent('telemetry:hud', snap)
          lastSent = serialized
        }
      } catch (err) {
        // Telemetry polling must never crash the server. Silently drop this tick;
        // the next tick will retry. If the underlying condition persists, callers
        // still see the last-broadcast snapshot until it heals.
        log.warn('telemetry', `poll tick error: ${(err as Error).message}`)
      }
    }, POLL_INTERVAL_MS)
  }

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    corsHeaders: Record<string, string> = {},
  ): Promise<boolean> {
    const json = { 'content-type': 'application/json', ...corsHeaders }
    if (pathname === '/api/telemetry/hud' && req.method === 'GET') {
      startPolling()
      const snap = await buildSnapshot()
      res.writeHead(200, json)
      res.end(JSON.stringify(snap))
      return true
    }
    if (pathname === '/api/telemetry/hud/series' && req.method === 'GET') {
      const endSec = Math.floor(Date.now() / 1_000)
      const empty = emptySeries(endSec, 300, 5)
      if (deps.getState() !== 'ready' || !deps.providerQuery) {
        res.writeHead(200, json)
        res.end(JSON.stringify(empty))
        return true
      }
      try {
        const series = await deps.providerQuery.unifiedFleetSeries({
          userEmail: deps.getDefaultUserEmail(),
          endSec,
          windowSec: 300,
          stepSec: 5,
        })
        res.writeHead(200, json)
        res.end(JSON.stringify(series))
      } catch (error) {
        res.writeHead(200, json)
        res.end(JSON.stringify({ ...empty, state: 'degraded', error: (error as Error).message }))
      }
      return true
    }
    const providerSeriesMatch = pathname.match(
      /^\/api\/telemetry\/provider\/([^/]+)\/session\/([^/]+)\/series$/,
    )
    if (providerSeriesMatch && req.method === 'GET') {
      let providerId: string
      let sessionId: string
      try {
        providerId = decodeURIComponent(providerSeriesMatch[1] ?? '')
        sessionId = decodeURIComponent(providerSeriesMatch[2] ?? '')
      } catch {
        res.writeHead(400, json)
        res.end(JSON.stringify({ error: 'invalid provider or session encoding' }))
        return true
      }
      const checkedAt = new Date().toISOString()
      const source = { id: 'provider-metrics', label: 'Tinstar provider observation history' }
      const unavailable = (
        reason: 'not-observed' | 'temporarily-unavailable' | 'source-error',
        message: string,
      ): ProviderObservationSnapshotFor<'historical-telemetry'> => ({
        kind: 'historical-telemetry',
        providerId,
        scope: { kind: 'session', sessionId },
        source,
        freshness: { state: 'unknown', observedAt: null, checkedAt },
        availability: { state: 'unavailable', reason, message },
      })
      if (deps.getState() !== 'ready' || !deps.providerQuery) {
        res.writeHead(200, json)
        res.end(JSON.stringify(unavailable(
          'temporarily-unavailable',
          'Provider history is not ready',
        )))
        return true
      }
      try {
        const value = await deps.providerQuery.providerSessionSeries({
          providerId,
          sessionId,
          endSec: Math.floor(Date.now() / 1_000),
          windowSec: 300,
          stepSec: 5,
        })
        const observedAt = latestProviderPoint(value)
        if (!observedAt) {
          res.writeHead(200, json)
          res.end(JSON.stringify(unavailable(
            'not-observed',
            'No provider history has been observed for this session',
          )))
          return true
        }
        const snapshot: ProviderObservationSnapshotFor<'historical-telemetry'> = {
          kind: 'historical-telemetry',
          providerId,
          scope: { kind: 'session', sessionId },
          source,
          freshness: { state: 'fresh', observedAt, checkedAt },
          availability: { state: 'available', value },
        }
        res.writeHead(200, json)
        res.end(JSON.stringify(snapshot))
      } catch (error) {
        res.writeHead(200, json)
        res.end(JSON.stringify(unavailable('source-error', (error as Error).message)))
      }
      return true
    }
    if (pathname === '/api/telemetry/restart' && req.method === 'POST') {
      await deps.restart()
      res.writeHead(200, json)
      res.end(JSON.stringify({ ok: true }))
      return true
    }
    return false
  }

  return { handle, startPolling, stopPolling }
}

function latestProviderPoint(value: ProviderHistoricalTelemetry): string | null {
  let latest = Number.NEGATIVE_INFINITY
  let latestAt: string | null = null
  for (const series of value.series) {
    for (const point of series.points) {
      const timestamp = Date.parse(point.at)
      if (timestamp > latest) {
        latest = timestamp
        latestAt = point.at
      }
    }
  }
  return latestAt
}

export type TelemetryRoutes = ReturnType<typeof createTelemetryRoutes>

function emptySeries(endSec: number, windowSec: number, stepSec: number) {
  return {
    startedAt: new Date((endSec - windowSec) * 1_000).toISOString(),
    endedAt: new Date(endSec * 1_000).toISOString(),
    stepSec,
    series: {
      cost: [] as [number, number | null][],
      tokens: [] as [number, number | null][],
      cache: [] as [number, number | null][],
      duty: [] as [number, number | null][],
    },
  }
}
