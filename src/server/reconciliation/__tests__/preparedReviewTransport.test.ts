import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CardLeases } from '../cardLeases'
import { DecisionPackets } from '../decisionPackets'
import { PreparedReviews } from '../preparedReviews'
import { DecisionDeskApi } from '../decisionDeskApi'
import { ReconciliationMcp } from '../mcp'
import { createTunnelFacade } from '../tunnel'
import { preparedDecisionFixture } from '../../../../test-fixtures/reconciliation/preparedDecision'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { seedOriginAllowlist } from '../../api/originAllowlist'

const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}
async function setup(count: number) {
  const root = await mkdtemp(join(tmpdir(), 'prepared-http-')); roots.push(root)
  const leases = new CardLeases(root), packets = new DecisionPackets(leases), now = Date.now()
  const fixtures = Array.from({ length: count }, (_, index) => {
    const fixture = preparedDecisionFixture(now), card = (index + 100).toString(16).padStart(32, '0')
    return JSON.parse(JSON.stringify({ cardId: fixture.cardId, packet: fixture.packet, evidence: fixture.evidence }).replaceAll(fixture.cardId, card)) as Pick<typeof fixture, 'cardId' | 'packet' | 'evidence'>
  })
  for (const [index, f] of fixtures.entries()) await packets.publish(f.packet, f.evidence, 'fixture', `publication-${index}`)
  const reviews = new PreparedReviews(packets, 'preview-board', card => fixtures.find(f => f.cardId === card)!.evidence, () => ({ card_ids: fixtures.map(f => f.cardId), coverage: 'complete', requests: count }))
  return { root, leases, packets, reviews, fixtures }
}

it.each([2, 5])('serves %i independent SDK client processes through the authenticated MCP facade without collisions or source access', async count => {
  const { root, leases, reviews, fixtures } = await setup(count)
  const mcp = new ReconciliationMcp({ leases, preparedReviews: reviews, scene: async () => fixtureScene(), card: async () => { throw new Error('Prepared path must not call get_work') }, queue: async () => { throw new Error('Prepared path must not invoke queue reconciliation') }, workerLinkReport: async () => { throw new Error('Not used by prepared claims') } }, root)
  const upstreamPort = await listen(createServer((req, res) => { void mcp.handle(req, res) }))
  const installToken = (await readFile(join(root, 'mcp-token'), 'utf8')).trim(), callerToken = 'synthetic-prepared-transport-caller-only-123456789'
  const facade = createTunnelFacade({ upstreamPort, installToken, caller: { id: 'fixture-reviewer', token: callerToken, allowView: false }, configRoot: root })
  const facadePort = await listen(facade.server)
  const inputFile = join(root, 'client-input.json')
  await writeFile(inputFile, JSON.stringify({ url: `http://127.0.0.1:${facadePort}/mcp`, token: callerToken }), { mode: 0o600 })
  const child = `
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(process.argv[1], 'utf8')), id = process.argv[2];
    const client = new Client({name:'isolated-prepared-client',version:'1'});
    const parse = result => JSON.parse(result.content[0].text);
    await client.connect(new StreamableHTTPClientTransport(new URL(input.url), {requestInit:{headers:{Authorization:'Bearer '+input.token}}}));
    try {
      const tools = (await client.listTools()).tools.map(t => t.name);
      const opened = parse(await client.callTool({name:'open_prepared_review_session', arguments:{operation_id:'open-'+id,label:'Real fixture client '+id,device:'desktop'}}));
      const args = {operation_id:'claim-'+id,review_session_token:opened.review_session_token};
      const start = performance.now();
      const claimed = parse(await client.callTool({name:'claim_next_prepared_decision',arguments:args}));
      const elapsed = performance.now()-start;
      const replay = parse(await client.callTool({name:'claim_next_prepared_decision',arguments:args}));
      const resumed = parse(await client.callTool({name:'claim_next_prepared_decision',arguments:{operation_id:'resume-'+id,lease_token:claimed.lease_token}}));
      process.stdout.write(JSON.stringify({outcome:claimed.outcome,card:claimed.lease?.card_id,version:claimed.packet_version,elapsed_ms:elapsed,session:opened.session.id,
        replay_matches:claimed.lease_token===replay.lease_token && claimed.lease?.card_id===replay.lease?.card_id,
        resumed_matches:resumed.outcome==='held' && claimed.lease?.card_id===resumed.lease?.card_id,tools}));
    } finally {await client.close()}
  `
  const results = await Promise.all(Array.from({ length: count }, (_, index) => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child, inputFile, String(index)], { timeout: 15_000 })))
  const values = results.map(result => JSON.parse(result.stdout) as { outcome: string; card: string; version: number; replay_matches: boolean; resumed_matches: boolean; session: string; tools: string[] })
  expect(values.every(value => value.outcome === 'claimed' && value.version === 1 && value.replay_matches && value.resumed_matches)).toBe(true)
  expect(new Set(values.map(value => value.card))).toEqual(new Set(fixtures.map(f => f.cardId)))
  expect(new Set(values.map(value => value.session)).size).toBe(count)
  expect(values[0]!.tools).toContain('claim_prepared_decision')
  expect((await leases.claim(fixtures.map(f => f.cardId), 'generic', 'Generic', 'all-held')).outcome).toBe('no-unclaimed-card')
  expect(await reviews.list('unrelated-identity')).toEqual({ sessions: [] })
}, 30_000)

