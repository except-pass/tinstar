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
    todayHud: vi.fn(async (_opts: unknown) => {
      if (result instanceof Error) throw result
      if (typeof result === 'function') return result()
      return result
    }),
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
    autonomy: { ratio: 15.2, cliSeconds: 4500, userSeconds: 296 },
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
  query: TelemetryApiDeps['query'],
  sse: ReturnType<typeof makeFakeSSE>,
): TelemetryApiDeps {
  return {
    sse: sse as unknown as TelemetryApiDeps['sse'],
    query,
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
    const deps = makeDeps('ready', query as unknown as TelemetryApiDeps['query'], sse)
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
    expect(body.autonomy.ratio).toBeNull()
    expect(body.autonomy.cliSeconds).toBeNull()
    expect(body.autonomy.userSeconds).toBeNull()
  })
})

describe('GET /api/telemetry/hud — query throws', () => {
  it('responds 200 with state=degraded and error field', async () => {
    const sse = makeFakeSSE()
    const query = makeFakeQuery(new Error('prometheus unavailable'))
    const deps = makeDeps('ready', query as unknown as TelemetryApiDeps['query'], sse)
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

describe('GET /api/telemetry/session/:name', () => {
  it('passes sessionName through to query', async () => {
    const sse = makeFakeSSE()
    const snap = makeReadySnapshot()
    const query = makeFakeQuery(snap)
    const deps = makeDeps('ready', query as unknown as TelemetryApiDeps['query'], sse)
    const routes = createTelemetryRoutes(deps)

    const req = makeReq('GET', '/api/telemetry/session/my-session')
    const res = makeRes()

    const handled = await routes.handle(req, res as unknown as ServerResponse, '/api/telemetry/session/my-session')

    expect(handled).toBe(true)
    expect((res as unknown as FakeRes).statusCode).toBe(200)
    expect(query.todayHud).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'my-session' })
    )
  })
})

describe('POST /api/telemetry/restart', () => {
  it('calls deps.restart() and responds {ok: true}', async () => {
    const sse = makeFakeSSE()
    const restart = vi.fn(async () => {})
    const deps: TelemetryApiDeps = {
      sse: sse as unknown as TelemetryApiDeps['sse'],
      query: null,
      getState: () => 'idle',
      getProgress: () => undefined,
      getLastError: () => null,
      restart,
      getDefaultUserEmail: () => 'test@example.com',
    }
    const routes = createTelemetryRoutes(deps)

    const req = makeReq('POST', '/api/telemetry/restart')
    const res = makeRes()

    const handled = await routes.handle(req, res as unknown as ServerResponse, '/api/telemetry/restart')

    expect(handled).toBe(true)
    expect(restart).toHaveBeenCalledOnce()
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
    const query = {
      todayHud: vi.fn(async () => snapshots[Math.min(callCount++, snapshots.length - 1)]),
    }
    const deps = makeDeps('ready', query as unknown as TelemetryApiDeps['query'], sse)
    const routes = createTelemetryRoutes(deps)

    routes.startPolling()

    // Tick 1: first snapshot — broadcasts (lastSent was null)
    await vi.advanceTimersByTimeAsync(1500)
    expect(sse.events).toHaveLength(1)
    expect((sse.events[0].data as HudSnapshot).cost.total).toBe(1.0)

    // Tick 2: same snapshot — no broadcast
    await vi.advanceTimersByTimeAsync(1500)
    expect(sse.events).toHaveLength(1)

    // Tick 3: different snapshot — broadcasts
    await vi.advanceTimersByTimeAsync(1500)
    expect(sse.events).toHaveLength(2)
    expect((sse.events[1].data as HudSnapshot).cost.total).toBe(2.0)

    routes.stopPolling()
  })

  it('startPolling triggered by first GET /api/telemetry/hud', async () => {
    const sse = makeFakeSSE()
    const snap = makeReadySnapshot()
    const query = makeFakeQuery(snap)
    const deps = makeDeps('ready', query as unknown as TelemetryApiDeps['query'], sse)
    const routes = createTelemetryRoutes(deps)

    const req = makeReq('GET', '/api/telemetry/hud')
    const res = makeRes()
    await routes.handle(req, res as unknown as ServerResponse, '/api/telemetry/hud')

    // Advance timer — polling should have started and broadcast
    await vi.advanceTimersByTimeAsync(1500)
    expect(sse.events.length).toBeGreaterThanOrEqual(1)
    expect(sse.events[0].type).toBe('telemetry:hud')

    routes.stopPolling()
  })
})
