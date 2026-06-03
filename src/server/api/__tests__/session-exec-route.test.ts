import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const execCommand = vi.hoisted(() => vi.fn())
const getSession = vi.hoisted(() => vi.fn())
vi.mock('../../infra/execCommand', () => ({ execCommand }))
vi.mock('../../sessions', async (orig) => {
  const actual = await orig<typeof import('../../sessions')>()
  return { ...actual, getSession }
})

import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'

// Crib the sessionConfig shape from session-screen-route.test.ts (Task 3) so
// handleRequest reaches the exec route without throwing on cfg.dirs refs.
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
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json(); server.close(); return { status: res.status, json }
}

beforeEach(() => { execCommand.mockReset(); getSession.mockReset() })

describe('POST /api/sessions/:name/exec', () => {
  it('404 when session missing', async () => {
    getSession.mockReturnValue(null)
    expect((await call('/api/sessions/abc/exec', { argv: ['ls'] })).status).toBe(404)
  })
  it('409 when session has no workspace path', async () => {
    getSession.mockReturnValue({ name: 'abc', workspace: {} })
    expect((await call('/api/sessions/abc/exec', { argv: ['ls'] })).status).toBe(409)
  })
  it('400 when argv empty', async () => {
    getSession.mockReturnValue({ name: 'abc', workspace: { path: '/repo' } })
    expect((await call('/api/sessions/abc/exec', { argv: [] })).status).toBe(400)
    expect(execCommand).not.toHaveBeenCalled()
  })
  it('runs argv in the session cwd and returns the result', async () => {
    getSession.mockReturnValue({ name: 'abc', workspace: { path: '/repo' } })
    execCommand.mockResolvedValue({ stdout: 'OUT', stderr: '', code: 0 })
    const { status, json } = await call('/api/sessions/abc/exec', { argv: ['roborev', 'list', '--json'] })
    expect(status).toBe(200)
    expect(execCommand).toHaveBeenCalledWith(['roborev', 'list', '--json'], expect.objectContaining({ cwd: '/repo' }))
    expect(json.data).toEqual({ stdout: 'OUT', stderr: '', code: 0 })
  })
})
