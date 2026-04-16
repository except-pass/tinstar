import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SSEBroadcaster } from './sse.js'
import type { TelemetryQuery } from '../observability/query.js'
import type { HudSnapshot, ObservabilityState } from '../observability/types.js'

export interface TelemetryApiDeps {
  sse: SSEBroadcaster
  query: TelemetryQuery | null     // null when state is 'disabled' or 'downloading'
  getState: () => ObservabilityState
  getProgress: () => HudSnapshot['progress']
  restart: () => Promise<void>
  getDefaultUserEmail: () => string
}

export function createTelemetryRoutes(deps: TelemetryApiDeps) {
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let lastSent: string | null = null

  async function buildSnapshot(sessionName?: string): Promise<HudSnapshot> {
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
    if (state !== 'ready' || !deps.query) return base
    const tzOffsetMinutes = new Date().getTimezoneOffset()
    try {
      return await deps.query.todayHud({
        userEmail: deps.getDefaultUserEmail(),
        tzOffsetMinutes,
        sessionName,
      })
    } catch (err) {
      return { ...base, state: 'degraded', error: (err as Error).message }
    }
  }

  function startPolling(): void {
    if (pollTimer) return
    pollTimer = setInterval(async () => {
      const snap = await buildSnapshot()
      const serialized = JSON.stringify(snap)
      if (serialized !== lastSent) {
        deps.sse.broadcastEvent('telemetry:hud', snap)
        lastSent = serialized
      }
    }, 1_500)
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
