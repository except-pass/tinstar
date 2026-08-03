import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import { DEFAULT_WINDOW_SEC, __resetTimelineCache } from '../../sessions/timeline'

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
    ui: {
      promptComposerDefault: false,
      showEmptyEntities: true,
      layouts: {},
      telemetryPanels: { cost: true, tokens: true, cacheHit: false, duty: true, turnLength: true, timeline: true },
    },
  }
  const docStore = new DocumentStore()
  docStore.upsertSpace(FIXTURE_SPACE_ID, {
    id: FIXTURE_SPACE_ID,
    name: 'Test Space',
    createdAt: new Date().toISOString(),
  })
  return { sessionConfig: cfg, docStore } as unknown as RouteContext
}

interface TestCtx {
  fetch(path: string): Promise<Response>
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
  const ready = new Promise<void>(resolve => server.listen(0, () => {
    port = (server.address() as AddressInfo).port
    resolve()
  }))
  return {
    async fetch(path: string): Promise<Response> {
      await ready
      return fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'Content-Type': 'application/json' } })
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

const iso = (sec: number): string => new Date(sec * 1000).toISOString()

function writeSession(root: string, name: string, workdir: string, convId: string | null): void {
  const dir = join(root, 'sessions', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.json'), JSON.stringify({
    name, backend: 'tmux', state: 'running', project: null,
    workspace: { path: workdir, worktree: false, branch: null, basePath: workdir },
    conversation: convId ? { id: convId } : null,
    adapter: 'claude', created: iso(0), lastActive: iso(0),
  }))
}

let root: string
let t: TestCtx
let projectDir: string

beforeEach(() => {
  __resetTimelineCache()
  root = mkdtempSync(join(tmpdir(), 'tlroute-'))
  const workdir = join(root, 'work')
  mkdirSync(workdir, { recursive: true })

  // The resolver computes the Claude transcript path from the workspace path, so
  // the fixture transcript has to live where that computation points. The
  // directory is derived from a unique temp path and is removed in afterEach.
  const convId = 'tl-fixture-conv'
  projectDir = join(homedir(), '.claude', 'projects', workdir.replace(/\//g, '-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${convId}.jsonl`), [
    { type: 'user', timestamp: iso(0), message: { content: 'go' } },
    { type: 'assistant', timestamp: iso(1), message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
    { type: 'user', timestamp: iso(4), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n')

  writeSession(root, 'fixture', workdir, convId)
  writeSession(root, 'notranscript', join(root, 'elsewhere'), null)
  t = createTestServer(root)
})

afterEach(async () => {
  await t.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

describe('GET /api/sessions/:name/timeline', () => {
  it('404s an unknown session', async () => {
    expect((await t.fetch('/api/sessions/nope/timeline')).status).toBe(404)
  })

  it('returns bands that tile the span', async () => {
    const res = await t.fetch('/api/sessions/fixture/timeline')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.bands.length).toBeGreaterThan(0)
    const total = body.data.bands.reduce(
      (s: number, b: { start: number; end: number }) => s + (b.end - b.start), 0)
    expect(total).toBeCloseTo(body.data.t1 - body.data.t0, 3)
  })

  it('defaults windowSec and honours an override (R9a)', async () => {
    const a = await (await t.fetch('/api/sessions/fixture/timeline')).json()
    expect(a.data.windowSec).toBe(DEFAULT_WINDOW_SEC)
    const b = await (await t.fetch('/api/sessions/fixture/timeline?windowSec=900')).json()
    expect(b.data.windowSec).toBe(900)
  })

  it('ignores a nonsense windowSec rather than trusting it', async () => {
    const r = await (await t.fetch('/api/sessions/fixture/timeline?windowSec=-5')).json()
    expect(r.data.windowSec).toBe(DEFAULT_WINDOW_SEC)
  })

  it('reports no-transcript as data null, not an error (R18)', async () => {
    const r = await (await t.fetch('/api/sessions/notranscript/timeline')).json()
    expect(r.ok).toBe(true)
    expect(r.data).toBeNull()
  })
})
