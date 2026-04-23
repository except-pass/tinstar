import { describe, it, expect, vi } from 'vitest'
import { handleRequest, type RouteContext } from '../../api/routes'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CcQuotaService } from '../service'
import type { RawUsage } from '../types'

function makeReq(url: string): IncomingMessage {
  return { url, method: 'GET', headers: {} } as unknown as IncomingMessage
}

interface CapturedRes {
  status: number
  body: string
  res: ServerResponse
}

function makeRes(): CapturedRes {
  const captured: CapturedRes = { status: 0, body: '', res: null as unknown as ServerResponse }
  const res = {
    headersSent: false, writableEnded: false,
    writeHead(status: number) { captured.status = status; return this },
    end(chunk?: string) { captured.body += chunk ?? ''; this.writableEnded = true; return this },
    on() { return this },
  } as unknown as ServerResponse
  captured.res = res
  return captured
}

function makeCtx(svc: CcQuotaService): RouteContext {
  return { ccQuotaService: svc } as unknown as RouteContext
}

describe('GET /api/cc-quota', () => {
  const sample: RawUsage = {
    five_hour: { utilization: 40, resets_at: '2026-04-23T13:00:00.000Z' },
    seven_day: null, seven_day_opus: null, seven_day_sonnet: null, extra_usage: null,
  }

  it('returns 200 with snapshot body', async () => {
    const svc = new CcQuotaService({ fetcher: async () => sample, now: () => 1000 })
    const ctx = makeCtx(svc)
    const r = makeRes()
    const handled = await handleRequest(ctx, makeReq('/api/cc-quota'), r.res)
    expect(handled).toBe(true)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toMatchObject({ data: sample, error: null })
  })

  it('honors ?force=1 after cooldown by re-fetching', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => { calls++; return sample })
    let now = 1000
    const svc = new CcQuotaService({ fetcher, now: () => now })
    const ctx = makeCtx(svc)

    await handleRequest(ctx, makeReq('/api/cc-quota'), makeRes().res)
    now += 6_000
    await handleRequest(ctx, makeReq('/api/cc-quota?force=1'), makeRes().res)
    expect(calls).toBe(2)
  })
})
