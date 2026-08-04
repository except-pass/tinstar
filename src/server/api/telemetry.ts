import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SSEBroadcaster } from './sse.js'
import type { HudSnapshot, ObservabilityState } from '../observability/types.js'
import { log } from '../logger.js'
import { makeFakeHud, makeFakeSeries } from '../observability/fast-sim.js'
import { getRecentObservations } from '../observability/turn-length.js'
import type { ClaudeTelemetryQuery } from '../providers/claude-observation-adapter.js'
import type {
  TelemetryQuery,
  UnifiedSessionTelemetryIdentity,
} from '../observability/query.js'
import type {
  ProviderHistoricalTelemetry,
  ProviderObservationSnapshotFor,
} from '../../domain/provider-capabilities.js'

// How often to broadcast a fresh HUD snapshot to connected SSE clients.
const POLL_INTERVAL_MS = 1_500

type ProviderTelemetryQuery = Pick<TelemetryQuery, 'providerSessionSeries'>
  & Partial<Pick<
    TelemetryQuery,
    'unifiedTodayHud' | 'unifiedSessionHud' | 'unifiedSessionSeries' | 'unifiedFleetSeries'
  >>

type UnifiedTelemetryQuery = Pick<
  TelemetryQuery,
  'unifiedTodayHud' | 'unifiedSessionHud' | 'unifiedSessionSeries'
>

export interface TelemetryApiDeps {
  sse: SSEBroadcaster
  /** Provider-owned compatibility projection over the historical observation source. */
  query: ClaudeTelemetryQuery | null // null when state is 'disabled' or 'downloading'
  /** Provider-neutral history emitted from normalized native observation events. */
  providerQuery?: ProviderTelemetryQuery | null
  getState: () => ObservabilityState
  getProgress: () => HudSnapshot['progress']
  /** Last captured startup/runtime error from the observability stack. Null when healthy or never attempted. */
  getLastError: () => string | null
  restart: () => Promise<void>
  getDefaultUserEmail: () => string
  /** Resolve a tinstar session name to its Claude Code conversation UUID. */
  getSessionConversationId: (sessionName: string) => string | null
  /** Resolve the provider plus every native alias for one managed session. */
  getSessionTelemetryIdentity?: (
    sessionName: string,
  ) => UnifiedSessionTelemetryIdentity | null
  /** Inverse of getSessionConversationId — map conversation UUIDs back to tinstar run IDs. */
  getRunIdsForConversationIds: (conversationIds: string[]) => string[]
}

