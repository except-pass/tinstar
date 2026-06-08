import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer as createNetServer, type Server } from 'node:net'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import { natsControlSocketPath } from '../../sessions/backends/tmux'

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
    uploadMaxBytes: 1024,
    ui: { promptComposerDefault: false, showEmptyEntities: true, layouts: {}, telemetryPanels: {} },
  }
  return { sessionConfig: cfg, docStore: new DocumentStore() } as unknown as RouteContext
}

const netServers: Server[] = []
function fakeChannelServer(socketPath: string, reply: unknown): Promise<Server> {
  rmSync(socketPath, { force: true })
  const srv = createNetServer(sock => {
    sock.on('data', () => sock.write(JSON.stringify(reply) + '\n'))
  })
  netServers.push(srv)
  return new Promise(resolve => srv.listen(socketPath, () => resolve(srv)))
}

let tmpRoot: string
let httpServer: ReturnType<typeof createServer>
let baseUrl: string

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-nats-status-route-'))
  const ctx = makeCtx(tmpRoot)
  httpServer = createServer((req, res) => {
    handleRequest(ctx, req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end() } })
  })
  await new Promise<void>(r => httpServer.listen(0, () => r()))
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const s of netServers.splice(0)) s.close()
  await new Promise<void>(r => httpServer.close(() => r()))
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('GET /api/sessions/:name/nats-status', () => {
  it('returns observed connection + live subscriptions from the channel-server', async () => {
    const name = `probe-target-${process.pid}`
    const sock = natsControlSocketPath(name)
    await fakeChannelServer(sock, { natsState: 'OPEN', subscriptions: ['tinstar.t', 'tinstar.t.me'] })

    const res = await fetch(`${baseUrl}/api/sessions/${name}/nats-status`)
    rmSync(sock, { force: true })

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { connection: string; subscriptions: string[] } }
    expect(body.data.connection).toBe('open')
    expect(body.data.subscriptions).toEqual(['tinstar.t', 'tinstar.t.me'])
  })

  it('returns connection=down (no NATS here) when no channel-server is listening', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/no-server-${process.pid}/nats-status`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { connection: string; subscriptions: string[] } }
    expect(body.data.connection).toBe('down')
    expect(body.data.subscriptions).toEqual([])
  })

  it('a session literally named nats-status-worker resolves at the generic route, not the nats-status sub-route', async () => {
    // Regression: the generic GET /api/sessions/:name matcher must key on
    // "no trailing path segment", not substring exclusions — otherwise a real
    // session name containing "nats-status" would miss the route and 404 bare.
    const res = await fetch(`${baseUrl}/api/sessions/nats-status-worker`)
    expect(res.status).toBe(404)
    const body = await res.json() as { ok: boolean; error?: { code: string } }
    expect(body.error?.code).toBe('SESSION_NOT_FOUND')
  })
})
