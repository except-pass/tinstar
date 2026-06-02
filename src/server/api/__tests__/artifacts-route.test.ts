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

  it('error responses carry per-request CORS headers (uses the request-scoped fail helper)', async () => {
    // Configure an allowlist so the resolved CORS header echoes the specific origin
    // rather than the wildcard '*' — a fail path that did NOT thread the per-request
    // CORS headers would return the origin-less header set, failing this assertion.
    const prev = process.env.TINSTAR_CORS_ORIGINS
    process.env.TINSTAR_CORS_ORIGINS = 'https://app.example.com'
    try {
      const res = await t.fetch('/api/artifacts', {
        method: 'POST',
        body: JSON.stringify({ name: 'x' }), // missing path → 400 via fail()
        headers: { Origin: 'https://app.example.com' },
      })
      expect(res.status).toBe(400)
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    } finally {
      if (prev === undefined) delete process.env.TINSTAR_CORS_ORIGINS
      else process.env.TINSTAR_CORS_ORIGINS = prev
    }
  })
})

describe('GET /api/artifacts/:id', () => {
  it('serves stored html as text/html', async () => {
    const p = writeHtml(t.tmpRoot, 'g.html', '<!doctype html><html><body>served</body></html>')
    const created = await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p }) })).json()
    const res = await t.fetch(`/api/artifacts/${created.data.artifactId}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('served')
  })

  it('ignores a ?v= cache-buster query when resolving the id', async () => {
    const p = writeHtml(t.tmpRoot, 'g2.html', '<body>q</body>')
    const created = await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p }) })).json()
    const res = await t.fetch(`/api/artifacts/${created.data.artifactId}?v=7`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('q')
  })

  it('404 for unknown id', async () => {
    const res = await t.fetch('/api/artifacts/eph-nope')
    expect(res.status).toBe(404)
  })

  it('honors the CORS allowlist instead of serving HTML to any origin', async () => {
    // Stored artifact HTML comes from arbitrary local files, so the served response
    // must respect TINSTAR_CORS_ORIGINS rather than hardcoding '*'. With an allowlist
    // set, a matching Origin is echoed; a non-listed Origin gets no ACAO header.
    const prev = process.env.TINSTAR_CORS_ORIGINS
    process.env.TINSTAR_CORS_ORIGINS = 'https://app.example.com'
    try {
      const p = writeHtml(t.tmpRoot, 'cors.html', '<body>secret</body>')
      const created = await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p }) })).json()
      const allowed = await t.fetch(`/api/artifacts/${created.data.artifactId}`, { headers: { Origin: 'https://app.example.com' } })
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
      const denied = await t.fetch(`/api/artifacts/${created.data.artifactId}`, { headers: { Origin: 'https://evil.example.com' } })
      expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.TINSTAR_CORS_ORIGINS
      else process.env.TINSTAR_CORS_ORIGINS = prev
    }
  })
})

describe('PUT /api/artifacts/:id', () => {
  it('replaces content, bumps rev, and nudges the widget url with ?v=', async () => {
    const p = writeHtml(t.tmpRoot, 'u.html', '<body>v1</body>')
    const created = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p }) })).json()).data
    const widgetBefore = t.docStore.getAllBrowserWidgets().find(w => w.id === created.widgetId)!
    expect(widgetBefore.url).not.toContain('?v=')

    writeFileSync(p, '<body>v2</body>')
    const res = await t.fetch(`/api/artifacts/${created.artifactId}`, { method: 'PUT', body: JSON.stringify({ path: p }) })
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.rev).toBe(2)

    expect(t.docStore.getArtifact(created.artifactId)?.html).toContain('v2')
    expect(t.docStore.getArtifact(created.artifactId)?.rev).toBe(2)
    const widgetAfter = t.docStore.getAllBrowserWidgets().find(w => w.id === created.widgetId)!
    expect(widgetAfter.url).toContain(`/api/artifacts/${created.artifactId}?v=2`)
  })

  it('404 for unknown id', async () => {
    const p = writeHtml(t.tmpRoot, 'u2.html', '<body>x</body>')
    const res = await t.fetch('/api/artifacts/eph-nope', { method: 'PUT', body: JSON.stringify({ path: p }) })
    expect(res.status).toBe(404)
  })
})

describe('DELETE artifacts', () => {
  it('DELETE /api/artifacts/:id removes one (widget remains)', async () => {
    const p = writeHtml(t.tmpRoot, 'd.html', '<body>d</body>')
    const created = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p }) })).json()).data
    const res = await t.fetch(`/api/artifacts/${created.artifactId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(t.docStore.getArtifact(created.artifactId)).toBeUndefined()
    // widget is intentionally left in place
    expect(t.docStore.getAllBrowserWidgets().find(w => w.id === created.widgetId)).toBeDefined()
  })

  it('DELETE /api/artifacts clears all', async () => {
    const a = writeHtml(t.tmpRoot, 'a.html', '<body>a</body>')
    const b = writeHtml(t.tmpRoot, 'b.html', '<body>b</body>')
    await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: a }) })
    await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: b }) })
    const res = await t.fetch('/api/artifacts', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await res.json()).data.deleted).toBe(2)
    expect(t.docStore.getAllArtifacts()).toHaveLength(0)
  })

  it('deleting the widget cascades to its artifact (via DELETE /api/browser-widgets/:id)', async () => {
    const p = writeHtml(t.tmpRoot, 'c.html', '<body>c</body>')
    const created = (await (await t.fetch('/api/artifacts', { method: 'POST', body: JSON.stringify({ path: p }) })).json()).data
    await t.fetch(`/api/browser-widgets/${created.widgetId}`, { method: 'DELETE' })
    expect(t.docStore.getArtifact(created.artifactId)).toBeUndefined()
  })

  it('404 for unknown id', async () => {
    const res = await t.fetch('/api/artifacts/eph-nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
