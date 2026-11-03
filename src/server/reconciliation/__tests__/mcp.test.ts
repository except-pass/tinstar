import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ReconciliationMcp, privatePeer } from '../mcp'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { initialPresentation } from '../../../shared/reconciliationPresentation'
import { seedOriginAllowlist } from '../../api/originAllowlist'
let root = '', server: Server | undefined, client: Client | undefined
const parse = (value: unknown) => JSON.parse((value as { content: Array<{ text: string }> }).content[0]!.text)
afterEach(async () => { await client?.close(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); if (root) await rm(root, { recursive: true, force: true }) })
describe('authenticated real MCP transport', () => {
  it('uses private per-install auth and exposes only scoped reads/presentation', async () => {
    root = await mkdtemp(join(tmpdir(), 'tinstar-mcp-'))
    const scene = fixtureScene()
    const mcp = new ReconciliationMcp({ scene: async () => scene, card: async () => ({ outcome: 'available', blocks: [] }), queue: async () => ({ outcome: 'queue-source-unavailable', message: 'Explicit unavailable source test' }) }, root)
    server = createServer((req, res) => { void mcp.handle(req, res) })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`
    seedOriginAllowlist(port)
    const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
    expect((await stat(join(root, 'mcp-token'))).mode & 0o777).toBe(0o600)
    expect((await fetch(`${base}/api/reconciliation/mcp`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`${base}/api/reconciliation/ui`, { method: 'POST', headers: { 'X-Tinstar-UI': '1', Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${base}/api/reconciliation/ui`, { method: 'POST' })).status).toBe(403)
    const identity = mcp.sessions.register(initialPresentation())
    client = new Client({ name: 'tinstar-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['list_ui_sessions', 'get_scene', 'read_record', 'get_card_context', 'get_queue', 'present_view', 'next_queue_item', 'get_command'])
    const sessions = parse(await client.callTool({ name: 'list_ui_sessions', arguments: {} }))
    expect(sessions.sessions[0].scene_id).toBe(identity.scene_id)
    expect(JSON.stringify(sessions)).not.toContain(identity.key)
    expect(parse(await client.callTool({ name: 'get_scene', arguments: { scene_id: identity.scene_id } })).state.arrangement).toBe('initiative')
    expect(parse(await client.callTool({ name: 'get_card_context', arguments: { scene_id: identity.scene_id, card_id: scene.cards[0]!.id } })).context.outcome).toBe('available')
    expect(parse(await client.callTool({ name: 'get_queue', arguments: { scene_id: identity.scene_id } })).outcome).toBe('queue-source-unavailable')
    expect(parse(await client.callTool({ name: 'present_view', arguments: { scene_id: identity.scene_id, command_id: 'missing', expected_revision: 0, action: { type: 'focus', target: { kind: 'card', id: 'missing' } } } })).outcome).toBe('unknown-id')
    for (const name of ['present_view', 'next_queue_item']) {
      const args = { scene_id: identity.scene_id, command_id: `queue-${name}`, expected_revision: 0 }
      const action = name === 'present_view' ? { action: { type: 'navigate-queue', direction: 'next' } } : {}
      expect(parse(await client.callTool({ name, arguments: { ...args, ...action } })).outcome).toBe('queue-source-unavailable')
      expect(mcp.sessions.read(identity.scene_id).state).toEqual(initialPresentation())
    }
    const wrong = await fetch(`${base}/api/reconciliation/ui`, { method: 'POST', headers: { 'X-Tinstar-UI': '1' }, body: JSON.stringify({ type: 'disconnect', scene_id: identity.scene_id, key: 'wrong' }) })
    expect(wrong.status).toBe(403)
    mcp.sessions.disconnect(identity.scene_id)
    expect(parse(await client.callTool({ name: 'present_view', arguments: { scene_id: identity.scene_id, command_id: 'disconnected', expected_revision: 0, action: { type: 'set-arrangement', arrangement: 'machine' } } })).outcome).toBe('disconnected')
  })
  it('restricts peers to loopback and tailnet ranges', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.1.2', '100.127.2.1', 'fd7a:115c:a1e0::1']) expect(privatePeer(ip)).toBe(true)
    for (const ip of ['192.168.1.2', '8.8.8.8', '100.63.1.2', '100.128.2.1', '']) expect(privatePeer(ip)).toBe(false)
  })
})
