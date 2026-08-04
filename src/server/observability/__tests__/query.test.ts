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

  it('clamps an over-extrapolated cost increase() to the max_over_time ceiling', async () => {
    // Counter-churn scenario: increase() over the day extrapolates to a wildly
    // inflated number, but max_over_time (the ceiling) reflects the true total.
    const v = (n: number) => ({
      ok: true,
      json: async () => ({ status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [100, String(n)] }] } }),
    })
    const fetchMock = vi.fn(async (url: string) => {
      const q = decodeURIComponent(new URL(url).searchParams.get('query') ?? '')
      if (q.includes('cost_usage_USD_total') && !q.includes('sum by')) {
        return q.includes('increase(') ? v(119_000_000) : v(292.59) // huge increase, sane ceiling
      }
      return v(0)
    })
    vi.stubGlobal('fetch', fetchMock)

    const q = new TelemetryQuery('http://prom:9090')
    const snap = await q.todayHud({ userEmail: 'x', tzOffsetMinutes: 0 })
    expect(snap.cost.total).toBeCloseTo(292.59)
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

describe('TelemetryQuery unified provider contract', () => {
  it('merges Codex canonical counters into the one fleet token and duty totals', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const query = decodeURIComponent(new URL(url).searchParams.get('query') ?? '')
      let value: number | null = null
      if (query.includes('tinstar_provider_session_token_usage_total')) {
        value = query.includes('increase(') ? 300 : query.includes('[1m]') ? 60 : 600
      } else if (query.includes('tinstar_provider_session_active_time_seconds_total')) {
        value = 0.5
      } else if (query.includes('claude_code_token_usage_tokens_total')) {
        value = query.includes('rate(') ? 40 : 1_000
      } else if (query.includes('claude_code_active_time_seconds_total')) {
        value = 0.2
      } else if (query.includes('claude_code_cost_usage_USD_total')) {
        value = 2
      }
      return {
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'vector',
            result: value === null ? [] : [makeResult({}, value)],
          },
        }),
      }
    }))

    const snapshot = await new TelemetryQuery('http://prom').unifiedTodayHud({
      userEmail: 'x@example.com',
      tzOffsetMinutes: 0,
    })

    expect(snapshot.cost.total).toBeNull()
    expect(snapshot.tokens.total).toBe(1_300)
    expect(snapshot.dutyCycle.value).toBeCloseTo(0.7)
  })

  it('uses canonical Codex token and duty series without exposing provider names to callers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const query = decodeURIComponent(new URL(url).searchParams.get('query') ?? '')
      const values = query.includes('active_time')
        ? [[100, '0.2'], [105, '0.4']]
        : [[100, '1000'], [105, '1200']]
      return {
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'matrix', result: [{ metric: {}, values }] },
        }),
      }
    }))

    const series = await new TelemetryQuery('http://prom').unifiedSessionSeries({
      identity: { providerId: 'codex', sessionIds: ['run-1', 'thread-1'] },
      userEmail: '',
      endSec: 110,
      windowSec: 10,
      stepSec: 5,
    })

    expect(series.series).toEqual({
      cost: [],
      tokens: [[100, 1_000], [105, 1_200]],
      cache: [],
      duty: [[100, 0.2], [105, 0.4]],
    })
  })

  it('merges Claude and Codex fleet history pointwise for the shared charts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const query = new URL(url).searchParams.get('query') ?? ''
      const values = query.includes('claude_code_cost_usage_USD_total')
        ? [[100, '1'], [105, '1.5']]
        : query.includes('claude_code_token_usage_tokens_total') && query.includes('type=~')
          ? [[100, '100'], [105, '150']]
          : query.includes('tinstar_provider_session_token_usage_total')
            ? [[100, '20'], [105, '30']]
            : query.includes('claude_code_active_time_seconds_total')
              ? [[100, '0.2'], [105, '0.3']]
              : query.includes('tinstar_provider_session_active_time_seconds_total')
                ? [[100, '0.4'], [105, '0.5']]
                : []
      return {
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'matrix', result: values.length ? [{ metric: {}, values }] : [] },
        }),
      }
    }))

    const series = await new TelemetryQuery('http://prom').unifiedFleetSeries({
      userEmail: 'x@example.com',
      endSec: 110,
      windowSec: 10,
      stepSec: 5,
    })

    expect(series.series.cost).toEqual([])
    expect(series.series.tokens).toEqual([[100, 120], [105, 180]])
    expect(series.series.duty[0]).toEqual([100, expect.closeTo(0.6)])
    expect(series.series.duty[1]).toEqual([105, expect.closeTo(0.8)])
  })

  it('escapes regex metacharacters in alternate native session identities', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({ status: 'success', data: { resultType: 'matrix', result: [] } }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await new TelemetryQuery('http://prom').unifiedSessionSeries({
      identity: { providerId: 'codex', sessionIds: ['run.a', 'thread(1)'] },
      userEmail: '',
      endSec: 110,
      windowSec: 10,
      stepSec: 5,
    })

    const query = new URL(fetchMock.mock.calls[0]![0]).searchParams.get('query') ?? ''
    expect(query).toContain('session=~"run\\\\.a|thread\\\\(1\\\\)"')
  })
})

