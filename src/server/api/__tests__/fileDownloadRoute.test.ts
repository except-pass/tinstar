import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { handleFileDownload } from '../fileDownloadRoute'

const ROOT = join(tmpdir(), 'tinstar-file-download-' + process.pid)
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
})
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }) })

function makeReq(url: string, method = 'GET') {
  const stream: any = Readable.from([])
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

// pipe() ends asynchronously; give the stream a tick to flush.
const flush = () => new Promise(r => setTimeout(r, 20))

describe('handleFileDownload', () => {
  it('returns false for unrelated URLs', async () => {
    expect(await handleFileDownload(makeReq('/api/sessions/sess-a/files'), makeRes(), { sessDir: SESS_DIR })).toBe(false)
  })

  it('streams a file as an attachment', async () => {
    const res = makeRes()
    await handleFileDownload(makeReq('/api/sessions/sess-a/files/download?path=docs%2Fhello.txt'), res, { sessDir: SESS_DIR })
    await flush()
    expect(res.statusCode).toBe(200)
    expect(res._headers['Content-Disposition']).toBe('attachment; filename="hello.txt"')
    expect(res._body).toBe('hi there')
  })

  it('rejects paths that escape the workspace', async () => {
    const res = makeRes()
    await handleFileDownload(makeReq('/api/sessions/sess-a/files/download?path=..%2Fescape.txt'), res, { sessDir: SESS_DIR })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res._body).error.code).toBe('PATH_OUTSIDE_WORKSPACE')
  })

  it('404s on a missing file', async () => {
    const res = makeRes()
    await handleFileDownload(makeReq('/api/sessions/sess-a/files/download?path=nope.txt'), res, { sessDir: SESS_DIR })
    expect(res.statusCode).toBe(404)
  })

  it('rejects a directory path', async () => {
    const res = makeRes()
    await handleFileDownload(makeReq('/api/sessions/sess-a/files/download?path=docs'), res, { sessDir: SESS_DIR })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res._body).error.code).toBe('INVALID_PARAMS')
  })

  it('404s for an unknown session', async () => {
    const res = makeRes()
    await handleFileDownload(makeReq('/api/sessions/ghost/files/download?path=x.txt'), res, { sessDir: SESS_DIR })
    expect(res.statusCode).toBe(404)
  })
})