it('requires explicit browser resource creation and owner capability continuity; list metadata grants no ownership', async () => {
  const { packets, reviews, fixtures } = await setup(2)
  const api = new DecisionDeskApi(packets, 'preview-board', () => fixtures[0]!.evidence, async req => req.headers['tailscale-user-login'] === 'fixture-owner', reviews)
  const port = await listen(createServer((req, res) => { void api.handle(req, res) })); seedOriginAllowlist(port)
  const base = `http://127.0.0.1:${port}/api/reconciliation/decision-desk`
  const headers = { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1', 'Tailscale-User-Login': 'fixture-owner' }
  const post = (path: string, input: unknown, h = headers) => fetch(`${base}/${path}`, { method: 'POST', headers: h, body: JSON.stringify(input) })
  expect((await post('sessions', { operation_id: 'open', label: 'Phone', device: 'phone' }, { ...headers, 'Tailscale-User-Login': 'intruder' })).status).toBe(403)
  expect((await post('claim', { operation_id: 'no-resource' })).status).toBe(400)
  const opened = (await (await post('sessions', { operation_id: 'open', label: 'Phone', device: 'phone' })).json()).data
  const held = (await (await post('claim', { operation_id: 'claim', review_session_token: opened.review_session_token })).json()).data
  expect(held).toMatchObject({ outcome: 'claimed', session_id: opened.session.id })
  const listedResponse = await fetch(`${base}/sessions`, { headers }), listed = (await listedResponse.json()).data
  expect(listedResponse.headers.get('cache-control')).toBe('no-store')
  expect(listed.sessions).toHaveLength(1)
  expect(JSON.stringify(listed)).not.toContain(opened.review_session_token)
  expect((await (await post('claim', { operation_id: 'guessed', review_session_token: listed.sessions[0].id })).json()).data).toMatchObject({ code: 'claim-lost' })
  expect((await (await post('claim', { operation_id: 'cloned-tab', review_session_token: opened.review_session_token })).json()).data).toMatchObject({ outcome: 'held', lease: held.lease })
  expect((await (await post('close-session', { review_session_token: opened.review_session_token, reason: 'Close phone review' })).json()).data).toEqual({ outcome: 'closed' })
  expect((await (await fetch(`${base}/sessions`, { headers })).json()).data.sessions).toHaveLength(0)
  expect((await (await post('claim', { operation_id: 'revoked', review_session_token: opened.review_session_token })).json()).data).toMatchObject({ code: 'claim-lost' })
}, 15_000)

it('requires an owner settled-request declaration and server-side readback before auditing recovery', async () => {
  const { leases, packets, reviews, fixtures } = await setup(1), card = fixtures[0]!.cardId
  const { sourceWriteDispatched } = await import('../cardLeases')
  await expect(leases.mutate(card, async () => { sourceWriteDispatched(); throw new Error('Provider timeout') }, { kind: 'note', text: 'Receipt', marker: 'fixture' })).rejects.toThrow('Provider timeout')
  const pending = leases.pendingWrites()[0]!
  let available = false, probes = 0
  const recovery = { list: () => leases.pendingWrites(), reconcile: (id: string, operation: string, actor: string, reason: string) => leases.reconcileWrite(id, operation, actor, reason, async intent => {
    probes++; return !available || intent?.marker !== 'fixture' ? 'unknown' : 'applied'
  }) }
  const api = new DecisionDeskApi(packets, 'preview-board', () => fixtures[0]!.evidence, async req => req.headers['tailscale-user-login'] === 'fixture-owner', reviews, recovery)
  const port = await listen(createServer((req, res) => { void api.handle(req, res) })); seedOriginAllowlist(port)
  const base = `http://127.0.0.1:${port}/api/reconciliation/decision-desk`
  const headers = { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1', 'Tailscale-User-Login': 'fixture-owner' }
  const input = { card_id: card, operation: pending.operation, earlier_request_settled: true, reason: 'Operator inspected transport completion and source receipt' }
  const post = (value: unknown, h = headers) => fetch(`${base}/reconcile-source-write`, { method: 'POST', headers: h, body: JSON.stringify(value) })
  expect((await fetch(`${base}/source-writes`)).status).toBe(403)
  expect((await post(input, { ...headers, 'Tailscale-User-Login': 'intruder' })).status).toBe(403)
  expect((await post({ ...input, earlier_request_settled: false })).status).toBe(400)
  expect(probes).toBe(0)
  expect((await (await post(input)).json()).data).toMatchObject({ outcome: 'source-unavailable' })
  expect(leases.pendingWrites()).toHaveLength(1)
  available = true
  expect((await (await post(input)).json()).data).toMatchObject({ outcome: 'reconciled', source_state: 'applied' })
  expect(probes).toBe(2)
  expect(leases.pendingWrites()).toHaveLength(0)
  const events = leases.readStorage(db => db.prepare("SELECT detail FROM lease_events WHERE type = 'write-reconciled'").all())
  expect(JSON.stringify(events)).toContain('fixture-owner')
  expect(JSON.stringify(events)).toContain(input.reason)
})
