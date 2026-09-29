import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createTelemetryRoutes } from '../telemetry'
import type { TelemetryApiDeps } from '../telemetry'
import type { HudSnapshot, ObservabilityState } from '../../observability/types'

// --- Minimal fakes ---

function makeFakeSSE() {
  const events: { type: string; data: unknown }[] = []
  return {
    broadcastEvent(type: string, data: unknown) {
      events.push({ type, data })
    },
    events,
  }
}

function makeFakeQuery(result: HudSnapshot | (() => HudSnapshot) | Error) {
  return {
    unifiedTodayHud: vi.fn(async (_opts: unknown) => {
      if (result instanceof Error) throw result
      if (typeof result === 'function') return result()
      return result
    }),
    unifiedFleetSeries: vi.fn(),
    providerSessionSeries: vi.fn(),
  }
}

function makeReadySnapshot(overrides: Partial<HudSnapshot> = {}): HudSnapshot {
  return {
    window: 'today',
    state: 'ready',
    cost: { total: 1.23, byModel: { 'claude-sonnet-4-6': 1.23 } },
    tokens: { total: 100000 },
    rate: { perMin: 500, perHour: 30000 },
    cacheHitPct: 0.65,
    dutyCycle: { value: 2.4, windowMinutes: 5 },
    ...overrides,
  }
}

function makeReq(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage
}

function makeRes() {
  let statusCode = 0
  let body = ''
  const headers: Record<string, string> = {}
  return {
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code
      Object.assign(headers, hdrs ?? {})
    },
    end(data?: string) {
      body = data ?? ''
    },
    get statusCode() { return statusCode },
    get body() { return body },
    get parsedBody() { return JSON.parse(body) },
  } as unknown as ServerResponse & { statusCode: number; body: string; parsedBody: unknown }
}

// Helper type for our augmented res
type FakeRes = ReturnType<typeof makeRes>

function makeDeps(
  state: ObservabilityState,
  providerQuery: unknown,
  sse: ReturnType<typeof makeFakeSSE>,
): TelemetryApiDeps {
  return {
    sse: sse as unknown as TelemetryApiDeps['sse'],
    providerQuery: providerQuery as TelemetryApiDeps['providerQuery'],
    getState: () => state,
    getProgress: () => undefined,
    getLastError: () => null,
    restart: vi.fn(async () => {}),
    getDefaultUserEmail: () => 'test@example.com',
  }
}

// ---

describe('GET /api/telemetry/hud — state: ready', () => {
  it('responds 200 with snapshot from query', async () => {
    const sse = makeFakeSSE()
    const snap = makeReadySnapshot()
    const query = makeFakeQuery(snap)
    const deps = makeDeps('ready', query, sse)
    const routes = createTelemetryRoutes(deps)

    const req = makeReq('GET', '/api/telemetry/hud')
    const res = makeRes()

    const handled = await routes.handle(req, res as unknown as ServerResponse, '/api/telemetry/hud')
    routes.stopPolling()

    expect(handled).toBe(true)
    expect((res as unknown as FakeRes).statusCode).toBe(200)
    const body = (res as unknown as FakeRes).parsedBody as HudSnapshot
    expect(body.state).toBe('ready')
    expect(body.cost.total).toBe(1.23)
    expect(body.tokens.total).toBe(100000)
    expect(body.cacheHitPct).toBe(0.65)
    expect(query.unifiedTodayHud).toHaveBeenCalledWith(expect.objectContaining({ userEmail: 'test@example.com' }))
  })
})

describe('GET /api/telemetry/hud — state: downloading', () => {
  it('responds 200 with null aggregates and state=downloading', async () => {
    const sse = makeFakeSSE()
    const deps = makeDeps('downloading', null, sse)
    const routes = createTelemetryRoutes(deps)

    const req = makeReq('GET', '/api/telemetry/hud')
    const res = makeRes()

    const handled = await routes.handle(req, res as unknown as ServerResponse, '/api/telemetry/hud')
    routes.stopPolling()

    expect(handled).toBe(true)
    expect((res as unknown as FakeRes).statusCode).toBe(200)
    const body = (res as unknown as FakeRes).parsedBody as HudSnapshot
    expect(body.state).toBe('downloading')
    expect(body.cost.total).toBeNull()
    expect(body.tokens.total).toBeNull()
    expect(body.rate.perMin).toBeNull()
    expect(body.rate.perHour).toBeNull()
    expect(body.cacheHitPct).toBeNull()
    expect(body.dutyCycle.value).toBeNull()
    expect(body.dutyCycle.windowMinutes).toBe(5)
  })
})

