import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { handleFileUpload } from '../fileUploadRoute'

const ROOT = join(tmpdir(), 'tinstar-file-upload-' + process.pid)
const SESS_DIR = join(ROOT, 'sessions')
const WS = join(ROOT, 'workspace')

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(SESS_DIR, { recursive: true })
  mkdirSync(WS, { recursive: true })
  mkdirSync(join(SESS_DIR, 'sess-a'), { recursive: true })
  writeFileSync(join(SESS_DIR, 'sess-a', 'session.json'), JSON.stringify({
    name: 'sess-a',
    workspace: { path: WS },
  }))
})
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }) })

function makeMultipartReq(boundary: string, body: Buffer, contentLength?: number) {
  const stream: any = Readable.from([body])
  stream.url = '/api/sessions/sess-a/files/upload'
  stream.method = 'POST'
  stream.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(contentLength ?? body.length),
  }
  return stream
}
function makeRes() {
  let body = ''; let status = 200
  return {
    headersSent: false,
    writableEnded: false,
    setHeader: () => {},
    writeHead: (s: number) => { status = s },
    end: (chunk?: string) => { if (chunk) body += chunk },
    get statusCode() { return status }, set statusCode(v: number) { status = v },
    get _body() { return body },
  } as any
}

function multipartBody(boundary: string, targetPath: string, filename: string, content: Buffer): Buffer {
  const dash = `--${boundary}`
  const header =
    `${dash}\r\n` +
    `Content-Disposition: form-data; name="path"\r\n\r\n${targetPath}\r\n` +
    `${dash}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  const footer = `\r\n${dash}--\r\n`
  return Buffer.concat([Buffer.from(header), content, Buffer.from(footer)])
}

describe('handleFileUpload', () => {
  it('returns false for unrelated URLs', async () => {
    const stream: any = Readable.from([])
    stream.url = '/api/sessions/sess-a/files'
    stream.method = 'GET'
    stream.headers = {}
    expect(await handleFileUpload(stream, makeRes(), { sessDir: SESS_DIR, configRoot: ROOT })).toBe(false)
  })

  it('uploads a file to the workspace', async () => {
    const boundary = 'b1'
    const body = multipartBody(boundary, 'docs/hello.txt', 'hello.txt', Buffer.from('hi there'))
    const res = makeRes()
    await handleFileUpload(makeMultipartReq(boundary, body), res, { sessDir: SESS_DIR, configRoot: ROOT })
    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res._body)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.path).toBe('docs/hello.txt')
    expect(readFileSync(join(WS, 'docs/hello.txt'), 'utf8')).toBe('hi there')
  })

  it('rejects oversize Content-Length immediately with 413', async () => {
    writeFileSync(join(ROOT, 'config.json'), JSON.stringify({ uploadMaxBytes: 1024 * 1024 }))
    const boundary = 'b1'
    const body = multipartBody(boundary, 'big.bin', 'big.bin', Buffer.alloc(10))
    const res = makeRes()
    await handleFileUpload(makeMultipartReq(boundary, body, 5 * 1024 * 1024), res, { sessDir: SESS_DIR, configRoot: ROOT })
    expect(res.statusCode).toBe(413)
    expect(JSON.parse(res._body).error.code).toBe('INVALID_PARAMS')
  })

  it('rejects paths that escape the workspace with 403', async () => {
    const boundary = 'b1'
    const body = multipartBody(boundary, '../escape.txt', 'escape.txt', Buffer.from('x'))
    const res = makeRes()
    await handleFileUpload(makeMultipartReq(boundary, body), res, { sessDir: SESS_DIR, configRoot: ROOT })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res._body).error.code).toBe('PATH_OUTSIDE_WORKSPACE')
    expect(existsSync(join(WS, '..', 'escape.txt'))).toBe(false)
  })

  it('leaves no temp file when busboy reports truncation', async () => {
    writeFileSync(join(ROOT, 'config.json'), JSON.stringify({ uploadMaxBytes: 1024 * 1024 }))
    const boundary = 'b1'
    const big = Buffer.alloc(2 * 1024 * 1024, 'A')
    const body = multipartBody(boundary, 'big.bin', 'big.bin', big)
    const res = makeRes()
    await handleFileUpload(makeMultipartReq(boundary, body), res, { sessDir: SESS_DIR, configRoot: ROOT })
    expect(res.statusCode).toBe(413)
    const stragglers = readdirSync(WS).filter(n => n.startsWith('.tinstar-upload.'))
    expect(stragglers).toEqual([])
    expect(existsSync(join(WS, 'big.bin'))).toBe(false)
  })

  it('creates intermediate directories', async () => {
    const boundary = 'b1'
    const body = multipartBody(boundary, 'a/b/c/nested.txt', 'nested.txt', Buffer.from('deep'))
    const res = makeRes()
    await handleFileUpload(makeMultipartReq(boundary, body), res, { sessDir: SESS_DIR, configRoot: ROOT })
    expect(res.statusCode).toBe(200)
    expect(readFileSync(join(WS, 'a/b/c/nested.txt'), 'utf8')).toBe('deep')
  })

  it('returns 404 for unknown session', async () => {
    const boundary = 'b1'
    const body = multipartBody(boundary, 'x.txt', 'x.txt', Buffer.from('x'))
    const stream: any = Readable.from([body])
    stream.url = '/api/sessions/does-not-exist/files/upload'
    stream.method = 'POST'
    stream.headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    }
    const res = makeRes()
    await handleFileUpload(stream, res, { sessDir: SESS_DIR, configRoot: ROOT })
    expect(res.statusCode).toBe(404)
  })
})
