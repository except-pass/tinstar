import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SSEBroadcaster } from './sse.js'
import type { TelemetryQuery } from '../observability/query.js'
import type { HudSnapshot, ObservabilityState } from '../observability/types.js'
import { log } from '../logger.js'
import { makeFakeHud } from '../observability/fast-sim.js'

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
      autonomy: { ratio: null, cliSeconds: null, userSeconds: null },
      progress: deps.getProgress(),
    }
    const lastError = deps.getLastError()
    if (lastError) base.error = lastError
    if (state !== 'ready' || !deps.query) return base
    const tzOffsetMinutes = new Date().getTimezoneOffset()
    try {
      const sessionId = sessionName ? deps.getSessionConversationId(sessionName) ?? undefined : undefined
      return await deps.query.todayHud({
        userEmail: deps.getDefaultUserEmail(),
        tzOffsetMinutes,
        sessionId,
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

  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (pathname === '/api/telemetry/hud' && req.method === 'GET') {
      startPolling()
      const snap = await buildSnapshot()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(snap))
      return true
    }
    const sessMatch = pathname.match(/^\/api\/telemetry\/session\/([^/]+)$/)
    if (sessMatch && req.method === 'GET') {
      const snap = await buildSnapshot(sessMatch[1])
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(snap))
      return true
    }
    if (pathname === '/api/telemetry/restart' && req.method === 'POST') {
      await deps.restart()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return true
    }
    return false
  }

  return { handle, startPolling, stopPolling }
}

export type TelemetryRoutes = ReturnType<typeof createTelemetryRoutes>
