import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ReconciliationMcp } from '../mcp'
import { createTunnelFacade } from '../tunnel'
import { fixtureScene, fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { buildWorkerLinkReport } from '../workerLinkReport'
import { initialPresentation, applyPresentationAction } from '../../../shared/reconciliationPresentation'

const servers: Server[] = [], clients: Client[] = [], roots: string[] = []
const callerToken = randomBytes(32).toString('hex')
const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text)
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup(allowView = true) {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-tunnel-')); roots.push(root)
  const scene = fixtureScene()
  scene.coverage.intentions.status = 'stale'
  const mcp = new ReconciliationMcp({ scene: async () => scene, card: async () => ({ outcome: 'unavailable' }),
    queue: async () => ({ outcome: 'queue-source-unavailable', message: 'Source unavailable' }),
    workerLinkReport: async () => buildWorkerLinkReport(fixtureSources()),
  }, root)
  const backend = createServer((req, res) => { void mcp.handle(req, res) }); servers.push(backend)
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const installToken = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
  const options = { upstreamPort: (backend.address() as { port: number }).port, installToken, caller: { id: 'owner-chatgpt', token: callerToken, allowView } }
  const facade = createTunnelFacade(options); servers.push(facade.server)
  await facade.listen(0)
  const url = new URL(`http://127.0.0.1:${(facade.server.address() as { port: number }).port}/mcp`)
  const client = new Client({ name: 'tunnel-test', version: '1' }); clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${callerToken}` } } }))
  return { mcp, scene, url, client, options }
}
it('requires explicit separate caller auth and rejects forwarded identities and private routes', async () => {
  const { url, options, client } = await setup()
  for (const caller of [{ ...options.caller, token: '' }, { ...options.caller, id: '' }, { ...options.caller, token: options.installToken }]) {
    expect(() => createTunnelFacade({ ...options, caller })).toThrow()
  }
  for (const headers of [{}, { Authorization: 'Bearer wrong', 'Tailscale-User-Login': 'owner' }, { Authorization: `Bearer ${options.installToken}` }, { Authorization: `Bearer ${callerToken}`, Origin: 'https://chatgpt.com' }] as Record<string, string>[]) {
    const response = await fetch(url, { method: 'POST', headers })
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(options.installToken)
  }
  for (const path of ['/api/reconciliation/mcp', '/api/reconciliation/ui', '/.well-known/oauth-protected-resource/mcp']) {
    expect((await fetch(new URL(path, url), { headers: { Authorization: `Bearer ${callerToken}` } })).status).toBe(404)
  }
  expect((await client.listTools()).tools.map(tool => tool.name)).toHaveLength(9)
  for (const name of ['echo', 'server_info', 'dispatch_worker', 'openExternal']) expect((await client.callTool({ name, arguments: {} })).isError).toBe(true)
})
it('read scope cannot call view tools, even by guessing a hidden name', async () => {
  const { client, mcp } = await setup(false)
  const session = mcp.sessions.register(initialPresentation())
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('present_view')
  expect((await client.callTool({ name: 'present_view', arguments: { scene_id: session.scene_id, command_id: 'denied', expected_revision: 0, action: { type: 'reset-floor' } } })).isError).toBe(true)
  expect(mcp.sessions.result(session.scene_id, 'denied').outcome).toBe('unknown-id')
})
it('preserves canonical reads, stale coverage, explicit windows and honest missing/disconnected outcomes', async () => {
  const { client, mcp, scene, options } = await setup()
  const first = mcp.sessions.register(initialPresentation()), second = mcp.sessions.register(initialPresentation())
  const call = async (name: string, args: Record<string, unknown>) => parse(await client.callTool({ name, arguments: args }))
  const sessions = await call('list_ui_sessions', {})
  expect(sessions.sessions.map((s: { scene_id: string }) => s.scene_id)).toEqual([first.scene_id, second.scene_id])
  expect(JSON.stringify(sessions)).not.toContain(first.key)
  const observed = await call('get_scene', { scene_id: first.scene_id })
  expect(observed.freshness).toEqual(scene.coverage)
  const record = await call('read_record', { scene_id: first.scene_id, target: { kind: 'card', id: scene.cards[0]!.id }, evidence: true })
  expect(record.record).toEqual(scene.cards[0])
  expect(record.freshness.intentions.status).toBe('stale')
  expect(JSON.stringify(record)).not.toContain(options.installToken)
  expect((await call('read_record', { scene_id: first.scene_id, target: { kind: 'card', id: 'missing' } })).outcome).toBe('unknown-id')
  expect((await call('get_queue', { scene_id: first.scene_id })).outcome).toBe('queue-source-unavailable')
  const input = { scene_id: first.scene_id, command_id: 'missing', expected_revision: 0, action: { type: 'focus', target: { kind: 'card', id: 'missing' } } }
  expect((await call('present_view', input)).outcome).toBe('unknown-id')
  mcp.sessions.disconnect(first.scene_id)
  expect((await call('present_view', { ...input, command_id: 'offline' })).outcome).toBe('disconnected')
  expect(mcp.sessions.read(second.scene_id).state).toEqual(initialPresentation())
})
it('reuses command receipts, requires browser acknowledgment and preserves manual-click revision races', async () => {
  const { client, mcp, scene } = await setup()
  const state = initialPresentation(), first = mcp.sessions.register(state)
  const args = { scene_id: first.scene_id, command_id: 'duplicate', expected_revision: 0, action: { type: 'set-arrangement', arrangement: 'machine' } }
  const pending = client.callTool({ name: 'present_view', arguments: args })
  let commands = mcp.sessions.sync(first.scene_id, state, [])
  for (let i = 0; i < 100 && !commands.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    commands = mcp.sessions.sync(first.scene_id, state, [])
  }
  expect(commands).toHaveLength(1)
  expect(mcp.sessions.result(first.scene_id, args.command_id).outcome).toBe('queued')
  const applied = applyPresentationAction(state, commands[0]!.action, scene)
  mcp.sessions.sync(first.scene_id, applied.state, [{ scene_id: first.scene_id, command_id: args.command_id, outcome: 'applied', revision: applied.state.revision, state: applied.state, applied_at: Date.now() }])
  const receipt = parse(await pending)
  expect(receipt.outcome).toBe('applied')
  expect(parse(await client.callTool({ name: 'present_view', arguments: args }))).toEqual(receipt)
  expect(parse(await client.callTool({ name: 'present_view', arguments: { ...args, command_id: 'manual-race' } })).outcome).toBe('stale-revision')
  expect(mcp.sessions.read(first.scene_id).state).toEqual(applied.state)
})
it('fails safely when the private backend is unavailable without disclosing either credential', async () => {
  const { client, options } = await setup()
  const backend = servers[0]!
  await new Promise<void>(resolve => backend.close(() => resolve()))
  try { await client.callTool({ name: 'list_ui_sessions', arguments: {} }); throw new Error('Expected unavailable backend') }
  catch (error) {
    expect(String(error)).toContain('Tin Star MCP unavailable')
    expect(String(error)).not.toContain(options.installToken)
    expect(String(error)).not.toContain(callerToken)
  }
})
