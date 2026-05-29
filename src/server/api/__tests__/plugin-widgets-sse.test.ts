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
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-pw-sse-test-'))
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
  docStore: DocumentStore
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
    docStore: ctx.docStore,
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

describe('SSE delivers pluginWidget deltas', () => {
  it('upsert emits a change event with entity=pluginWidget', async () => {
    const events: Array<{ entity: string; id: string }> = []
    // Subscribe directly to docStore.changes — this is what SSEBroadcaster does internally.
    const handler = (e: { entity: string; id: string; data: unknown }) => {
      if (e.entity === 'pluginWidget') events.push({ entity: e.entity, id: e.id })
    }
    testCtx.docStore.changes.on('change', handler)

    const res = await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin',
        widgetType: 'fixture-widget',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
      }),
    })

    expect(res.status).toBe(200)

    // Flush microtasks to let the event handler run
    await new Promise(r => setTimeout(r, 20))
    expect(events).toHaveLength(1)
    expect(events[0]?.entity).toBe('pluginWidget')
    testCtx.docStore.changes.off('change', handler)
  })

  it('delete emits a change with data: null', async () => {
    const created = await testCtx.fetch('/api/plugin-widgets', {
      method: 'POST',
      body: JSON.stringify({
        pluginId: 'fixture-plugin',
        widgetType: 'fixture-widget',
        spaceId: testCtx.activeSpaceId,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
      }),
    }).then(r => r.json()) as { data: { id: string } }

    const events: Array<{ id: string; data: unknown }> = []
    const handler = (e: { entity: string; id: string; data: unknown }) => {
      if (e.entity === 'pluginWidget') events.push({ id: e.id, data: e.data })
    }
    testCtx.docStore.changes.on('change', handler)

    const delRes = await testCtx.fetch(`/api/plugin-widgets/${created.data.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)

    // Flush microtasks to let the event handler run
    await new Promise(r => setTimeout(r, 20))
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBeNull()
    testCtx.docStore.changes.off('change', handler)
  })
})
