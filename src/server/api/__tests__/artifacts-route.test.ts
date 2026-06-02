import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../sessions', async (importActual) => {
  const actual = await importActual<typeof import('../../sessions')>()
  return {
    ...actual,
    tmuxBackend: {
      ...actual.tmuxBackend,
      findPort: vi.fn(async () => 6123),
      createTmuxSession: vi.fn(async () => ({ port: 6123, ttydPid: 4242 })),
      onTtydRestart: vi.fn(),
    },
  }
})

import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'

const SPACE_ID = 'space-1'

function makeCtx(root: string): RouteContext {
  const cfg = {
    sessions: { prefix: 'tinstar' },
    cliTemplates: [], editor: 'vim',
    ports: { ttyd: 7681, hostStart: 5273 },
    dirs: { root, secrets: join(root, 'secrets'), sessions: join(root, 'sessions') },
    files: { config: join(root, 'config.json'), projects: join(root, 'projects.json') },
    git: { taskMarkerRegex: '#([A-Za-z0-9_-]+)', reconciliationRepos: [], reconciliationBranchScope: 'local' },
    nats: { channelServerPackage: '', bunPath: '', jetstream: false },
    uploadMaxBytes: 100 * 1024 * 1024,
    ui: { promptComposerDefault: false, showEmptyEntities: true, layouts: {}, telemetryPanels: { cost: true, tokens: true, cacheHit: false, duty: true, turnLength: true } },
  }
  const docStore = new DocumentStore()
  docStore.upsertSpace(SPACE_ID, { id: SPACE_ID, name: 'Test Space', createdAt: new Date().toISOString() })
  docStore.activeSpaceId = SPACE_ID
  return {
    sessionConfig: cfg, docStore,
    bus: { emit: vi.fn() },
    readyQueue: { onStatusChange: vi.fn(), getQueue: () => [] },
    sse: { setReadyQueue: vi.fn(), broadcastReadyQueueUpdate: vi.fn(), addClient: vi.fn() },
  } as unknown as RouteContext
}

interface TestCtx {
  docStore: DocumentStore
  tmpRoot: string
  fetch(path: string, init?: RequestInit): Promise<Response>
  close(): Promise<void>
}

function createTestServer(): TestCtx {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-artifacts-test-'))
  const ctx = makeCtx(tmpRoot)
  const server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end() } })
  })
  let port: number
  const ready = new Promise<void>(r => server.listen(0, () => { port = (server.address() as AddressInfo).port; r() }))
  return {
    docStore: ctx.docStore,
    tmpRoot,
    async fetch(path, init) {
      await ready
      const headers = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) }
      return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers })
    },
    close() { return new Promise(r => server.close(() => r())) },
  }
}

let t: TestCtx
beforeEach(() => { t = createTestServer() })
afterEach(async () => { await t.close(); rmSync(t.tmpRoot, { recursive: true, force: true }) })

function writeHtml(root: string, name: string, html: string): string {
  const p = join(root, name)
  writeFileSync(p, html)
  return p
}

describe('POST /api/artifacts', () => {
  it('stores the file content and opens a browser widget', async () => {
    const p = writeHtml(t.tmpRoot, 'viz.html', '<!doctype html><html><head></head><body>chart</body></html>')
    const res = await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p, name: 'viz' }) })
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.artifactId).toMatch(/^eph-/)
    expect(data.widgetId).toMatch(/^browser-/)
    expect(data.url).toContain(`/api/artifacts/${data.artifactId}`)

    expect(t.docStore.getArtifact(data.artifactId)?.html).toContain('chart')
    const widget = t.docStore.getAllBrowserWidgets().find(w => w.id === data.widgetId)
    expect(widget?.url).toBe(data.url)
    expect(t.docStore.getArtifact(data.artifactId)?.widgetId).toBe(data.widgetId)
  })

  it('400 when path missing', async () => {
    const res = await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ name: 'x' }) })
    expect(res.status).toBe(400)
  })

  it('404 when file does not exist', async () => {
    const res = await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: join(t.tmpRoot, 'nope.html') }) })
    expect(res.status).toBe(404)
  })

  it('400 when file exceeds 5 MB', async () => {
    const big = writeHtml(t.tmpRoot, 'big.html', 'x'.repeat(5 * 1024 * 1024 + 1))
    const res = await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: big }) })
    expect(res.status).toBe(400)
  })
})
