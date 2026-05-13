import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { TelemetryQuery } from '../query'

let server: Server
let port: number

function makeResult(metric: Record<string, string>, value: number) {
  return { metric, value: [Date.now() / 1000, String(value)] }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      const q = url.searchParams.get('query') ?? ''
      const respond = (results: unknown[]) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: results } }))
      }
      if (q.includes('claude_code_cost_usage_USD_total')) {
        if (q.includes('sum by') && q.includes('model')) {
          respond([
            makeResult({ model: 'claude-opus-4-6' }, 4.21),
            makeResult({ model: 'claude-haiku-4-5' }, 0.61),
          ])
        } else {
          respond([makeResult({}, 4.82)])
        }
      } else if (q.includes('token_usage_tokens_total') && q.includes('cacheRead') && q.includes('/')) {
        // cache hit ratio: cacheRead / (cacheRead + input)
        respond([makeResult({}, 0.78)])
      } else if (q.includes('rate(') && q.includes('token_usage_tokens_total')) {
        respond([makeResult({}, 40.2)])
      } else if (q.includes('token_usage_tokens_total')) {
        respond([makeResult({}, 318422)])
      } else if (q.includes('active_time_seconds_total') && q.includes('type="cli"')) {
        // rate() over a 5m window — fixture value is "agent-busy seconds per wall-clock second"
        respond([makeResult({}, 2.4)])
      } else {
        respond([])
      }
    }).listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  })
})

afterEach(() => {
  try { server.close() } catch { /* already closed */ }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TelemetryQuery.todayHud', () => {
  it('aggregates today-scoped metrics into a HudSnapshot', async () => {
    const q = new TelemetryQuery(`http://127.0.0.1:${port}`)
    const snap = await q.todayHud({ userEmail: 'test@example.com', tzOffsetMinutes: 0 })
    expect(snap.cost.total).toBeCloseTo(4.82)
    expect(snap.cost.byModel['claude-opus-4-6']).toBeCloseTo(4.21)
    expect(snap.tokens.total).toBe(318422)
    expect(snap.dutyCycle.value).toBeCloseTo(2.4)
    expect(snap.dutyCycle.windowMinutes).toBe(5)
    expect(snap.cacheHitPct).toBeCloseTo(0.78)
    expect(snap.state).toBe('ready')
  })

  it('returns stale snapshot with staleSeconds when Prometheus fails after prior success', async () => {
    const q = new TelemetryQuery(`http://127.0.0.1:${port}`)
    const first = await q.todayHud({ userEmail: 'test@example.com', tzOffsetMinutes: 0 })
    expect(first.staleSeconds).toBeUndefined()
    // shut down the mock server so subsequent calls fail
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const stale = await q.todayHud({ userEmail: 'test@example.com', tzOffsetMinutes: 0 })
    expect(stale.staleSeconds).toBeGreaterThanOrEqual(0)
    expect(stale.cost.total).toBe(first.cost.total)
  })

  it('throws if Prometheus fails and no cache is available', async () => {
    const q = new TelemetryQuery(`http://127.0.0.1:1`)
    await expect(q.todayHud({ userEmail: 'x', tzOffsetMinutes: 0 })).rejects.toThrow()
  })
})

describe('queryRange', () => {
  it('hits /api/v1/query_range and normalizes [ts, "1.5"] pairs to [ts, 1.5]', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [{ metric: {}, values: [[100, '1.5'], [105, 'NaN'], [110, '2.0']] }],
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const q = new TelemetryQuery('http://prom:9090')
    const out = await q.queryRange('sum(foo)', 100, 110, 5)

    expect(fetchMock).toHaveBeenCalledOnce()
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/api/v1/query_range')
    expect(url).toContain('query=sum%28foo%29')
    expect(url).toContain('start=100')
    expect(url).toContain('end=110')
    expect(url).toContain('step=5')
    expect(out).toEqual([[100, 1.5], [105, null], [110, 2.0]])
  })

  it('returns [] when Prom result is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'success', data: { resultType: 'matrix', result: [] } }),
    })))
    const q = new TelemetryQuery('http://prom:9090')
    expect(await q.queryRange('sum(foo)', 0, 60, 5)).toEqual([])
  })

  it('throws when prom returns non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    const q = new TelemetryQuery('http://prom:9090')
    await expect(q.queryRange('sum(foo)', 0, 60, 5)).rejects.toThrow(/500/)
  })
})
