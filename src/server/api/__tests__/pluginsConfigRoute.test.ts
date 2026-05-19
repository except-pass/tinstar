import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handlePluginsConfig } from '../pluginsConfigRoute'

const TEST_ROOT = join(tmpdir(), 'tinstar-plug-cfg-route-' + process.pid)
beforeEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); mkdirSync(TEST_ROOT, { recursive: true }) })
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }) })

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
  const headers: Record<string, string> = {}
  let body = ''
  let status = 200
  return {
    setHeader: (k: string, v: string) => { headers[k] = v },
    end: (chunk?: string) => { if (chunk) body += chunk },
    get statusCode() { return status }, set statusCode(v: number) { status = v },
    get _body() { return body }, get _headers() { return headers },
  } as any
}

describe('handlePluginsConfig', () => {
  it('returns false for unrelated URLs', async () => {
    const ok = await handlePluginsConfig(makeReq('GET', '/api/sessions'), makeRes(), { configRoot: TEST_ROOT })
    expect(ok).toBe(false)
  })
  it('GET returns empty config when plugins.json missing', async () => {
    const res = makeRes()
    const ok = await handlePluginsConfig(makeReq('GET', '/api/plugins-config'), res, { configRoot: TEST_ROOT })
    expect(ok).toBe(true)
    expect(JSON.parse(res._body)).toEqual({ disabled: [], external: [] })
  })
  it('GET returns existing config', async () => {
    writeFileSync(join(TEST_ROOT, 'plugins.json'), JSON.stringify({ disabled: ['x'], external: [] }))
    const res = makeRes()
    await handlePluginsConfig(makeReq('GET', '/api/plugins-config'), res, { configRoot: TEST_ROOT })
    expect(JSON.parse(res._body)).toEqual({ disabled: ['x'], external: [] })
  })
  it('PUT writes a valid config to disk', async () => {
    const body = JSON.stringify({ disabled: ['nats-traffic'], external: [{ name: 'p', path: '/abs' }] })
    const res = makeRes()
    const ok = await handlePluginsConfig(makeReq('PUT', '/api/plugins-config', body), res, { configRoot: TEST_ROOT })
    expect(ok).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(existsSync(join(TEST_ROOT, 'plugins.json'))).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(TEST_ROOT, 'plugins.json'), 'utf8'))
    expect(onDisk.disabled).toEqual(['nats-traffic'])
  })
  it('PUT rejects malformed JSON with 400', async () => {
    const res = makeRes()
    await handlePluginsConfig(makeReq('PUT', '/api/plugins-config', '{ bad'), res, { configRoot: TEST_ROOT })
    expect(res.statusCode).toBe(400)
  })
  it('PUT rejects body that does not parse as a config object', async () => {
    const res = makeRes()
    await handlePluginsConfig(makeReq('PUT', '/api/plugins-config', JSON.stringify('hello')), res, { configRoot: TEST_ROOT })
    expect(res.statusCode).toBe(400)
  })
})