describe('GET /api/telemetry/hud/series', () => {
  it('returns provider-neutral fleet history when telemetry is ready', async () => {
    const fakeSeries = {
      startedAt: '2026-08-04T19:00:00.000Z',
      endedAt: '2026-08-04T19:05:00.000Z',
      stepSec: 5,
      series: {
        cost: [[100, 1]] as [number, number][],
        tokens: [[100, 120]] as [number, number][],
        cache: [] as [number, number][],
        duty: [[100, 0.6]] as [number, number][],
      },
    }
    const query = makeFakeQuery(makeReadySnapshot())
    query.unifiedFleetSeries.mockResolvedValue(fakeSeries)
    const deps = makeDeps('ready', query, makeFakeSSE())
    const routes = createTelemetryRoutes(deps)
    const pathname = '/api/telemetry/hud/series'
    const res = makeRes()

    const handled = await routes.handle(
      makeReq('GET', pathname),
      res as unknown as ServerResponse,
      pathname,
    )

    expect(handled).toBe(true)
    expect((res as unknown as FakeRes).parsedBody).toEqual(fakeSeries)
    expect(query.unifiedFleetSeries).toHaveBeenCalledWith(expect.objectContaining({
      userEmail: 'test@example.com',
      windowSec: 300,
      stepSec: 5,
    }))
  })

  it('returns an empty series while the stack is not ready', async () => {
    const deps = makeDeps('starting', null, makeFakeSSE())
    const routes = createTelemetryRoutes(deps)
    const pathname = '/api/telemetry/hud/series'
    const res = makeRes()

    await routes.handle(makeReq('GET', pathname), res as unknown as ServerResponse, pathname)

    expect((res as unknown as FakeRes).parsedBody).toMatchObject({
      stepSec: 5,
      series: { cost: [], tokens: [], cache: [], duty: [] },
    })
  })
})

describe('GET /api/telemetry/hud — query throws', () => {
  it('responds 200 with state=degraded and error field', async () => {
    const sse = makeFakeSSE()
    const query = makeFakeQuery(new Error('prometheus unavailable'))
    const deps = makeDeps('ready', query, sse)
    const routes = createTelemetryRoutes(deps)

    const req = makeReq('GET', '/api/telemetry/hud')
    const res = makeRes()

    const handled = await routes.handle(req, res as unknown as ServerResponse, '/api/telemetry/hud')
    routes.stopPolling()

    expect(handled).toBe(true)
    expect((res as unknown as FakeRes).statusCode).toBe(200)
    const body = (res as unknown as FakeRes).parsedBody as HudSnapshot & { error?: string }
    expect(body.state).toBe('degraded')
    expect(body.error).toBe('prometheus unavailable')
    expect(body.cost.total).toBeNull()
  })
})

describe('POST /api/telemetry/restart', () => {
  it('calls deps.restart() and responds {ok: true}', async () => {
    const deps = makeDeps('idle', null, makeFakeSSE())
    const routes = createTelemetryRoutes(deps)

    const req = makeReq('POST', '/api/telemetry/restart')
    const res = makeRes()

    const handled = await routes.handle(req, res as unknown as ServerResponse, '/api/telemetry/restart')

    expect(handled).toBe(true)
    expect(deps.restart).toHaveBeenCalledOnce()
    expect((res as unknown as FakeRes).statusCode).toBe(200)
    expect((res as unknown as FakeRes).parsedBody).toEqual({ ok: true })
  })
})

describe('unmatched routes', () => {
  it('returns false for unknown telemetry path', async () => {
    const sse = makeFakeSSE()
    const deps = makeDeps('idle', null, sse)
    const routes = createTelemetryRoutes(deps)

    const req = makeReq('GET', '/api/telemetry/unknown')
    const res = makeRes()

    const handled = await routes.handle(req, res as unknown as ServerResponse, '/api/telemetry/unknown')
    expect(handled).toBe(false)
  })
})

