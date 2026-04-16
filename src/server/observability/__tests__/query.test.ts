import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { TelemetryQuery } from '../query'

let server: Server
let port: number

function makeResult(metric: Record<string, string>, value: number) {
  return { metric, value: [Date.now() / 1000, String(value)] }
}

beforeEach(async () => {
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
      } else if (q.includes('cache_read_input_tokens') || q.includes('cache_hit')) {
        respond([makeResult({}, 0.78)])
      } else if (q.includes('rate(claude_code_tokens_used_total')) {
        respond([makeResult({}, 40.2)])
      } else if (q.includes('tokens_used_total')) {
        respond([makeResult({}, 318422)])
      } else if (q.includes('active_time_seconds_total') && q.includes('type="cli"')) {
        respond([makeResult({}, 4313)])
      } else if (q.includes('active_time_seconds_total') && q.includes('type="user"')) {
        respond([makeResult({}, 285)])
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
})

describe('TelemetryQuery.todayHud', () => {
  it('aggregates today-scoped metrics into a HudSnapshot', async () => {
    const q = new TelemetryQuery(`http://127.0.0.1:${port}`)
    const snap = await q.todayHud({ userEmail: 'test@example.com', tzOffsetMinutes: 0 })
    expect(snap.cost.total).toBeCloseTo(4.82)
    expect(snap.cost.byModel['claude-opus-4-6']).toBeCloseTo(4.21)
    expect(snap.tokens.total).toBe(318422)
    expect(snap.autonomy.ratio).toBeCloseTo(4313 / 285, 1)
    expect(snap.autonomy.cliSeconds).toBe(4313)
    expect(snap.autonomy.userSeconds).toBe(285)
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
