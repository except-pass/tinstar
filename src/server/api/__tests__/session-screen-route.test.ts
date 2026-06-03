import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const captureScreen = vi.hoisted(() => vi.fn())
const getSession = vi.hoisted(() => vi.fn())
vi.mock('../../sessions/backends/tmux', async (orig) => {
  const actual = await orig<typeof import('../../sessions/backends/tmux')>()
  return { ...actual, captureScreen }
})
// routes.ts imports getSession from '../sessions' (the barrel), so mock the barrel
vi.mock('../../sessions', async (orig) => {
  const actual = await orig<typeof import('../../sessions')>()
  return { ...actual, getSession }
})

import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'

function makeCtx(): RouteContext {
  const cfg = {
    sessions: { prefix: 'tinstar' },
    cliTemplates: [],
    editor: 'vim',
    ports: { ttyd: 7681, hostStart: 5273 },
    dirs: { root: '/tmp/s', secrets: '/tmp/s/secrets', sessions: '/tmp/s/sessions' },
    files: { config: '/tmp/s/config.json', projects: '/tmp/s/projects.json' },
    git: { taskMarkerRegex: '#([A-Za-z0-9_-]+)', reconciliationRepos: [], reconciliationBranchScope: 'local' },
    nats: { channelServerPackage: '', bunPath: '', jetstream: false },
    uploadMaxBytes: 1024,
    ui: { promptComposerDefault: false, showEmptyEntities: true, layouts: {}, telemetryPanels: {} },
  }
  return { sessionConfig: cfg, docStore: new DocumentStore() } as unknown as RouteContext
}

async function call(path: string) {
  const server = createServer((req, res) => { void handleRequest(makeCtx(), req, res) })
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as AddressInfo
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  const json = await res.json(); server.close(); return { status: res.status, json }
}

beforeEach(() => { captureScreen.mockReset(); getSession.mockReset() })

describe('GET /api/sessions/:name/screen', () => {
  it('404 when session missing', async () => {
    getSession.mockReturnValue(null)
    const { status } = await call('/api/sessions/abc/screen')
    expect(status).toBe(404)
  })
  it('returns the captured screen', async () => {
    getSession.mockReturnValue({ name: 'abc' })
    captureScreen.mockResolvedValue('HELLO')
    const { status, json } = await call('/api/sessions/abc/screen')
    expect(status).toBe(200)
    expect(json.data.screen).toBe('HELLO')
  })
  it('passes scrollback through', async () => {
    getSession.mockReturnValue({ name: 'abc' })
    captureScreen.mockResolvedValue('X')
    await call('/api/sessions/abc/screen?scrollback=150')
    expect(captureScreen).toHaveBeenCalledWith(expect.any(String), 150)
  })
})
