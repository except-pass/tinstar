import { describe, it, expect, vi } from 'vitest'
import { createTelemetryRoutes } from '../telemetry.js'
import type { HudSnapshot } from '../../observability/types.js'

function fakeSse() {
  return { broadcastEvent: vi.fn() } as any
}

function fakeQuery(overrides: Partial<{
  todayHud: (opts: any) => Promise<HudSnapshot>
  burningSessions: (opts: any) => Promise<string[]>
}> = {}) {
  return {
    todayHud: overrides.todayHud ?? (async () => ({
      window: 'today', state: 'ready',
      cost: { total: 0, byModel: {} },
      tokens: { total: 0 }, rate: { perMin: 0, perHour: 0 },
      cacheHitPct: null,
      dutyCycle: { value: null, windowMinutes: 5 },
    })),
    burningSessions: overrides.burningSessions ?? (async () => []),
  } as any
}

describe('telemetry routes — burningRunIds translation', () => {
  it('attaches burningRunIds to the snapshot, translated from conversation UUIDs', async () => {
    const routes = createTelemetryRoutes({
      sse: fakeSse(),
      query: fakeQuery({
        burningSessions: async () => ['uuid-a', 'uuid-b', 'uuid-missing'],
      }),
      getState: () => 'ready',
      getProgress: () => [],
      getLastError: () => null,
      restart: async () => {},
      getDefaultUserEmail: () => 'x@example.com',
      getSessionConversationId: () => null,
      getRunIdsForConversationIds: (uuids) => {
        const map: Record<string, string> = { 'uuid-a': 'run-1', 'uuid-b': 'run-2' }
        return uuids.map(u => map[u]).filter((x): x is string => !!x)
      },
    })

    const res: any = { writeHead: vi.fn(), end: vi.fn() }
    await routes.handle({ method: 'GET', url: '/api/telemetry/hud' } as any, res, '/api/telemetry/hud')
    const body = JSON.parse(res.end.mock.calls[0][0]) as HudSnapshot
    expect(body.burningRunIds).toEqual(['run-1', 'run-2'])
  })

  it('leaves burningRunIds as empty array when no sessions are burning', async () => {
    const routes = createTelemetryRoutes({
      sse: fakeSse(),
      query: fakeQuery({ burningSessions: async () => [] }),
      getState: () => 'ready',
      getProgress: () => [],
      getLastError: () => null,
      restart: async () => {},
      getDefaultUserEmail: () => 'x@example.com',
      getSessionConversationId: () => null,
      getRunIdsForConversationIds: () => [],
    })
    const res: any = { writeHead: vi.fn(), end: vi.fn() }
    await routes.handle({ method: 'GET', url: '/api/telemetry/hud' } as any, res, '/api/telemetry/hud')
    const body = JSON.parse(res.end.mock.calls[0][0]) as HudSnapshot
    expect(body.burningRunIds).toEqual([])
  })

  it('degrades gracefully when burningSessions throws', async () => {
    const routes = createTelemetryRoutes({
      sse: fakeSse(),
      query: fakeQuery({ burningSessions: async () => { throw new Error('prom down') } }),
      getState: () => 'ready',
      getProgress: () => [],
      getLastError: () => null,
      restart: async () => {},
      getDefaultUserEmail: () => 'x@example.com',
      getSessionConversationId: () => null,
      getRunIdsForConversationIds: () => [],
    })
    const res: any = { writeHead: vi.fn(), end: vi.fn() }
    await routes.handle({ method: 'GET', url: '/api/telemetry/hud' } as any, res, '/api/telemetry/hud')
    const body = JSON.parse(res.end.mock.calls[0][0]) as HudSnapshot
    expect(body.burningRunIds).toEqual([])
    // Other fields still present
    expect(body.state).toBe('ready')
  })
})
