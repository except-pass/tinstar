import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import { invalidateWidgetRegistryCache } from '../pluginWidgetRegistry'

const FIXTURE_SPACE_ID = 'spc-test-fixture'

function makeCtx(root: string): RouteContext {
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
  const docStore = new DocumentStore()
  // Seed a space so space-existence checks pass
  docStore.upsertSpace(FIXTURE_SPACE_ID, {
    id: FIXTURE_SPACE_ID,
    name: 'Test Space',
    createdAt: new Date().toISOString(),
  })
  return { sessionConfig: cfg, docStore } as unknown as RouteContext
}

let tmpRoot: string
let pluginDir: string
let testCtx: TestCtx

beforeEach(() => {
  invalidateWidgetRegistryCache()
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-pw-test-'))
  pluginDir = join(tmpRoot, 'fixture-plugin')
  mkdirSync(pluginDir, { recursive: true })

  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
    name: 'fixture-plugin',
    version: '0.1.0',
    tinstar: {
      apiVersion: '5',
      displayName: 'Fixture',
      contributes: {
        widgets: [
          { type: 'fixture-widget', label: 'Fixture' },
          { type: 'fixture-singleton', label: 'Fixture singleton', singleton: true },
        ],
      },
    },
  }))

  writeFileSync(join(tmpRoot, 'plugins.json'), JSON.stringify({
    disabled: [],
    external: [{ name: 'fixture-plugin', path: pluginDir }],
  }))

  testCtx = createTestServer(tmpRoot)
})

afterEach(async () => {
  invalidateWidgetRegistryCache()
  await testCtx.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

interface TestCtx {
  fetch(path: string, init?: RequestInit): Promise<Response>
  activeSpaceId: string
  close(): Promise<void>
}

function createTestServer(root: string): TestCtx {
  const ctx = makeCtx(root)
  const server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(handled => {
      if (!handled) { res.statusCode = 404; res.end() }
    })
  })
  let port: number
  const ready = new Promise<void>(r => server.listen(0, () => {
    port = (server.address() as AddressInfo).port
    r()
  }))
  return {
    activeSpaceId: FIXTURE_SPACE_ID,
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      await ready
      const headers = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) }
      return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers })
    },
    close(): Promise<void> {
      return new Promise(r => server.close(() => r()))
    },
  }
}

describe('POST /api/plugin-widgets', () => {

  it('creates an instance and returns it', async () => {
    const res = await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin',
        widgetType: 'fixture-widget',
        spaceId: testCtx.activeSpaceId,
        position: { x: 100, y: 50 },
        size: { width: 360, height: 280 },
        data: { picked: 'value' },
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { id: string; pluginId: string; widgetType: string; data: unknown; createdAt: string } }
    expect(body.ok).toBe(true)
    expect(body.data.id).toMatch(/^pw-/)
    expect(body.data.pluginId).toBe('fixture-plugin')
    expect(body.data.widgetType).toBe('fixture-widget')
    expect(body.data.data).toEqual({ picked: 'value' })
    expect(body.data.createdAt).toMatch(/T.*Z$/)
  })

  it('returns 409 for an unregistered widget type', async () => {
    const res = await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin', widgetType: 'unknown-widget',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
      }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('unknown_widget_type')
  })

  it('returns 404 for an unknown space', async () => {
    const res = await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin', widgetType: 'fixture-widget',
        spaceId: 'spc-does-not-exist',
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
      }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 413 for data exceeding 64KB', async () => {
    const big = 'x'.repeat(65537)
    const res = await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin', widgetType: 'fixture-widget',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
        data: { big },
      }),
    })
    expect(res.status).toBe(413)
  })

  it('returns 409 singleton_violation on second instance', async () => {
    // First create — should succeed
    await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin', widgetType: 'fixture-singleton',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
      }),
    })
    // Second create — should be rejected
    const res = await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin', widgetType: 'fixture-singleton',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
      }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('singleton_violation')
  })
})

describe('PATCH /api/plugin-widgets/:id', () => {
  it('sparse update: position only leaves data untouched', async () => {
    const created = await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin', widgetType: 'fixture-widget',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
        data: { keep: 'me' },
      }),
    }).then(r => r.json())
    const id = created.data.id

    const res = await testCtx.fetch(`/api/plugin-widgets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ position: { x: 50, y: 50 } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.position).toEqual({ x: 50, y: 50 })
    expect(body.data.data).toEqual({ keep: 'me' })
    expect(body.data.updatedAt).not.toBe(created.data.updatedAt)
  })

  it('data: replaces whole, no deep-merge', async () => {
    const created = await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin', widgetType: 'fixture-widget',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
        data: { plan: 'a', taskId: 't1' },
      }),
    }).then(r => r.json())

    const res = await testCtx.fetch(`/api/plugin-widgets/${created.data.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ data: { plan: 'b' } }),
    })
    const body = await res.json()
    expect(body.data.data).toEqual({ plan: 'b' })  // taskId NOT preserved
  })

  it('returns 404 NOT_FOUND for unknown id', async () => {
    const res = await testCtx.fetch('/api/plugin-widgets/pw-nope', {
      method: 'PATCH',
      body: JSON.stringify({ position: { x: 0, y: 0 } }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 413 data_too_large on oversized data', async () => {
    const created = await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin', widgetType: 'fixture-widget',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
      }),
    }).then(r => r.json())

    const big = 'x'.repeat(65537)
    const res = await testCtx.fetch(`/api/plugin-widgets/${created.data.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ data: { big } }),
    })
    expect(res.status).toBe(413)
  })
})

describe('DELETE /api/plugin-widgets/:id', () => {
  it('removes the instance', async () => {
    const created = await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin', widgetType: 'fixture-widget',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
      }),
    }).then(r => r.json())

    const del = await testCtx.fetch(`/api/plugin-widgets/${created.data.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect((await del.json()).ok).toBe(true)

    const list = await testCtx.fetch(`/api/plugin-widgets?spaceId=${testCtx.activeSpaceId}`).then(r => r.json())
    expect(list.data).toEqual([])
  })

  it('returns 404 for unknown id', async () => {
    const res = await testCtx.fetch('/api/plugin-widgets/pw-nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/plugin-widgets', () => {
  it('returns only instances in the queried space when spaceId is provided', async () => {
    await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin', widgetType: 'fixture-widget',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
      }),
    })
    const list = await testCtx.fetch(`/api/plugin-widgets?spaceId=${testCtx.activeSpaceId}`).then(r => r.json())
    expect(list.data).toHaveLength(1)
    expect(list.data[0].spaceId).toBe(testCtx.activeSpaceId)
  })

  it('returns empty array for an empty space', async () => {
    const list = await testCtx.fetch(`/api/plugin-widgets?spaceId=spc-other`).then(r => r.json())
    expect(list.data).toEqual([])
  })

  it('returns all instances when spaceId is omitted', async () => {
    await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin', widgetType: 'fixture-widget',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
      }),
    })
    const list = await testCtx.fetch(`/api/plugin-widgets`).then(r => r.json())
    expect(list.data.length).toBeGreaterThanOrEqual(1)
  })
})