export function createTelemetryRoutes(deps: TelemetryApiDeps) {
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let lastSent: string | null = null

  async function buildSnapshot(sessionName?: string): Promise<HudSnapshot> {
    if (process.env.TINSTAR_FAST_SIM === '1') {
      const fake = makeFakeHud()
      if (sessionName) {
        const SESSION_SCALE = 0.3
        const scaledByModel: Record<string, number> = {}
        for (const [model, cost] of Object.entries(fake.cost.byModel)) {
          scaledByModel[model] = cost * SESSION_SCALE
        }
        return {
          ...fake,
          cost: { total: (fake.cost.total ?? 0) * SESSION_SCALE, byModel: scaledByModel },
          tokens: { total: Math.floor((fake.tokens.total ?? 0) * SESSION_SCALE) },
          rate: {
            perMin: (fake.rate.perMin ?? 0) * SESSION_SCALE,
            perHour: (fake.rate.perHour ?? 0) * SESSION_SCALE,
          },
          dutyCycle: {
            value: fake.dutyCycle.value == null ? null : Math.max(0, Math.min(1, fake.dutyCycle.value * SESSION_SCALE)),
            windowMinutes: fake.dutyCycle.windowMinutes,
          },
        }
      }
      return fake
    }
    const state = deps.getState()
    const base: HudSnapshot = {
      window: 'today',
      state,
      cost: { total: null, byModel: {} },
      tokens: { total: null },
      rate: { perMin: null, perHour: null },
      cacheHitPct: null,
      dutyCycle: { value: null, windowMinutes: 5 },
      burningRunIds: [],
      progress: deps.getProgress(),
    }
    const lastError = deps.getLastError()
    if (lastError) base.error = lastError
    const unifiedQuery = getUnifiedTelemetryQuery(deps.providerQuery)
    if (state !== 'ready' || (!unifiedQuery && !deps.query)) return base
    const tzOffsetMinutes = new Date().getTimezoneOffset()
    try {
      const identity = sessionName ? resolveSessionTelemetryIdentity(deps, sessionName) : null
      const [hud, burningConvIds] = await Promise.all([
        unifiedQuery
          ? sessionName
            ? identity
              ? unifiedQuery.unifiedSessionHud(identity, {
                  userEmail: deps.getDefaultUserEmail(),
                  tzOffsetMinutes,
                })
              : Promise.resolve(base)
            : unifiedQuery.unifiedTodayHud({
                userEmail: deps.getDefaultUserEmail(),
                tzOffsetMinutes,
              })
          : deps.query!.todayHud({
              userEmail: deps.getDefaultUserEmail(),
              tzOffsetMinutes,
              sessionId: sessionName
                ? deps.getSessionConversationId(sessionName) ?? undefined
                : undefined,
            }),
        deps.query?.burningSessions({ userEmail: deps.getDefaultUserEmail() }).catch((err) => {
          log.warn('telemetry', `burningSessions query failed: ${(err as Error).message}`)
          return [] as string[]
        }) ?? Promise.resolve([] as string[]),
      ])
      const burningRunIds = deps.getRunIdsForConversationIds(burningConvIds)
      return { ...hud, burningRunIds }
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
      if (process.env.TINSTAR_FAST_SIM === '1') {
        res.writeHead(200, json)
        res.end(JSON.stringify(makeFakeSeries({ endSec, windowSec: 300, stepSec: 5 })))
        return true
      }
      if (deps.getState() !== 'ready' || !deps.providerQuery?.unifiedFleetSeries) {
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
    const seriesMatch = pathname.match(/^\/api\/telemetry\/session\/([^/]+)\/series$/)
    if (seriesMatch && req.method === 'GET') {
      const empty = {
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        stepSec: 5,
        series: { cost: [] as unknown[], tokens: [] as unknown[], cache: [] as unknown[], duty: [] as unknown[] },
      }
      // FAST_SIM: synthesize series so demos/E2E render without Prometheus.
      if (process.env.TINSTAR_FAST_SIM === '1') {
        const fake = makeFakeSeries({ endSec: Math.floor(Date.now() / 1000), windowSec: 300, stepSec: 5 })
        res.writeHead(200, json)
        res.end(JSON.stringify(fake))
        return true
      }
      const state = deps.getState()
      const unifiedQuery = getUnifiedTelemetryQuery(deps.providerQuery)
      if (state !== 'ready' || (!unifiedQuery && !deps.query)) {
        res.writeHead(200, json)
        res.end(JSON.stringify({ ...empty, state }))
        return true
      }
      const sessionName = seriesMatch[1] ?? ''
      const identity = resolveSessionTelemetryIdentity(deps, sessionName)
      const conversationId = deps.getSessionConversationId(sessionName)
      if (!identity && !conversationId) {
        res.writeHead(200, json)
        res.end(JSON.stringify(empty))
        return true
      }
      try {
        const endSec = Math.floor(Date.now() / 1000)
        const out = unifiedQuery && identity
          ? await unifiedQuery.unifiedSessionSeries({
              identity,
              userEmail: deps.getDefaultUserEmail(),
              endSec,
              windowSec: 300,
              stepSec: 5,
            })
          : await deps.query!.sessionSeries({
              sessionId: conversationId!,
              userEmail: deps.getDefaultUserEmail(),
              endSec,
              windowSec: 300,
              stepSec: 5,
            })
        res.writeHead(200, json)
        res.end(JSON.stringify(out))
      } catch (err) {
        res.writeHead(200, json)
        res.end(JSON.stringify({ ...empty, state: 'degraded', error: (err as Error).message }))
      }
      return true
    }
    const sessMatch = pathname.match(/^\/api\/telemetry\/session\/([^/]+)$/)
    if (sessMatch && req.method === 'GET') {
      const snap = await buildSnapshot(sessMatch[1])
      res.writeHead(200, json)
      res.end(JSON.stringify(snap))
      return true
    }
    if (pathname === '/api/telemetry/sessions' && req.method === 'GET') {
      // Batch endpoint: GET /api/telemetry/sessions?names=foo,bar,baz
      // Returns { foo: HudSnapshot, bar: HudSnapshot, baz: HudSnapshot }
      // Per-name failures yield null rather than failing the whole request.
      const parsed = new URL(req.url ?? pathname, 'http://localhost')
      const namesParam = parsed.searchParams.get('names')
      if (namesParam === null) {
        res.writeHead(400, json)
        res.end(JSON.stringify({ error: 'missing required query parameter: names' }))
        return true
      }
      // Split, decode, drop empties (trailing commas / "names=" etc.)
      const names = namesParam
        .split(',')
        .map((n) => {
          try { return decodeURIComponent(n) } catch { return n }
        })
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
      const result: Record<string, HudSnapshot | null> = {}
      const settled = await Promise.all(
        names.map(async (name) => {
          try {
            return [name, await buildSnapshot(name)] as const
          } catch (err) {
            log.warn('telemetry', `batch buildSnapshot(${name}) failed: ${(err as Error).message}`)
            return [name, null] as const
          }
        }),
      )
      for (const [name, snap] of settled) result[name] = snap
      res.writeHead(200, json)
      res.end(JSON.stringify(result))
      return true
    }
    if (pathname === '/api/telemetry/turn-length' && req.method === 'GET') {
      const url = new URL(req.url ?? '', 'http://localhost')
      const windowSecRaw = url.searchParams.get('windowSec')
      let windowSec = 3600
      if (windowSecRaw !== null) {
        const parsed = Number.parseInt(windowSecRaw, 10)
        if (!Number.isInteger(parsed) || String(parsed) !== windowSecRaw.trim()) {
          res.writeHead(400, json)
          res.end(JSON.stringify({ error: 'invalid windowSec' }))
          return true
        }
        windowSec = parsed  // getRecentObservations clamps to [60, 3600] internally
      }
      const session = url.searchParams.get('session') ?? undefined

      const observations = getRecentObservations({ windowSec, session })
      res.writeHead(200, json)
      res.end(JSON.stringify({
        observations,
        lastUpdated: Math.floor(Date.now() / 1000),
      }))
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

function getUnifiedTelemetryQuery(
  query: ProviderTelemetryQuery | null | undefined,
): UnifiedTelemetryQuery | null {
  if (!query
    || !query.unifiedTodayHud
    || !query.unifiedSessionHud
    || !query.unifiedSessionSeries) return null
  return query as UnifiedTelemetryQuery
}

function resolveSessionTelemetryIdentity(
  deps: TelemetryApiDeps,
  sessionName: string,
): UnifiedSessionTelemetryIdentity | null {
  const native = deps.getSessionTelemetryIdentity?.(sessionName)
  if (native) return native
  const conversationId = deps.getSessionConversationId(sessionName)
  return conversationId
    ? { providerId: 'claude', sessionIds: [sessionName, conversationId] }
    : null
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
