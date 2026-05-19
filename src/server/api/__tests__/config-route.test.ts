import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'

function makeCtx(root: string): RouteContext {
  mkdirSync(root, { recursive: true })
  const cfg = {
    sessions: { prefix: 'tinstar' },
    cliTemplates: [],
    editor: 'vim',
    ports: { ttyd: 7681, hostStart: 5273 },
    dirs: { root, secrets: join(root, 'secrets'), sessions: join(root, 'sessions') },
    files: { config: join(root, 'config.json'), projects: join(root, 'projects.json') },
    git: { taskMarkerRegex: '#([A-Za-z0-9_-]+)', reconciliationRepos: [], reconciliationBranchScope: 'local' },
    nats: { channelServerPackage: '', bunPath: '', jetstream: false },
    uploadMaxBytes: 100 * 1024 * 1024,
    ui: { promptComposerDefault: false, showEmptyEntities: true, layouts: {}, telemetryPanels: { cost: true, tokens: true, cacheHit: false, duty: true, turnLength: true } },
  }
  return { sessionConfig: cfg } as unknown as RouteContext
}

async function call(method: 'GET' | 'PATCH', body: unknown, root: string): Promise<{ status: number; data: unknown }> {
  const ctx = makeCtx(root)
  const server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(h => { if (!h) { res.statusCode = 404; res.end() } })
  })
  await new Promise<void>(r => server.listen(0, r))
  const port = (server.address() as AddressInfo).port
  const init: RequestInit = body == null
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const resp = await fetch(`http://127.0.0.1:${port}/api/config`, init)
  const data = await resp.json()
  await new Promise<void>(r => server.close(() => r()))
  return { status: resp.status, data }
}

describe('GET /api/config', () => {
  it('returns defaults-applied view when no file exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfg-'))
    const { status, data } = await call('GET', undefined, root)
    expect(status).toBe(200)
    const cfg = (data as { data: { uploadMaxBytes: number; ui: { telemetryPanels: { cacheHit: boolean; turnLength: boolean } } } }).data
    expect(cfg.uploadMaxBytes).toBe(100 * 1024 * 1024)
    expect(cfg.ui.telemetryPanels.cacheHit).toBe(false)
    expect(cfg.ui.telemetryPanels.turnLength).toBe(true)
  })

  it('deep-merges user file over defaults', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfg-'))
    writeFileSync(join(root, 'config.json'), JSON.stringify({ ui: { telemetryPanels: { cacheHit: true } } }))
    const { data } = await call('GET', undefined, root)
    const cfg = (data as { data: { ui: { telemetryPanels: { cost: boolean; cacheHit: boolean } } } }).data
    expect(cfg.ui.telemetryPanels.cacheHit).toBe(true)  // user override
    expect(cfg.ui.telemetryPanels.cost).toBe(true)       // default preserved
  })
})

describe('PATCH /api/config', () => {
  it('deep-merges nested patches without dropping siblings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfg-'))
    writeFileSync(join(root, 'config.json'), JSON.stringify({ ui: { layouts: { foo: 'bar' } } }))

    const { status } = await call('PATCH', { ui: { telemetryPanels: { cacheHit: true } } }, root)
    expect(status).toBe(200)

    const file = JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8'))
    expect(file.ui.layouts).toEqual({ foo: 'bar' })
    expect(file.ui.telemetryPanels.cacheHit).toBe(true)
  })

  it('rejects uploadMaxBytes < 1 MB with 400', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfg-'))
    const { status, data } = await call('PATCH', { uploadMaxBytes: 1024 }, root)
    expect(status).toBe(400)
    expect((data as { error: { code: string } }).error.code).toBe('BAD_VALUE')
  })

  it('rejects non-integer uploadMaxBytes with 400', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfg-'))
    const { status } = await call('PATCH', { uploadMaxBytes: 1.5 }, root)
    expect(status).toBe(400)
  })
})
