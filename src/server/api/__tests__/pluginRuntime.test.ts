import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handlePluginRuntime } from '../pluginRuntime'

const TEST_ROOT = join(tmpdir(), 'tinstar-plugin-runtime-test-' + process.pid)

beforeEach(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true })
  mkdirSync(TEST_ROOT, { recursive: true })
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

interface FakeRes {
  setHeader: (k: string, v: string) => void
  end: (chunk?: string) => void
  statusCode: number
  _body: string
  _headers: Record<string, string>
}

function makeReq(url: string) { return { url, method: 'GET' } as any }
function makeRes(): FakeRes {
  const headers: Record<string, string> = {}
  let body = ''
  let status = 200
  return {
    setHeader: (k, v) => { headers[k] = v },
    end: (chunk) => { if (chunk) body += chunk },
    get statusCode() { return status },
    set statusCode(v: number) { status = v },
    get _body() { return body },
    get _headers() { return headers },
  }
}

describe('handlePluginRuntime', () => {
  it('serves api.js with an ESM passthrough module', async () => {
    const req = makeReq('/api/plugin-runtime/api.js')
    const res = makeRes()
    const handled = await handlePluginRuntime(req, res as any, { configRoot: TEST_ROOT })
    expect(handled).toBe(true)
    expect(res._headers['Content-Type']).toBe('application/javascript')
    expect(res._body).toMatch(/__plugin_api_marker|export/)
  })

  it('serves react.js that references window.__tinstar_react', async () => {
    const req = makeReq('/api/plugin-runtime/react.js')
    const res = makeRes()
    const handled = await handlePluginRuntime(req, res as any, { configRoot: TEST_ROOT })
    expect(handled).toBe(true)
    expect(res._body).toContain('window.__tinstar_react')
  })

  it('returns false for unrelated URLs', async () => {
    const req = makeReq('/api/sessions')
    const res = makeRes()
    const handled = await handlePluginRuntime(req, res as any, { configRoot: TEST_ROOT })
    expect(handled).toBe(false)
  })

  it('rejects local plugin paths containing ".." (traversal)', async () => {
    const req = makeReq('/api/plugin-runtime/local/papershore/../etc/passwd')
    const res = makeRes()
    const handled = await handlePluginRuntime(req, res as any, { configRoot: TEST_ROOT })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for unknown plugin name in local path', async () => {
    const req = makeReq('/api/plugin-runtime/local/unknown/main.js')
    const res = makeRes()
    const handled = await handlePluginRuntime(req, res as any, { configRoot: TEST_ROOT })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
  })

  it('rejects a symlink that escapes the plugin root', async () => {
    const pluginRoot = join(TEST_ROOT, 'fake-plugin')
    mkdirSync(pluginRoot, { recursive: true })
    // Create a target outside the plugin root
    const outsideFile = join(TEST_ROOT, 'secret.txt')
    writeFileSync(outsideFile, 'top-secret')
    // Plugin contains a symlink pointing to it
    symlinkSync(outsideFile, join(pluginRoot, 'leak.js'))
    writeFileSync(join(TEST_ROOT, 'plugins.json'), JSON.stringify({
      disabled: [],
      external: [{ name: 'fake-plugin', path: pluginRoot }],
    }))

    const req = makeReq('/api/plugin-runtime/local/fake-plugin/leak.js')
    const res = makeRes()
    const handled = await handlePluginRuntime(req, res as any, { configRoot: TEST_ROOT })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(res._body).toMatch(/symlink escape|path traversal/)
  })

  it('serves a file from a configured local-plugin folder', async () => {
    // Set up a fake plugin on disk
    const pluginRoot = join(TEST_ROOT, 'fake-plugin')
    mkdirSync(pluginRoot, { recursive: true })
    writeFileSync(join(pluginRoot, 'index.js'), 'export default "hello"')
    writeFileSync(join(TEST_ROOT, 'plugins.json'), JSON.stringify({
      disabled: [],
      external: [{ name: 'fake-plugin', path: pluginRoot }],
    }))

    const req = makeReq('/api/plugin-runtime/local/fake-plugin/index.js')
    const res = makeRes()
    const handled = await handlePluginRuntime(req, res as any, { configRoot: TEST_ROOT })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res._body).toContain('hello')
    expect(res._headers['Content-Type']).toBe('application/javascript')
  })
})
