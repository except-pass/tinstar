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
import { fixtureScene, fixtureSources, fixtureQueue } from '../../../../test-fixtures/reconciliation/scenes'
import { buildQueue } from '../queue'
import { buildWorkerLinkReport } from '../workerLinkReport'
import { queueSignals } from '../queueInputs'
import { applyPresentationAction, initialPresentation } from '../../../shared/reconciliationPresentation'
import { presentationTargets } from '../../../shared/presentationObservation'
import { seedOriginAllowlist } from '../../api/originAllowlist'
let root = '', server: Server | undefined, client: Client | undefined
const parse = (value: unknown) => JSON.parse((value as { content: Array<{ text: string }> }).content[0]!.text)
afterEach(async () => { await client?.close(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); if (root) await rm(root, { recursive: true, force: true }) })
// Real MCP client over loopback. Handshake and tool calls exceed 5s beside another suite.
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
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['claim_next_card', 'claim_card', 'release_claim', 'session_probe', 'search_work', 'get_work', 'get_work_views', 'get_workflow_rules', 'submit_handoff', 'start_work', 'create_work', 'update_work', 'list_ui_sessions', 'get_scene', 'read_record', 'get_card_context', 'get_queue', 'get_worker_link_report', 'present_view', 'next_queue_item', 'get_command', 'list_prs', 'get_pr', 'get_release_status'])
    expect(parse(await client.callTool({ name: 'get_work_views', arguments: {} })).outcome).toBe('queue-source-unavailable')
    const sessions = parse(await client.callTool({ name: 'list_ui_sessions', arguments: {} }))
    expect(sessions.sessions[0].scene_id).toBe(identity.scene_id)
    expect(JSON.stringify(sessions)).not.toContain(identity.key)
    const second = mcp.sessions.register(initialPresentation())
    expect(parse(await client.callTool({ name: 'present_view', arguments: { command_id: 'ambiguous', expected_revision: 0, action: { type: 'clear-transient' } } })).outcome).toBe('ambiguous-session')
    expect(parse(await client.callTool({ name: 'get_scene', arguments: { session_code: second.session_code } })).scene_id).toBe(second.scene_id)
    const ui = (input: unknown) => fetch(`${base}/api/reconciliation/ui`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify(input) })
    expect((await ui({ type: 'designate', scene_id: second.scene_id, key: identity.key })).status).toBe(403)
    expect((await ui({ type: 'designate', scene_id: second.scene_id, key: second.key })).status).toBe(200)
    expect(parse(await client.callTool({ name: 'get_scene', arguments: {} })).scene_id).toBe(second.scene_id)
    const listed = parse(await client.callTool({ name: 'list_ui_sessions', arguments: {} }))
    expect(listed.targeting.scene_id).toBe(second.scene_id)
    expect(JSON.stringify(listed)).not.toContain(second.key)
    mcp.sessions.disconnect(second.scene_id)

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
  it.each(['present_view', 'next_queue_item'])('retains implicit %s retries on their original tab after designation changes', async name => {
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
    const second = mcp.sessions.register(state)
    mcp.sessions.designate(identity.scene_id)
    const args = { command_id: 'next-exact-sources', expected_revision: 0, ...(name === 'present_view' ? { action: { type: 'navigate-queue', direction: 'next' } } : {}) }
    const pending = client.callTool({ name, arguments: args })
    let commands = mcp.sessions.sync(identity.scene_id, state, [])
    for (let i = 0; i < 20 && !commands.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      commands = mcp.sessions.sync(identity.scene_id, state, [])
    }
    expect(commands).toHaveLength(1)
    const applied = applyPresentationAction(state, commands[0]!.action, scene, Date.now(), queue)
    mcp.sessions.sync(identity.scene_id, applied.state, [{ scene_id: identity.scene_id, command_id: args.command_id, outcome: applied.outcome, state: applied.state, revision: applied.state.revision, applied_at: Date.now() }])
    expect(parse(await pending).outcome).toBe('applied')
    mcp.sessions.designate(second.scene_id)
    expect(parse(await client.callTool({ name, arguments: args }))).toMatchObject({ outcome: 'applied', scene_id: identity.scene_id, revision: 1 })
    expect(mcp.sessions.sync(second.scene_id, state, [])).toEqual([])
    expect(mcp.sessions.read(second.scene_id).state?.revision).toBe(0)
    expect(mcp.sessions.enqueue({ scene_id: second.scene_id, command_id: args.command_id, expected_revision: 0, ttl_ms: 8000, action: { type: 'navigate-queue', direction: 'next' } }, scene, queue).outcome).toBe('queued')
    expect(JSON.stringify(queue)).toBe(original)
  })
  it.each([
    ['present_view', 'queue'], ['present_view', 'scene'],
    ['next_queue_item', 'queue'], ['next_queue_item', 'scene'],
  ])('binds overlapping implicit %s retries before deferred %s reads', async (name, heldSource) => {
    root = await mkdtemp(join(tmpdir(), 'tinstar-inflight-mcp-'))
    const scene = fixtureScene(), queue = fixtureQueue(), state = initialPresentation()
    let release!: () => void, firstEntered!: () => void, secondEntered!: () => void, reads = 0
    const blocked = new Promise<void>(resolve => { release = resolve })
    const firstRead = new Promise<void>(resolve => { firstEntered = resolve })
    const secondRead = new Promise<void>(resolve => { secondEntered = resolve })
    const waitForRead = async () => {
      reads++
      if (reads === 1) firstEntered()
      if (reads === 2) secondEntered()
      await blocked
    }
    const mcp = new ReconciliationMcp({
      scene: async () => { if (heldSource === 'scene') await waitForRead(); return scene },
      queue: async () => { if (heldSource === 'queue') await waitForRead(); return queue },
      card: async () => ({}), workerLinkReport: async () => buildWorkerLinkReport(fixtureSources()),
    }, root)
    server = createServer((req, res) => { void mcp.handle(req, res) })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
    client = new Client({ name: 'inflight-retry-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const a = mcp.sessions.register(state), b = mcp.sessions.register(state)
    mcp.sessions.designate(a.scene_id)
    const args = { command_id: 'overlapping', expected_revision: 0, ...(name === 'present_view' ? { action: { type: 'navigate-queue', direction: 'next' } } : {}) }
    const original = client.callTool({ name, arguments: args })
    await firstRead
    mcp.sessions.designate(b.scene_id)
    const retry = client.callTool({ name, arguments: args })
    await secondRead
    expect(mcp.sessions.sync(a.scene_id, state, [])).toEqual([])
    expect(mcp.sessions.sync(b.scene_id, state, [])).toEqual([])
    release()
    let commands = mcp.sessions.sync(a.scene_id, state, [])
    for (let i = 0; i < 100 && !commands.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      commands = mcp.sessions.sync(a.scene_id, state, [])
    }
    expect(commands).toHaveLength(1)
    const applied = applyPresentationAction(state, commands[0]!.action, scene, Date.now(), queue)
    expect(applied.outcome).toBe('applied')
    mcp.sessions.sync(a.scene_id, applied.state, [{ scene_id: a.scene_id, command_id: args.command_id, outcome: 'applied', state: applied.state, revision: applied.state.revision, applied_at: Date.now() }])
    for (const response of await Promise.all([original, retry])) expect(parse(response)).toMatchObject({ outcome: 'applied', scene_id: a.scene_id, revision: 1 })
    expect(parse(await client.callTool({ name, arguments: { ...args, expected_revision: 1 } })).outcome).toBe('conflict')
    expect(mcp.sessions.sync(b.scene_id, state, [])).toEqual([])
    expect(mcp.sessions.result(b.scene_id, args.command_id).outcome).toBe('unknown-id')
    expect(mcp.sessions.read(b.scene_id).state?.revision).toBe(0)
  })
  it('accepts a full reveal acknowledgment and replay state through the real UI route', async () => {
    root = await mkdtemp(join(tmpdir(), 'tinstar-reveal-sync-'))
    const scene = fixtureScene(), template = scene.cards[0]!
    scene.cards = Array.from({ length: 4097 }, (_, index) => ({ ...template, id: index === 0 ? 'primary'.padEnd(2048, 'x') : index.toString(16).padStart(32, '0') }))
    const mcp = new ReconciliationMcp({ scene: async () => scene, card: async () => ({}), queue: async () => ({ outcome: 'queue-source-unavailable', message: 'unused' }), workerLinkReport: async () => buildWorkerLinkReport(fixtureSources()) }, root)
    server = createServer((req, res) => { void mcp.handle(req, res) })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const ui = async (input: unknown) => {
      const response = await fetch(`${base}/api/reconciliation/ui`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify(input) })
      expect(response.status).toBe(200)
      return (await response.json()).data
    }
    const state = initialPresentation(), identity = await ui({ type: 'register', state })
    const target = { kind: 'card' as const, id: scene.cards[0]!.id }
    const action = { type: 'reveal-search' as const, target, targets: scene.cards.slice(1).map(card => ({ kind: 'card' as const, id: card.id })) }
    const args = { scene_id: identity.scene_id, command_id: 'large-reveal', expected_revision: 0, action }
    expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'present_view', arguments: args } }))).toBeLessThan(256 * 1024)
    client = new Client({ name: 'large-reveal-test', version: '1' })
    const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const pending = client.callTool({ name: 'present_view', arguments: args })
    let commands = mcp.sessions.sync(identity.scene_id, state, [])
    for (let i = 0; i < 100 && !commands.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      commands = mcp.sessions.sync(identity.scene_id, state, [])
    }
    expect(commands).toHaveLength(1)
    const applied = applyPresentationAction(state, commands[0]!.action, scene)
    expect(applied.outcome).toBe('applied')
    expect(applied.state.searchFocus).toEqual(presentationTargets(action))
    const ids = presentationTargets(action).map(target => `${target.kind}:${target.id}`)
    const ack = { scene_id: identity.scene_id, command_id: args.command_id, outcome: 'applied', state: applied.state, revision: applied.state.revision, applied_at: Date.now(), delivery: { stage: 'not-visible', targets: ids, rendered_targets: ids, visible_targets: [], pending: true } }
    const payload = { type: 'sync', scene_id: identity.scene_id, key: identity.key, state: applied.state, acknowledgments: [ack], rendered_scene: { scene_generated_at: scene.generatedAt, scene_read_failed: false, selection: ids[0] } }
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(256 * 1024)
    expect((await ui(payload)).commands).toEqual([])
    expect(parse(await pending).outcome).toBe('applied')
    const replayState = { ...applied.state, flash: { ids, until: Date.now() + 4000, revealTargets: true } }
    await ui({ ...payload, state: replayState, acknowledgments: [{ ...ack, delivery: { stage: 'foreground-visible', targets: ids, rendered_targets: ids, visible_targets: ids, pending: false } }] })
    expect(mcp.sessions.read(identity.scene_id).state?.flash?.ids).toEqual(ids)
    expect(mcp.sessions.read(identity.scene_id).state?.revision).toBe(1)
    expect(mcp.sessions.result(identity.scene_id, args.command_id).delivery).toMatchObject({ stage: 'foreground-visible', visible_targets: ids, pending: false })
  })
  it('restricts peers to loopback and tailnet ranges', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.1.2', '100.127.2.1', 'fd7a:115c:a1e0::1']) expect(privatePeer(ip)).toBe(true)
    for (const ip of ['192.168.1.2', '8.8.8.8', '100.63.1.2', '100.128.2.1', '']) expect(privatePeer(ip)).toBe(false)
  })
}, 30_000)
