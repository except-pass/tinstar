import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const getSession = vi.hoisted(() => vi.fn())
vi.mock('../../sessions', async (orig) => {
  const actual = await orig<typeof import('../../sessions')>()
  return { ...actual, getSession }
})

import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'

const WS = join(tmpdir(), 'tinstar-rename-route-' + process.pid)

function makeCtx(): RouteContext {
  return {
    docStore: new DocumentStore(),
    sse: { broadcastEvent: vi.fn() },
    sessionConfig: {
      sessions: { prefix: 'tinstar' },
      dirs: { root: '/tmp/r', secrets: '/tmp/r/secrets', sessions: '/tmp/s' },
      ports: { ttyd: 7681, hostStart: 5273 },
      git: { taskMarkerRegex: '#([A-Za-z0-9_-]+)', reconciliationRepos: [], reconciliationBranchScope: 'local' },
      files: { config: '/tmp/r/config.json', projects: '/tmp/r/projects.json' },
      nats: { channelServerPackage: '', bunPath: '', jetstream: false },
      cliTemplates: [],
    },
  } as unknown as RouteContext
}

async function call(path: string, body: unknown) {
  const server = createServer((req, res) => { void handleRequest(makeCtx(), req, res) })
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as AddressInfo
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const json = await res.json(); server.close(); return { status: res.status, json }
}

beforeEach(() => {
  getSession.mockReset()
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  writeFileSync(join(WS, 'old.txt'), 'content')
})
afterEach(() => { rmSync(WS, { recursive: true, force: true }) })

describe('POST /api/sessions/:name/files/rename', () => {
  it('409 when session missing or has no workspace', async () => {
    getSession.mockReturnValue(null)
    expect((await call('/api/sessions/abc/files/rename', { from: 'old.txt', to: 'new.txt' })).status).toBe(409)
  })

  it('renames a file within the workspace', async () => {
    getSession.mockReturnValue({ name: 'abc', workspace: { path: WS } })
    const { status, json } = await call('/api/sessions/abc/files/rename', { from: 'old.txt', to: 'new.txt' })
    expect(status).toBe(200)
    expect(json.data).toEqual({ from: 'old.txt', to: 'new.txt' })
    expect(existsSync(join(WS, 'old.txt'))).toBe(false)
    expect(readFileSync(join(WS, 'new.txt'), 'utf8')).toBe('content')
  })

  it('400 when from/to missing', async () => {
    getSession.mockReturnValue({ name: 'abc', workspace: { path: WS } })
    expect((await call('/api/sessions/abc/files/rename', { from: 'old.txt' })).status).toBe(400)
  })

  it('rejects a destination that escapes the workspace', async () => {
    getSession.mockReturnValue({ name: 'abc', workspace: { path: WS } })
    const { status, json } = await call('/api/sessions/abc/files/rename', { from: 'old.txt', to: '../escape.txt' })
    expect(status).toBe(403)
    expect(json.error.code).toBe('PATH_OUTSIDE_WORKSPACE')
    expect(existsSync(join(WS, '..', 'escape.txt'))).toBe(false)
  })

  it('404 when source does not exist', async () => {
    getSession.mockReturnValue({ name: 'abc', workspace: { path: WS } })
    expect((await call('/api/sessions/abc/files/rename', { from: 'ghost.txt', to: 'x.txt' })).status).toBe(404)
  })

  it('409 when destination already exists', async () => {
    getSession.mockReturnValue({ name: 'abc', workspace: { path: WS } })
    writeFileSync(join(WS, 'taken.txt'), 'other')
    const { status, json } = await call('/api/sessions/abc/files/rename', { from: 'old.txt', to: 'taken.txt' })
    expect(status).toBe(409)
    expect(json.error.code).toBe('CONFLICT')
  })
})
