import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { ok, fail } from '../envelope'

// Minimal ServerResponse stub — captures status, headers, body for assertions.
class MockRes extends EventEmitter {
  statusCode = 0
  headers: Record<string, string> = {}
  body = ''
  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status
    this.headers = headers
    return this
  }
  end(chunk?: string) {
    if (chunk) this.body = chunk
    return this
  }
}

function makeRes(): ServerResponse {
  return new MockRes() as unknown as ServerResponse
}

describe('ok()', () => {
  it('returns { ok: true, data } with status 200', () => {
    const res = makeRes()
    ok(res, { id: 'r1' })
    const mock = res as unknown as MockRes
    expect(mock.statusCode).toBe(200)
    expect(JSON.parse(mock.body)).toEqual({ ok: true, data: { id: 'r1' } })
  })

  it('omits warnings when not provided', () => {
    const res = makeRes()
    ok(res, { id: 'r1' })
    const mock = res as unknown as MockRes
    expect(JSON.parse(mock.body)).not.toHaveProperty('warnings')
  })

  it('includes warnings when provided', () => {
    const res = makeRes()
    ok(res, { id: 'r1' }, { warnings: { nats: ['subscribe failed'] } })
    const mock = res as unknown as MockRes
    expect(JSON.parse(mock.body)).toEqual({
      ok: true,
      data: { id: 'r1' },
      warnings: { nats: ['subscribe failed'] },
    })
  })

  it('honors custom status (e.g. 201 Created)', () => {
    const res = makeRes()
    ok(res, { id: 'r1' }, { status: 201 })
    expect((res as unknown as MockRes).statusCode).toBe(201)
  })

  it('passes through caller-provided headers (e.g. CORS)', () => {
    const res = makeRes()
    ok(res, { id: 'r1' }, { headers: { 'Access-Control-Allow-Origin': '*' } })
    expect((res as unknown as MockRes).headers['Access-Control-Allow-Origin']).toBe('*')
    expect((res as unknown as MockRes).headers['Content-Type']).toBe('application/json')
  })
})

describe('fail()', () => {
  it('auto-derives HTTP status from ErrorCode', () => {
    const cases: Array<[Parameters<typeof fail>[1], number]> = [
      ['BAD_REQUEST', 400],
      ['INVALID_PARAMS', 400],
      ['NOT_FOUND', 404],
      ['SESSION_NOT_FOUND', 404],
      ['CONFLICT', 409],
      ['PATH_OUTSIDE_WORKSPACE', 403],
      ['FORBIDDEN', 403],
      ['BACKEND_UNAVAILABLE', 503],
      ['BRIDGE_UNAVAILABLE', 503],
      ['CONFIG_UNAVAILABLE', 503],
      ['LIST_FAILED', 500],
      ['INTERNAL', 500],
    ]
    for (const [code, expectedStatus] of cases) {
      const res = makeRes()
      fail(res, code, 'message')
      expect((res as unknown as MockRes).statusCode).toBe(expectedStatus)
    }
  })

  it('returns { ok: false, error: { code, message } }', () => {
    const res = makeRes()
    fail(res, 'NOT_FOUND', "Session 'demo' not found")
    expect(JSON.parse((res as unknown as MockRes).body)).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: "Session 'demo' not found" },
    })
  })

  it('includes details when provided', () => {
    const res = makeRes()
    fail(res, 'INVALID_PARAMS', 'bad', { details: { field: 'name', reason: 'required' } })
    expect(JSON.parse((res as unknown as MockRes).body)).toEqual({
      ok: false,
      error: { code: 'INVALID_PARAMS', message: 'bad', details: { field: 'name', reason: 'required' } },
    })
  })

  it('omits details when not provided', () => {
    const res = makeRes()
    fail(res, 'NOT_FOUND', 'missing')
    expect(JSON.parse((res as unknown as MockRes).body).error).not.toHaveProperty('details')
  })

  it('honors status override (rare — documented endpoints only)', () => {
    const res = makeRes()
    fail(res, 'BAD_REQUEST', 'odd case', { status: 422 })
    expect((res as unknown as MockRes).statusCode).toBe(422)
  })
})
