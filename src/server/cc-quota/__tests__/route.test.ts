import { describe, it, expect } from 'vitest'
import { handleRequest, type RouteContext } from '../../api/routes'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CcQuotaService } from '../service'
import { EventEmitter } from 'node:events'

interface CapturedRes {
  status: number
  body: string
  res: ServerResponse
}

function makeGetReq(url: string): IncomingMessage {
  return { url, method: 'GET', headers: {} } as unknown as IncomingMessage
}

function makePostReq(url: string, body: string): IncomingMessage {
  // readBody subscribes to 'data' and 'end' events, so we need an EventEmitter
  // that emits the body as a Buffer and then an 'end'.
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>
  ee.url = url
  ee.method = 'POST'
  ee.headers = { 'content-type': 'application/json' }
  // Defer emission until the next tick so the listener attaches first.
  setImmediate(() => {
    ee.emit('data', Buffer.from(body))
    ee.emit('end')
  })
  return ee as unknown as IncomingMessage
}

function makeRes(): CapturedRes {
  const captured: CapturedRes = { status: 0, body: '', res: null as unknown as ServerResponse }
  const state = { headersSent: false, writableEnded: false }
  const res = {
    get headersSent() { return state.headersSent },
    get writableEnded() { return state.writableEnded },
    writeHead(status: number) { captured.status = status; return res },
    end(chunk?: string) { captured.body += chunk ?? ''; state.writableEnded = true; return res },
    on() { return res },
  } as unknown as ServerResponse
  captured.res = res
  return captured
}

function makeCtx(svc: CcQuotaService): RouteContext {
  return { ccQuotaService: svc } as unknown as RouteContext
}

describe('GET /api/cc-quota', () => {
  it('returns 200 with the current snapshot (null when nothing ingested)', async () => {
    const svc = new CcQuotaService({ now: () => 1000 })
    const ctx = makeCtx(svc)
    const r = makeRes()
    const handled = await handleRequest(ctx, makeGetReq('/api/cc-quota'), r.res)
    expect(handled).toBe(true)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toMatchObject({ data: null, error: null })
  })
})

describe('POST /api/cc-quota/ingest', () => {
  const validPayload = {
    session_id: 'abc',
    rate_limits: {
      five_hour: { used_percentage: 33, resets_at: 1776981600 },
      seven_day: { used_percentage: 77, resets_at: 1777168800 },
    },
  }

  it('accepts a statusline payload, returns normalized snapshot', async () => {
    const svc = new CcQuotaService({ now: () => 1000 })
    const ctx = makeCtx(svc)
    const r = makeRes()
    const handled = await handleRequest(ctx, makePostReq('/api/cc-quota/ingest', JSON.stringify(validPayload)), r.res)
    expect(handled).toBe(true)
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.data.five_hour.utilization).toBe(33)
    expect(body.data.seven_day.utilization).toBe(77)
    expect(body.error).toBeNull()
    // Raw cc-quota snapshot — not enveloped per ADR 0001 (snapshot has its
    // own .data field; ingest body is only consumed by tests).
  })

  it('returns 400 on malformed JSON', async () => {
    const svc = new CcQuotaService({ now: () => 1000 })
    const ctx = makeCtx(svc)
    const r = makeRes()
    await handleRequest(ctx, makePostReq('/api/cc-quota/ingest', 'not json'), r.res)
    expect(r.status).toBe(400)
    expect(JSON.parse(r.body)).toEqual({ ok: false, error: { code: 'BAD_REQUEST', message: 'malformed_json' } })
  })

  it('POST followed by GET returns the ingested data', async () => {
    const svc = new CcQuotaService({ now: () => 1000 })
    const ctx = makeCtx(svc)
    await handleRequest(ctx, makePostReq('/api/cc-quota/ingest', JSON.stringify(validPayload)), makeRes().res)
    const r = makeRes()
    await handleRequest(ctx, makeGetReq('/api/cc-quota'), r.res)
    expect(JSON.parse(r.body).data.five_hour.utilization).toBe(33)
  })
})
