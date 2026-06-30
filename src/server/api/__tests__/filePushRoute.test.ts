import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { handleFilePush } from '../filePushRoute'

const ROOT = join(tmpdir(), 'tinstar-file-push-' + process.pid)
const SESS_DIR = join(ROOT, 'sessions')
const WS = join(ROOT, 'workspace')

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(SESS_DIR, 'sess-a'), { recursive: true })
  mkdirSync(join(WS, 'docs'), { recursive: true })
  writeFileSync(join(SESS_DIR, 'sess-a', 'session.json'), JSON.stringify({
    name: 'sess-a',
    workspace: { path: WS },
  }))
  writeFileSync(join(WS, 'docs', 'hello.txt'), 'hi there')
  writeFileSync(join(WS, 'docs', 'my report.csv'), 'a,b')
})
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }) })

function makeReq(url: string, method = 'POST', body?: unknown) {
  const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : []
  const stream: any = Readable.from(chunks)
  stream.url = url
  stream.method = method
  stream.headers = {}
  return stream
}

function makeRes() {
  let body = Buffer.alloc(0)
  let status = 200
  let headers: Record<string, unknown> = {}
  return {
    headersSent: false,
    writableEnded: false,
    setHeader: () => {},
    writeHead: (s: number, h?: Record<string, unknown>) => { status = s; if (h) headers = h },
    write: (chunk: Buffer | string) => { body = Buffer.concat([body, Buffer.from(chunk)]); return true },
    end: (chunk?: Buffer | string) => { if (chunk) body = Buffer.concat([body, Buffer.from(chunk)]) },
    on: () => {},
    once: () => {},
    emit: () => {},
    get statusCode() { return status }, set statusCode(v: number) { status = v },
    get _body() { return body.toString('utf8') },
    get _headers() { return headers },
  } as any
}

function fakeSse() {
  const calls: Array<{ type: string; data: any }> = []
  return {
    calls,
    sse: { broadcastEvent: (type: string, data: unknown) => { calls.push({ type, data: data as any }) } } as any,
  }
}

describe('handleFilePush', () => {
  it('returns false for the wrong method', async () => {
    const { sse } = fakeSse()
    expect(await handleFilePush(makeReq('/api/sessions/sess-a/files/push-download', 'GET'), makeRes(), { sessDir: SESS_DIR, sse }))
      .toBe(false)
  })

  it('returns false for an unrelated URL', async () => {
    const { sse } = fakeSse()
    expect(await handleFilePush(makeReq('/api/sessions/sess-a/files/download', 'POST', { path: 'docs/hello.txt' }), makeRes(), { sessDir: SESS_DIR, sse }))
      .toBe(false)
  })

  it('broadcasts download:push with the encoded download URL and filename', async () => {
    const { calls, sse } = fakeSse()
    const res = makeRes()
    const handled = await handleFilePush(
      makeReq('/api/sessions/sess-a/files/push-download', 'POST', { path: 'docs/hello.txt' }),
      res, { sessDir: SESS_DIR, sse },
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res._body)).toEqual({ ok: true, data: { pushed: true, filename: 'hello.txt' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.type).toBe('download:push')
    expect(calls[0]!.data).toEqual({
      url: '/api/sessions/sess-a/files/download?path=docs%2Fhello.txt',
      filename: 'hello.txt',
    })
  })

  it('percent-encodes spaces in the path', async () => {
    const { calls, sse } = fakeSse()
    await handleFilePush(
      makeReq('/api/sessions/sess-a/files/push-download', 'POST', { path: 'docs/my report.csv' }),
      makeRes(), { sessDir: SESS_DIR, sse },
    )
    expect(calls[0]!.data.url).toBe('/api/sessions/sess-a/files/download?path=docs%2Fmy%20report.csv')
    expect(calls[0]!.data.filename).toBe('my report.csv')
  })

  it('rejects an unknown session without broadcasting', async () => {
    const { calls, sse } = fakeSse()
    const res = makeRes()
    await handleFilePush(makeReq('/api/sessions/ghost/files/push-download', 'POST', { path: 'docs/hello.txt' }), res, { sessDir: SESS_DIR, sse })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res._body).error.code).toBe('SESSION_NOT_FOUND')
    expect(calls).toHaveLength(0)
  })

  it('rejects a missing path without broadcasting', async () => {
    const { calls, sse } = fakeSse()
    const res = makeRes()
    await handleFilePush(makeReq('/api/sessions/sess-a/files/push-download', 'POST', {}), res, { sessDir: SESS_DIR, sse })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res._body).error.code).toBe('INVALID_PARAMS')
    expect(calls).toHaveLength(0)
  })

  it('rejects a path that escapes the workspace without broadcasting', async () => {
    const { calls, sse } = fakeSse()
    const res = makeRes()
    await handleFilePush(makeReq('/api/sessions/sess-a/files/push-download', 'POST', { path: '../escape.txt' }), res, { sessDir: SESS_DIR, sse })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res._body).error.code).toBe('PATH_OUTSIDE_WORKSPACE')
    expect(calls).toHaveLength(0)
  })

  it('404s a missing file without broadcasting', async () => {
    const { calls, sse } = fakeSse()
    const res = makeRes()
    await handleFilePush(makeReq('/api/sessions/sess-a/files/push-download', 'POST', { path: 'docs/nope.txt' }), res, { sessDir: SESS_DIR, sse })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res._body).error.code).toBe('NOT_FOUND')
    expect(calls).toHaveLength(0)
  })

  it('rejects a directory path without broadcasting', async () => {
    const { calls, sse } = fakeSse()
    const res = makeRes()
    await handleFilePush(makeReq('/api/sessions/sess-a/files/push-download', 'POST', { path: 'docs' }), res, { sessDir: SESS_DIR, sse })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res._body).error.code).toBe('INVALID_PARAMS')
    expect(calls).toHaveLength(0)
  })

  it('rejects an invalid JSON body without broadcasting', async () => {
    const { calls, sse } = fakeSse()
    const res = makeRes()
    const bad: any = Readable.from([Buffer.from('{not json')])
    bad.url = '/api/sessions/sess-a/files/push-download'
    bad.method = 'POST'
    bad.headers = {}
    await handleFilePush(bad, res, { sessDir: SESS_DIR, sse })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res._body).error.code).toBe('BAD_REQUEST')
    expect(calls).toHaveLength(0)
  })
})
