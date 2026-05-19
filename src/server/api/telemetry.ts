import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SSEBroadcaster } from './sse.js'
import type { TelemetryQuery } from '../observability/query.js'
import type { HudSnapshot, ObservabilityState } from '../observability/types.js'
import { log } from '../logger.js'
import { makeFakeHud, makeFakeSeries } from '../observability/fast-sim.js'
import { getRecentObservations } from '../observability/turn-length.js'

// How often to broadcast a fresh HUD snapshot to connected SSE clients.
const POLL_INTERVAL_MS = 1_500

export interface TelemetryApiDeps {
  sse: SSEBroadcaster
  query: TelemetryQuery | null     // null when state is 'disabled' or 'downloading'
  getState: () => ObservabilityState
  getProgress: () => HudSnapshot['progress']
  /** Last captured startup/runtime error from the observability stack. Null when healthy or never attempted. */
  getLastError: () => string | null
  restart: () => Promise<void>
  getDefaultUserEmail: () => string
  /** Resolve a tinstar session name to its Claude Code conversation UUID. */
  getSessionConversationId: (sessionName: string) => string | null
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
    if (state !== 'ready' || !deps.query) return base
    const tzOffsetMinutes = new Date().getTimezoneOffset()
    try {
      const sessionId = sessionName ? deps.getSessionConversationId(sessionName) ?? undefined : undefined
      const [hud, burningConvIds] = await Promise.all([
        deps.query.todayHud({
          userEmail: deps.getDefaultUserEmail(),
          tzOffsetMinutes,
          sessionId,
        }),
        deps.query.burningSessions({ userEmail: deps.getDefaultUserEmail() }).catch(() => [] as string[]),
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
      if (state !== 'ready' || !deps.query) {
        res.writeHead(200, json)
        res.end(JSON.stringify({ ...empty, state }))
        return true
      }
      const conversationId = deps.getSessionConversationId(seriesMatch[1])
      if (!conversationId) {
        res.writeHead(200, json)
        res.end(JSON.stringify(empty))
        return true
      }
      try {
        const out = await deps.query.sessionSeries({
          sessionId: conversationId,
          userEmail: deps.getDefaultUserEmail(),
          endSec: Math.floor(Date.now() / 1000),
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

export type TelemetryRoutes = ReturnType<typeof createTelemetryRoutes>
