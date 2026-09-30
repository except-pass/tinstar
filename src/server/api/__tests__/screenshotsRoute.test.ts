import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { handleScreenshotUpload } from '../screenshotsRoute'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../originAllowlist'

const ROOT = join(tmpdir(), 'tinstar-screenshot-test-' + process.pid)

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  resetOriginAllowlistForTests()
})

function makeReq(boundary: string, body: Buffer): any {
  const stream: any = Readable.from([body])
  stream.url = '/api/screenshots'
  stream.method = 'POST'
  stream.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  }
  return stream
}

function makeRes() {
  let body = ''; let status = 200; let headers: Record<string, string> = {}
  return {
    headersSent: false,
    writableEnded: false,
    setHeader: () => {},
    writeHead: (s: number, h?: Record<string, string>) => { status = s; headers = h ?? {} },
    end: (chunk?: string) => { if (chunk) body += chunk },
    get statusCode() { return status }, set statusCode(v: number) { status = v },
    get _body() { return body },
    get _headers() { return headers },
  } as any
}

function multipartBody(boundary: string, filename: string, mime: string, content: Buffer): Buffer {
  const dash = `--${boundary}`
  const header =
    `${dash}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`
  const footer = `\r\n${dash}--\r\n`
  return Buffer.concat([Buffer.from(header), content, Buffer.from(footer)])
}

describe('handleScreenshotUpload', () => {
  it('returns false for unrelated URLs', async () => {
    const req: any = Readable.from([])
    req.url = '/api/something-else'
    req.method = 'POST'
    req.headers = {}
    const handled = await handleScreenshotUpload(req, makeRes(), { configRoot: ROOT })
    expect(handled).toBe(false)
  })

  it('returns false for non-POST methods', async () => {
    const req: any = Readable.from([])
    req.url = '/api/screenshots'
    req.method = 'GET'
    req.headers = {}
    const handled = await handleScreenshotUpload(req, makeRes(), { configRoot: ROOT })
    expect(handled).toBe(false)
  })

  it('writes a PNG to <configRoot>/screenshots and returns its absolute path', async () => {
    const boundary = 'boundary123'
    const pngContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const body = multipartBody(boundary, 'paste.png', 'image/png', pngContent)
    const req = makeReq(boundary, body)
    const res = makeRes()
    const handled = await handleScreenshotUpload(req, res, { configRoot: ROOT })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res._body)
    expect(parsed.data.path).toMatch(new RegExp(`^${ROOT}/screenshots/.+\\.png$`))
    expect(existsSync(parsed.data.path)).toBe(true)
    expect(readFileSync(parsed.data.path)).toEqual(pngContent)
  })

  it('uses .jpg for image/jpeg uploads', async () => {
    const boundary = 'b'
    const body = multipartBody(boundary, 'shot.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))
    const req = makeReq(boundary, body)
    const res = makeRes()
    await handleScreenshotUpload(req, res, { configRoot: ROOT })
    const parsed = JSON.parse(res._body)
    expect(parsed.data.path).toMatch(/\.jpg$/)
  })

  it('stores a dropped non-image using its file extension', async () => {
    const boundary = 'b'
    const body = multipartBody(boundary, 'notes.txt', 'text/plain', Buffer.from('hello'))
    const req = makeReq(boundary, body)
    const res = makeRes()
    await handleScreenshotUpload(req, res, { configRoot: ROOT })
    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res._body)
    expect(parsed.data.path).toMatch(/\.txt$/)
    expect(readFileSync(parsed.data.path, 'utf8')).toBe('hello')
  })

  it('creates the screenshots dir if missing', async () => {
    const newRoot = join(ROOT, 'fresh')
    mkdirSync(newRoot, { recursive: true })
    expect(existsSync(join(newRoot, 'screenshots'))).toBe(false)
    const boundary = 'b'
    const body = multipartBody(boundary, 's.png', 'image/png', Buffer.from([0x89, 0x50]))
    await handleScreenshotUpload(makeReq(boundary, body), makeRes(), { configRoot: newRoot })
    expect(existsSync(join(newRoot, 'screenshots'))).toBe(true)
  })

  it('returns 413 for declared content-length over 25MB', async () => {
    const req: any = Readable.from([])
    req.url = '/api/screenshots'
    req.method = 'POST'
    req.headers = {
      'content-type': 'multipart/form-data; boundary=b',
      'content-length': String(30 * 1024 * 1024),
    }
    const res = makeRes()
    await handleScreenshotUpload(req, res, { configRoot: ROOT })
    expect(res.statusCode).toBe(413)
  })

  it('answers an allowed desktop origin with the cockpit CORS headers', async () => {
    seedOriginAllowlist(4321)
    const boundary = 'b'
    const req = makeReq(boundary, multipartBody(boundary, 'notes.txt', 'text/plain', Buffer.from('hi')))
    req.headers.origin = 'tauri://localhost'
    const res = makeRes()
    await handleScreenshotUpload(req, res, { configRoot: ROOT })
    expect(res.statusCode).toBe(200)
    expect(res._headers['Access-Control-Allow-Origin']).toBe('tauri://localhost')
    expect(res._headers['Access-Control-Allow-Credentials']).toBe('true')
  })

  it('sends the same CORS headers on an oversized upload', async () => {
    seedOriginAllowlist(4321)
    const req: any = Readable.from([])
    req.url = '/api/screenshots'
    req.method = 'POST'
    req.headers = {
      origin: 'tauri://localhost',
      'content-type': 'multipart/form-data; boundary=b',
      'content-length': String(30 * 1024 * 1024),
    }
    const res = makeRes()
    await handleScreenshotUpload(req, res, { configRoot: ROOT })
    expect(res.statusCode).toBe(413)
    expect(res._headers['Access-Control-Allow-Origin']).toBe('tauri://localhost')
  })

  it('refuses an origin outside the allowlist without writing a file', async () => {
    seedOriginAllowlist(4321)
    const boundary = 'b'
    const req = makeReq(boundary, multipartBody(boundary, 's.png', 'image/png', Buffer.from([0x89])))
    req.headers.origin = 'https://evil.example'
    const res = makeRes()
    expect(await handleScreenshotUpload(req, res, { configRoot: ROOT })).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(existsSync(join(ROOT, 'screenshots'))).toBe(false)
  })
})
