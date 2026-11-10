import { afterEach, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
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
async function post(url: URL, method: string, version = '2026-07-28', params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: {
    Authorization: `Bearer ${callerToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
    'Mcp-Protocol-Version': version, 'Mcp-Method': method, ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}), ...headers,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { _meta: { 'io.modelcontextprotocol/protocolVersion': version }, ...params } }) })
}
it.each(['2026-07-28', '2025-11-25'])('serves stateless %s tool requests with the same scoped canonical results', async version => {
  const { url, mcp, options } = await setup(false)
  const session = mcp.sessions.register(initialPresentation())
  const listed = await post(url, 'tools/list', version)
  expect(listed.status).toBe(200)
  expect(listed.headers.get('mcp-session-id')).toBeNull()
  expect(listed.headers.get('cache-control')).toBe('no-store')
  const list = await listed.json()
  expect(list.id).toBe(7)
  expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['create_work', 'update_work', 'get_work_views', 'submit_handoff']))
  expect(list.result.tools.map((tool: { name: string }) => tool.name)).toHaveLength(18)
  expect(list.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('present_view')
  if (version === '2026-07-28') expect(list.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' })
  else expect(list.result).not.toHaveProperty('resultType')
  const views = await post(url, 'tools/call', version, { name: 'get_work_views', arguments: {} })
  expect(JSON.parse((await views.json()).result.content[0].text).outcome).toBe('queue-source-unavailable')
  const called = await post(url, 'tools/call', version, { name: 'list_ui_sessions', arguments: {} })
  expect(called.status).toBe(200)
  const call = await called.json()
  expect(call.id).toBe(7)
  expect(parse(call.result).sessions.map((s: { scene_id: string }) => s.scene_id)).toEqual([session.scene_id])
  expect(JSON.stringify(call)).not.toContain(session.key)
  expect(JSON.stringify(call)).not.toContain(options.installToken)
  if (version === '2026-07-28') expect(call.result.resultType).toBe('complete')
  const denied = await post(url, 'tools/call', version, { name: 'present_view', arguments: {} })
  expect((await denied.json()).result).toMatchObject({ isError: true })
})
it('discovers facade capabilities and supported versions without initialization', async () => {
  const { url } = await setup()
  const response = await post(url, 'server/discover')
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: 7, result: {
    resultType: 'complete', supportedVersions: expect.arrayContaining(['2026-07-28', '2025-11-25']),
    capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private',
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'tinstar-overview-tunnel', version: '6.0.0' } },
  } })
})
it('accepts an encoded modern tool name and keeps transport content negotiation', async () => {
  const { url } = await setup()
  const encoded = await post(url, 'tools/call', '2026-07-28', { name: 'list_ui_sessions', arguments: {} }, { 'Mcp-Name': '=?base64?bGlzdF91aV9zZXNzaW9ucw==?=' })
  expect(encoded.status).toBe(200)
  expect(parse((await encoded.json()).result)).toEqual({ sessions: [] })
  expect((await post(url, 'tools/list', '2026-07-28', {}, { Accept: 'text/html' })).status).toBe(406)
  expect((await post(url, 'tools/list', '2026-07-28', {}, { 'Content-Type': 'text/plain' })).status).toBe(415)
})
it('rejects unsupported versions and inconsistent routing metadata', async () => {
  const { url, options } = await setup()
  const unsupported = await post(url, 'tools/list', '2099-01-01')
  expect(unsupported.status).toBe(400)
  expect(await unsupported.json()).toMatchObject({ id: 7, error: { code: -32022, data: { requested: '2099-01-01', supported: expect.arrayContaining(['2026-07-28', '2025-11-25']) } } })
  for (const headers of [{ 'Mcp-Method': 'tools/call' }, { 'Mcp-Protocol-Version': '2025-11-25' }] as Record<string, string>[]) {
    const response = await post(url, 'tools/list', '2026-07-28', {}, headers)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: -32020 } })
  }
  const mismatch = await post(url, 'tools/call', '2026-07-28', { name: 'list_ui_sessions' }, { 'Mcp-Name': 'present_view' })
  expect(mismatch.status).toBe(400)
  const text = await mismatch.text()
  expect(text).not.toContain(callerToken)
  expect(text).not.toContain(options.installToken)
  const removed = await post(url, 'ping')
  expect(removed.status).toBe(404)
  expect(await removed.json()).toMatchObject({ error: { code: -32601 } })
  const noMeta = await post(url, 'tools/list', '2026-07-28', { _meta: {} })
  expect(noMeta.status).toBe(400)
  expect(await noMeta.json()).toMatchObject({ error: { code: -32020 } })
})
it('keeps modern discovery and tool calls behind exact bearer and origin checks', async () => {
  const { url } = await setup()
  for (const method of ['server/discover', 'tools/list', 'tools/call']) {
    for (const headers of [{ Authorization: '' }, { Origin: 'https://chatgpt.com' }] as Record<string, string>[]) expect((await post(url, method, '2026-07-28', {}, headers)).status).toBe(401)
    const status = await new Promise<number>(resolve => {
      const req = request(url, { method: 'POST', headers: { Authorization: [`Bearer ${callerToken}`, `Bearer ${callerToken}`], 'Mcp-Protocol-Version': '2026-07-28' } }, res => { res.resume(); resolve(res.statusCode!) })
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method }))
    })
    expect(status).toBe(401)
  }
})
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
  expect((await client.listTools()).tools.map(tool => tool.name)).toHaveLength(20)
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
  const { client, options, url } = await setup()
  const backend = servers[0]!
  await new Promise<void>(resolve => backend.close(() => resolve()))
  try { await client.callTool({ name: 'list_ui_sessions', arguments: {} }); throw new Error('Expected unavailable backend') }
  catch (error) {
    expect(String(error)).toContain('Tin Star MCP unavailable')
    expect(String(error)).not.toContain(options.installToken)
    expect(String(error)).not.toContain(callerToken)
  }
  const modern = await post(url, 'tools/call', '2026-07-28', { name: 'list_ui_sessions', arguments: {} })
  expect(modern.status).toBe(503)
  const error = await modern.text()
  expect(error).toContain('Tin Star MCP unavailable')
  expect(error).not.toContain(options.installToken)
  expect(error).not.toContain(callerToken)
})

// Six tsx launches. Each startup exceeds 5s beside another suite, so the wait and the test ceiling are both longer.
it('starts from the shared Authorization file and rejects invalid caller values', async () => {
  const { options } = await setup()
  const root = await mkdtemp(join(tmpdir(), 'tinstar-tunnel-cli-')); roots.push(root)
  await writeFile(join(root, 'mcp-token'), options.installToken, { mode: 0o600 })
  const callerFile = join(root, 'caller-header')
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  for (const value of [`Bearer ${callerToken}`, `Bearer ${callerToken}\n`, callerToken, `Bearer Bearer ${callerToken}`, `Bearer ${callerToken}\nextra`, `Bearer short`]) {
    await writeFile(callerFile, value, { mode: 0o600 })
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/reconciliation/tunnelMain.ts', '--port', String(port), '--upstream-port', String(options.upstreamPort), '--caller-id', 'owner-chatgpt', '--caller-token-file', callerFile], { env: { ...process.env, TINSTAR_CONFIG_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    try {
      if (value === `Bearer ${callerToken}` || value === `Bearer ${callerToken}\n`) {
        await new Promise<void>((resolve, reject) => {
          // tsx startup of the tunnel CLI exceeds 5s when another suite is on the machine.
          const timer = setTimeout(() => reject(new Error('CLI startup timed out')), 20_000)
          child.stdout.on('data', () => { clearTimeout(timer); resolve() })
          child.once('exit', () => { clearTimeout(timer); reject(new Error('CLI exited before startup')) })
        })
        const client = new Client({ name: 'cli-test', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: value.trim() } } }))
        expect((await client.listTools()).tools).toHaveLength(18)
        await client.close()
      } else {
        expect((await exited)[0]).toBe(1)
      }
      expect(output).not.toContain(callerToken)
      expect(output).not.toContain(options.installToken)
    } finally {
      if (child.exitCode === null) child.kill()
      await exited
    }
  }
}, 120_000)
