import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleServerPrefs } from '../serverPrefsRoute'

const ROOT = join(tmpdir(), 'tinstar-server-prefs-route-' + process.pid)
beforeEach(() => { rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true }) })
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }) })

function makeReq(method: string, url: string, body?: string) {
  const chunks = body !== undefined ? [Buffer.from(body)] : []
  const req: any = {
    url, method,
    headers: { 'content-type': 'application/json' },
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') { chunks.forEach(c => cb(c)); return req }
      if (event === 'end') { cb(); return req }
      return req
    },
  }
  return req
}
function makeRes() {
  let body = ''; let status = 200
  return {
    setHeader: () => {},
    end: (chunk?: string) => { if (chunk) body += chunk },
    get statusCode() { return status }, set statusCode(v: number) { status = v },
    get _body() { return body },
  } as any
}

describe('handleServerPrefs', () => {
  it('returns false for unrelated URLs', async () => {
    const ok = await handleServerPrefs(makeReq('GET', '/api/sessions'), makeRes(), { configRoot: ROOT })
    expect(ok).toBe(false)
  })

  it('GET returns defaults when no file exists', async () => {
    const res = makeRes()
    await handleServerPrefs(makeReq('GET', '/api/server-prefs'), res, { configRoot: ROOT })
    expect(JSON.parse(res._body)).toEqual({ ok: true, data: { uploadMaxBytes: 100 * 1024 * 1024 } })
  })

  it('PUT writes prefs and returns merged result', async () => {
    const body = JSON.stringify({ uploadMaxBytes: 25 * 1024 * 1024 })
    const res = makeRes()
    await handleServerPrefs(makeReq('PUT', '/api/server-prefs', body), res, { configRoot: ROOT })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res._body).data.uploadMaxBytes).toBe(25 * 1024 * 1024)
    expect(existsSync(join(ROOT, 'server-prefs.json'))).toBe(true)
  })

  it('PUT rejects invalid uploadMaxBytes with 400', async () => {
    const body = JSON.stringify({ uploadMaxBytes: 100 })
    const res = makeRes()
    await handleServerPrefs(makeReq('PUT', '/api/server-prefs', body), res, { configRoot: ROOT })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res._body).ok).toBe(false)
  })
})
