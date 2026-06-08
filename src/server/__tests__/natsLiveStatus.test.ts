import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { probeNatsLiveStatus } from '../nats-health'

let tmpRoot: string
const servers: Server[] = []

function fakeChannelServer(socketPath: string, reply: unknown): Promise<Server> {
  const srv = createServer(sock => {
    sock.on('data', () => sock.write(JSON.stringify(reply) + '\n'))
  })
  servers.push(srv)
  return new Promise(resolve => srv.listen(socketPath, () => resolve(srv)))
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-nats-live-'))
})

afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('probeNatsLiveStatus — observed NATS truth from the channel-server', () => {
  it('reports open + the live subscriptions the channel-server actually holds', async () => {
    const sock = join(tmpRoot, 'open.sock')
    await fakeChannelServer(sock, { natsState: 'OPEN', subscriptions: ['tinstar.a.b', 'tinstar.a.b.me'] })

    const status = await probeNatsLiveStatus(sock)

    expect(status.connection).toBe('open')
    expect(status.subscriptions).toEqual(['tinstar.a.b', 'tinstar.a.b.me'])
  })

  it('reports down (no NATS) when the socket does not exist — not an error state', async () => {
    const status = await probeNatsLiveStatus(join(tmpRoot, 'absent.sock'))

    expect(status.connection).toBe('down')
    expect(status.subscriptions).toEqual([])
  })

  it('reports degraded when the socket answers but the connection is not OPEN', async () => {
    const sock = join(tmpRoot, 'draining.sock')
    await fakeChannelServer(sock, { natsState: 'DRAINING', subscriptions: ['tinstar.x'] })

    const status = await probeNatsLiveStatus(sock)

    expect(status.connection).toBe('degraded')
  })
})
