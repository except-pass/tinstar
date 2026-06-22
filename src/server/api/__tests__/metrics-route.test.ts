import { describe, it, expect, beforeEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import {
  observeFromRecapEntries,
  flushOnStateChange,
  _resetForTests,
} from '../../observability/turn-length'
import type { Session } from '../../sessions/session'

function fakeSession(name: string): Session {
  return {
    name, backend: 'tmux', state: 'running', project: null,
    workspace: { path: null, branch: null } as Session['workspace'],
    conversation: { id: 'conv-X' },
    profile: null, oneshot: false, skipPermissions: false,
    cliTemplate: null, adapter: 'claude', nats: null,
    port: null, ttydPid: null, natsControlOrphanedAt: null, appendSystemPrompt: null, agent: null,
    modelOverride: null,
    created: '2026-05-17T00:00:00.000Z',
    lastActive: '2026-05-17T00:00:00.000Z',
  }
}

async function startServerAndGet(path: string): Promise<{ status: number; headers: Record<string,string>; body: string }> {
  // /api/metrics handler reads no fields off ctx, so an empty cast is safe.
  const ctx = {} as RouteContext
  const server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(handled => {
      if (!handled) { res.statusCode = 404; res.end() }
    })
  })
  await new Promise<void>(r => server.listen(0, r))
  const port = (server.address() as AddressInfo).port
  const resp = await fetch(`http://127.0.0.1:${port}${path}`)
  const body = await resp.text()
  await new Promise<void>(r => server.close(() => r()))
  const headers: Record<string,string> = {}
  resp.headers.forEach((v, k) => { headers[k] = v })
  return { status: resp.status, headers, body }
}

describe('GET /api/metrics', () => {
  beforeEach(() => _resetForTests())

  it('returns prometheus exposition format', async () => {
    observeFromRecapEntries('routealpha', [
      { id: 'u', type: 'user',  content: '', timestamp: '2026-05-17T12:00:00.000Z' },
      { id: 'a', type: 'agent', content: '', timestamp: '2026-05-17T12:00:08.000Z' },
    ], fakeSession('routealpha'))
    flushOnStateChange('routealpha', 'stopped')

    const { status, headers, body } = await startServerAndGet('/api/metrics')
    expect(status).toBe(200)
    expect(headers['content-type']).toMatch(/text\/plain/)
    expect(body).toContain('tinstar_turn_length_seconds_bucket')
    expect(body).toContain('tinstar_session="routealpha"')
    expect(body).toContain('cc_conversation_id="conv-X"')
  })
})