describe('GET /api/telemetry/provider/:provider/session/:session/series', () => {
  it('returns normalized native provider history with identity and freshness', async () => {
    const query = makeFakeQuery(makeReadySnapshot())
    query.providerSessionSeries.mockResolvedValue({
      series: [{
        metric: 'tokens',
        unit: 'tokens',
        points: [{ at: '2026-08-01T11:59:55.000Z', value: 1_200 }],
      }],
    })
    const deps = makeDeps('ready', query, makeFakeSSE())
    const routes = createTelemetryRoutes(deps)
    const pathname = '/api/telemetry/provider/codex/session/run-1/series'
    const res = makeRes()

    const handled = await routes.handle(
      makeReq('GET', pathname),
      res as unknown as ServerResponse,
      pathname,
    )

    expect(handled).toBe(true)
    expect((res as unknown as FakeRes).statusCode).toBe(200)
    expect((res as unknown as FakeRes).parsedBody).toMatchObject({
      kind: 'historical-telemetry',
      providerId: 'codex',
      scope: { kind: 'session', sessionId: 'run-1' },
      source: { id: 'provider-metrics' },
      freshness: { state: 'fresh', observedAt: '2026-08-01T11:59:55.000Z' },
      availability: {
        state: 'available',
        value: { series: [{ metric: 'tokens' }] },
      },
    })
    expect(query.providerSessionSeries).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
      sessionId: 'run-1',
      windowSec: 300,
      stepSec: 5,
    }))
  })

  it('reports provider history as unavailable instead of returning zero while the source is down', async () => {
    const deps = makeDeps('disabled', null, makeFakeSSE())
    const routes = createTelemetryRoutes(deps)
    const pathname = '/api/telemetry/provider/codex/session/run-1/series'
    const res = makeRes()

    await routes.handle(makeReq('GET', pathname), res as unknown as ServerResponse, pathname)

    expect((res as unknown as FakeRes).parsedBody).toMatchObject({
      providerId: 'codex',
      availability: {
        state: 'unavailable',
        reason: 'temporarily-unavailable',
      },
    })
  })

  it('reports an all-empty provider series as not observed with unknown freshness', async () => {
    const query = makeFakeQuery(makeReadySnapshot())
    query.providerSessionSeries.mockResolvedValue({
      series: [{ metric: 'tokens', unit: 'tokens', points: [] }],
    })
    const deps = makeDeps('ready', query, makeFakeSSE())
    const routes = createTelemetryRoutes(deps)
    const pathname = '/api/telemetry/provider/codex/session/new-run/series'
    const res = makeRes()

    await routes.handle(makeReq('GET', pathname), res as unknown as ServerResponse, pathname)

    expect((res as unknown as FakeRes).parsedBody).toMatchObject({
      freshness: { state: 'unknown', observedAt: null },
      availability: { state: 'unavailable', reason: 'not-observed' },
    })
  })
})

describe('startPolling — change detection', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('broadcasts only when serialized snapshot changes', async () => {
    const sse = makeFakeSSE()
    let callCount = 0
    const snapshots = [
      makeReadySnapshot({ cost: { total: 1.0, byModel: {} } }),
      makeReadySnapshot({ cost: { total: 1.0, byModel: {} } }),  // same — should NOT broadcast
      makeReadySnapshot({ cost: { total: 2.0, byModel: {} } }),  // different — should broadcast
    ]
    const query = makeFakeQuery(() => snapshots[Math.min(callCount++, snapshots.length - 1)]!)
    const deps = makeDeps('ready', query, sse)
    const routes = createTelemetryRoutes(deps)

    routes.startPolling()

    // Tick 1: first snapshot — broadcasts (lastSent was null)
    await vi.advanceTimersByTimeAsync(1500)
    expect(sse.events).toHaveLength(1)
    expect((sse.events[0]!.data as HudSnapshot).cost.total).toBe(1.0)

    // Tick 2: same snapshot — no broadcast
    await vi.advanceTimersByTimeAsync(1500)
    expect(sse.events).toHaveLength(1)

    // Tick 3: different snapshot — broadcasts
    await vi.advanceTimersByTimeAsync(1500)
    expect(sse.events).toHaveLength(2)
    expect((sse.events[1]!.data as HudSnapshot).cost.total).toBe(2.0)

    routes.stopPolling()
  })

  it('startPolling triggered by first GET /api/telemetry/hud', async () => {
    const sse = makeFakeSSE()
    const query = makeFakeQuery(makeReadySnapshot())
    const deps = makeDeps('ready', query, sse)
    const routes = createTelemetryRoutes(deps)

    const req = makeReq('GET', '/api/telemetry/hud')
    const res = makeRes()
    await routes.handle(req, res as unknown as ServerResponse, '/api/telemetry/hud')

    // Advance timer — polling should have started and broadcast
    await vi.advanceTimersByTimeAsync(1500)
    expect(sse.events.length).toBeGreaterThanOrEqual(1)
    expect(sse.events[0]!.type).toBe('telemetry:hud')

    routes.stopPolling()
  })
})
