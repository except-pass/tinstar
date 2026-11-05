import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ReconciliationMcp, privatePeer } from '../mcp'
import { fixtureScene, fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { buildQueue } from '../queue'
import { buildWorkerLinkReport } from '../workerLinkReport'
import { queueSignals } from '../queueInputs'
import { applyPresentationAction, initialPresentation } from '../../../shared/reconciliationPresentation'
import { seedOriginAllowlist } from '../../api/originAllowlist'
let root = '', server: Server | undefined, client: Client | undefined
const parse = (value: unknown) => JSON.parse((value as { content: Array<{ text: string }> }).content[0]!.text)
afterEach(async () => { await client?.close(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); if (root) await rm(root, { recursive: true, force: true }) })
describe('authenticated real MCP transport', () => {
  it('uses private per-install auth and exposes only scoped reads/presentation', async () => {
    root = await mkdtemp(join(tmpdir(), 'tinstar-mcp-'))
    const scene = fixtureScene()
    const mcp = new ReconciliationMcp({ workerLinkReport: async () => buildWorkerLinkReport(fixtureSources()), scene: async () => scene, card: async () => ({ outcome: 'available', blocks: [] }), queue: async () => ({ outcome: 'queue-source-unavailable', message: 'Explicit unavailable source test' }) }, root)
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
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['list_ui_sessions', 'get_scene', 'read_record', 'get_card_context', 'get_queue', 'get_worker_link_report', 'present_view', 'next_queue_item', 'get_command'])
    const sessions = parse(await client.callTool({ name: 'list_ui_sessions', arguments: {} }))
    expect(sessions.sessions[0].scene_id).toBe(identity.scene_id)
    expect(JSON.stringify(sessions)).not.toContain(identity.key)
    expect(parse(await client.callTool({ name: 'get_scene', arguments: { scene_id: identity.scene_id } })).state.arrangement).toBe('initiative')
    expect(parse(await client.callTool({ name: 'get_card_context', arguments: { scene_id: identity.scene_id, card_id: scene.cards[0]!.id } })).context.outcome).toBe('available')
    expect(parse(await client.callTool({ name: 'get_queue', arguments: { scene_id: identity.scene_id } })).outcome).toBe('queue-source-unavailable')
    expect(parse(await client.callTool({ name: 'get_worker_link_report', arguments: {} })).schema).toBe('tinstar.worker-link-report.v1')
    const reportUrl = `${base}/api/reconciliation/worker-links/report`
    expect((await fetch(reportUrl)).status).toBe(401)
    expect((await fetch(reportUrl, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    const auth = { Authorization: `Bearer ${token}` }
    expect((await fetch(reportUrl, { method: 'POST', headers: auth })).status).toBe(405)
    expect((await fetch(reportUrl, { headers: { ...auth, Origin: 'https://evil.example' } })).status).toBe(403)
    const response = await fetch(reportUrl, { headers: auth })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json()).data.mode).toBe('report-only')
    const cli = fileURLToPath(new URL('../../../../scripts/worker-link-report.ts', import.meta.url))
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', cli, '--server', base, '--config-home', root])
    expect(JSON.parse(stdout).schema).toBe('tinstar.worker-link-report.v1')
    const offline = await promisify(execFile)(process.execPath, ['--import', 'tsx', cli, '--config-home', root])
    const unknown = JSON.parse(offline.stdout)
    expect(unknown.homes).toEqual([])
    expect(unknown.coverage.absenceConclusions).toBe('suppressed')
    expect(unknown.findings.some((f: { detector: string }) => f.detector === 'unknown-coverage')).toBe(true)
    expect(stdout + offline.stdout).not.toContain(token)
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
  it('reports exact queue sources over real MCP and retains acknowledged next navigation', async () => {
    root = await mkdtemp(join(tmpdir(), 'tinstar-desk-mcp-'))
    const sources = fixtureSources(), home = sources.fleet[1]!, task = home.observation.data!.tasks[0]!
    task.queue = queueSignals({ hints: { open_decisions: [{ key: 'choose', verb: 'needs-decision', summary: 'Choose A or B' }] } }).queue
    home.observation.data!.backlog!.push({ id: 'choose', title: 'Choose A or B', state: 'held', kind: 'ship', repo: null,
      hold_reason: 'Choose A or B', hold_until: null, blocked_by: null, captain_actionable: true, pr_url: null, cardReferences: [],
      ...queueSignals({ hold_kind: 'captain', body_lines: ['Origin: linked-worker'] }) })
    const queue = buildQueue(sources), scene = fixtureScene(), original = JSON.stringify(queue)
    const mcp = new ReconciliationMcp({ workerLinkReport: async () => buildWorkerLinkReport(fixtureSources()), scene: async () => scene, card: async () => ({}), queue: async () => queue }, root)
    server = createServer((req, res) => { void mcp.handle(req, res) })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
    client = new Client({ name: 'desk-source-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const state = initialPresentation(), identity = mcp.sessions.register(state)
    const read = parse(await client.callTool({ name: 'get_queue', arguments: { scene_id: identity.scene_id } }))
    const ready = read.items.find((item: { readiness: string }) => item.readiness === 'ready-now')
    expect(ready.sources.map((source: { request?: unknown }) => source.request)).toEqual(expect.arrayContaining([
      { home: home.source.home, taskId: task.id, id: 'choose', kind: 'decision' },
      { home: home.source.home, taskId: task.id, id: 'choose', kind: 'hold' },
    ]))
    expect(ready.sources.filter((source: { request?: unknown }) => source.request).every((source: { readiness: string; responseAnchor?: string }) => source.readiness === 'ready-now' && source.responseAnchor)).toBe(true)
    const args = { scene_id: identity.scene_id, command_id: 'next-exact-sources', expected_revision: 0 }
    const pending = client.callTool({ name: 'next_queue_item', arguments: args })
    let commands = mcp.sessions.sync(identity.scene_id, state, [])
    for (let i = 0; i < 20 && !commands.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      commands = mcp.sessions.sync(identity.scene_id, state, [])
    }
    expect(commands).toHaveLength(1)
    const applied = applyPresentationAction(state, commands[0]!.action, scene, Date.now(), queue)
    mcp.sessions.sync(identity.scene_id, applied.state, [{ scene_id: identity.scene_id, command_id: args.command_id, outcome: applied.outcome, state: applied.state, revision: applied.state.revision, applied_at: Date.now() }])
    expect(parse(await pending).outcome).toBe('applied')
    expect(parse(await client.callTool({ name: 'next_queue_item', arguments: args })).outcome).toBe('applied')
    expect(JSON.stringify(queue)).toBe(original)
  })
  it('restricts peers to loopback and tailnet ranges', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.1.2', '100.127.2.1', 'fd7a:115c:a1e0::1']) expect(privatePeer(ip)).toBe(true)
    for (const ip of ['192.168.1.2', '8.8.8.8', '100.63.1.2', '100.128.2.1', '']) expect(privatePeer(ip)).toBe(false)
  })
})