describe('queryRange', () => {
  it('hits /api/v1/query_range and normalizes [ts, "1.5"] pairs to [ts, 1.5]', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
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
    const url = fetchMock.mock.calls[0]![0]
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

describe('sessionSeries', () => {
  it('returns 4 series with cost/tokens/cache/duty for a session', async () => {
    // Each call returns 3 identical samples so we don't need to fake distinct payloads.
    const sampleValues: [number, string][] = [[100, '1'], [105, '2'], [110, '3']]
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { resultType: 'matrix', result: [{ metric: {}, values: sampleValues }] },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const q = new TelemetryQuery('http://prom:9090')
    const out = await q.sessionSeries({
      sessionId: 'sess-abc',
      userEmail: 'u@x.com',
      endSec: 110,
      windowSec: 15,
      stepSec: 5,
    })

    expect(fetchMock.mock.calls).toHaveLength(4) // one per metric
    expect(out.stepSec).toBe(5)
    expect(out.series.cost).toEqual([[100, 1], [105, 2], [110, 3]])
    expect(out.series.tokens).toEqual([[100, 1], [105, 2], [110, 3]])
    expect(out.series.cache).toEqual([[100, 1], [105, 2], [110, 3]])
    expect(out.series.duty).toEqual([[100, 1], [105, 2], [110, 3]])
    expect(out.startedAt).toBe(new Date(100 * 1000).toISOString())
    expect(out.endedAt).toBe(new Date(110 * 1000).toISOString())
    // All four queries include the session_id label filter
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toContain(encodeURIComponent('session_id="sess-abc"'))
    }
  })

  it('returns empty arrays when Prom has no data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'success', data: { resultType: 'matrix', result: [] } }),
    })))
    const q = new TelemetryQuery('http://prom:9090')
    const out = await q.sessionSeries({
      sessionId: 'sess-abc',
      userEmail: 'u@x.com',
      endSec: 110,
      windowSec: 15,
      stepSec: 5,
    })
    expect(out.series.cost).toEqual([])
    expect(out.series.tokens).toEqual([])
    expect(out.series.cache).toEqual([])
    expect(out.series.duty).toEqual([])
  })
})

describe('providerSessionSeries', () => {
  it('returns provider-labelled token and context history without inventing unsupported metrics', async () => {
    const sampleValues: [number, string][] = [[100, '1'], [105, '2'], [110, '3']]
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { resultType: 'matrix', result: [{ metric: {}, values: sampleValues }] },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const q = new TelemetryQuery('http://prom:9090')
    const out = await q.providerSessionSeries({
      providerId: 'codex',
      sessionId: 'run-1',
      endSec: 110,
      windowSec: 15,
      stepSec: 5,
    })

    expect(fetchMock.mock.calls).toHaveLength(3)
    expect(out.series.map(series => series.metric)).toEqual(['tokens'])
    expect(out.series[0]?.points).toEqual([
      { at: '1970-01-01T00:01:40.000Z', value: 1 },
      { at: '1970-01-01T00:01:45.000Z', value: 2 },
      { at: '1970-01-01T00:01:50.000Z', value: 3 },
    ])
    for (const call of fetchMock.mock.calls) {
      const query = new URL(call[0]).searchParams.get('query') ?? ''
      expect(query).toContain('provider="codex"')
      expect(query).toContain('session="run-1"')
      expect(query).toContain('max(tinstar_provider_session_tokens')
      expect(query).not.toContain('sum(tinstar_provider_session_tokens')
      expect(query).not.toContain('claude_code_')
    }
  })

  it('derives a canonical total from input/output-only provider history', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const query = new URL(url).searchParams.get('query') ?? ''
      const values = query.includes('token="input"')
        ? [[100, '7'], [105, '9']]
        : query.includes('token="output"')
          ? [[100, '3'], [105, '4']]
          : []
      return {
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'matrix', result: values.length ? [{ metric: {}, values }] : [] },
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await new TelemetryQuery('http://prom:9090').providerSessionSeries({
      providerId: 'future-provider',
      sessionId: 'run-2',
      endSec: 105,
      windowSec: 5,
      stepSec: 5,
    })

    expect(out.series[0]?.points).toEqual([
      { at: '1970-01-01T00:01:40.000Z', value: 10 },
      { at: '1970-01-01T00:01:45.000Z', value: 13 },
    ])
  })

  it('preserves an observed one-sided token counter without inventing an empty zero series', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const query = new URL(url).searchParams.get('query') ?? ''
      return {
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: query.includes('token="input"')
              ? [{ metric: {}, values: [[100, '7']] }]
              : [],
          },
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await new TelemetryQuery('http://prom:9090').providerSessionSeries({
      providerId: 'future-provider',
      sessionId: 'run-3',
      endSec: 100,
      windowSec: 5,
      stepSec: 5,
    })

    expect(out.series[0]?.points).toEqual([
      { at: '1970-01-01T00:01:40.000Z', value: 7 },
    ])
  })

  it('escapes provider and session identities before interpolating PromQL labels', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({ status: 'success', data: { resultType: 'matrix', result: [] } }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const q = new TelemetryQuery('http://prom:9090')
    await q.providerSessionSeries({
      providerId: 'forge"} or vector(1)',
      sessionId: 'run\\name\nnext',
      endSec: 110,
      windowSec: 15,
      stepSec: 5,
    })

    const query = new URL(fetchMock.mock.calls[0]![0]).searchParams.get('query') ?? ''
    expect(query).toContain('provider="forge\\"} or vector(1)"')
    expect(query).toContain('session="run\\\\name\\nnext"')
  })
})
