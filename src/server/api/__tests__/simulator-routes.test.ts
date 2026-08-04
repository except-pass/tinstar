import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Run } from '../../../domain/types'
import { DocumentStore } from '../../stores/document-store'
import { handleRequest, type RouteContext } from '../routes'

function makePostReq(url: string, body: string): IncomingMessage {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>
  req.url = url
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json' }
  setImmediate(() => {
    req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req as unknown as IncomingMessage
}

function makeRes() {
  let status = 0
  let body = ''
  const state = { headersSent: false, writableEnded: false }
  const res = {
    get headersSent() { return state.headersSent },
    get writableEnded() { return state.writableEnded },
    writeHead(nextStatus: number) { status = nextStatus; state.headersSent = true; return res },
    end(chunk?: string) { body += chunk ?? ''; state.writableEnded = true; return res },
    on() { return res },
  } as unknown as ServerResponse
  return { res, status: () => status, json: () => JSON.parse(body) as unknown }
}

function run(id: string, spaceId: string): Run {
  return {
    id,
    sessionId: id,
    status: 'idle',
    spaceId,
    touchedFiles: [],
    recapEntries: [],
    rawLogs: '',
  } as unknown as Run
}

function makeCtx(enabled: boolean) {
  const docStore = new DocumentStore()
  docStore.upsertSpace('sim-space', { id: 'sim-space', name: '_simulator', createdAt: '2026-08-01T00:00:00.000Z' })
  docStore.upsertSpace('user-space', { id: 'user-space', name: 'Work Space', createdAt: '2026-08-01T00:00:00.000Z' })
  docStore.upsertRun('sim-run', run('sim-run', 'sim-space'))
  docStore.upsertRun('user-run', run('user-run', 'user-space'))
  return {
    docStore,
    ctx: { docStore, simulatorTestApiEnabled: enabled } as unknown as RouteContext,
  }
}

async function post(ctx: RouteContext, url: string, body: string) {
  const response = makeRes()
  const handled = await handleRequest(ctx, makePostReq(url, body), response.res)
  return { handled, status: response.status(), body: response.json() }
}

describe('simulator mutation routes', () => {
  it('hides test-only routes when the simulator test API is disabled', async () => {
    const { ctx, docStore } = makeCtx(false)

    const remove = await post(ctx, '/api/simulator/remove-run', JSON.stringify({ id: 'sim-run' }))
    const patch = await post(ctx, '/api/simulator/patch-run', JSON.stringify({ id: 'sim-run', status: 'working' }))

    expect(remove).toMatchObject({ handled: true, status: 404 })
    expect(patch).toMatchObject({ handled: true, status: 404 })
    expect(docStore.getRun('sim-run')?.status).toBe('idle')
  })

  it('returns envelopes for malformed and invalid removal bodies', async () => {
    const { ctx } = makeCtx(true)

    const malformed = await post(ctx, '/api/simulator/remove-run', 'not json')
    const invalid = await post(ctx, '/api/simulator/remove-run', JSON.stringify({ id: 42 }))

    expect(malformed).toMatchObject({ status: 400, body: { ok: false, error: { code: 'BAD_REQUEST', message: 'malformed_json' } } })
    expect(invalid).toMatchObject({ status: 400, body: { ok: false, error: { code: 'INVALID_PARAMS' } } })
  })

  it('mutates simulator runs but rejects runs owned by another space', async () => {
    const { ctx, docStore } = makeCtx(true)

    const rejected = await post(ctx, '/api/simulator/remove-run', JSON.stringify({ id: 'user-run' }))
    const removed = await post(ctx, '/api/simulator/remove-run', JSON.stringify({ id: 'sim-run' }))

    expect(rejected).toMatchObject({ status: 404 })
    expect(docStore.getRun('user-run')).toBeDefined()
    expect(removed).toMatchObject({ status: 200, body: { ok: true, data: null } })
    expect(docStore.getRun('sim-run')).toBeUndefined()
  })
})
