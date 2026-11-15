/** P3 fixed-head API proof. Runs only against a new config root and an isolated
 * HTTP Notion-compatible fixture source. No live tokens, board, bridge or UI. */
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { decisionSubmitFixture } from '../test-fixtures/reconciliation/decisionSubmit'
import { DecisionDeskApi } from '../src/server/reconciliation/decisionDeskApi'
import { PullsApi } from '../src/server/pulls/routes'
import { AssociationStore } from '../src/server/releases/associations'
import { seedOriginAllowlist } from '../src/server/api/originAllowlist'
import { ReconciliationMcp, installToken } from '../src/server/reconciliation/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fixtureScene } from '../test-fixtures/reconciliation/scenes'
import { boundSearchDocuments, sceneSearchDocuments } from '../src/shared/searchDocuments'
import type { PreparedClaimResult } from '../src/server/reconciliation/preparedReviews'
import type { PreparedSubmitResult } from '../src/server/reconciliation/preparedSubmissions'

if (!process.argv[2]) throw new Error('Provide a task proof output directory')
const output = resolve(process.argv[2]); await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'isolated-submit-'))
process.env.TINSTAR_CONFIG_HOME = root
await writeFile(join(root, 'config.json'), JSON.stringify({ ask: { ownerLogins: ['preview-owner@example.test'], bridgeToken: 'isolated-submit-preview-only-123456789' }, reconciliation: { fleet: [] } }), { mode: 0o600 })
const fixture = decisionSubmitFixture(40)
// Synthetic request latency is explicit, not presented as production latency.
fixture.controls.delayMs = 10
const listen = async (server: Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}` }
const servers: Server[] = []
const sourceServer = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
  try {
    const response = await fixture.fetcher(`https://api.notion.com${req.url}`, { method: req.method, ...(chunks.length ? { body: Buffer.concat(chunks).toString() } : {}) })
    // Persist source effects before returning, including lost-response faults.
    await writeFile(join(root, 'isolated-source-state.json'), JSON.stringify({ pages: [...fixture.pages], comments: [...fixture.comments] }))
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text())
  } catch {
    await writeFile(join(root, 'isolated-source-state.json'), JSON.stringify({ pages: [...fixture.pages], comments: [...fixture.comments] }))
    res.destroy()
  }
})
servers.push(sourceServer)
const sourceUrl = await listen(sourceServer)
const sourceTransport: typeof fetch = (url, init) => {
  const parsed = new URL(String(url))
  if (parsed.hostname !== 'api.notion.com') throw new Error('Fixture proof accepts only its isolated source adapter')
  return fetch(`${sourceUrl}${parsed.pathname}${parsed.search}`, init)
}
const backend = await fixture.build(root, sourceTransport)
const scene = async () => { const value = fixtureScene(); return { ...value, searchIndex: boundSearchDocuments(sceneSearchDocuments(value)) } }
const authorization = new PullsApi({ scene }, new AssociationStore(root), root)
const api = new DecisionDeskApi(backend.packets, 'isolated-submit-board', card => fixture.fixtures.find(f => f.cardId === card)!.evidence,
  req => authorization.authorized(req), backend.reviews, undefined, backend.submissions)
const mcp = new ReconciliationMcp({ leases: backend.leases, preparedReviews: backend.reviews, preparedSubmissions: backend.submissions, scene,
  card: async () => { throw new Error('Prepared submit never calls generic card UI') }, queue: async () => { throw new Error('Prepared submit never invokes generic queue/reconciliation') },
  workerLinkReport: async () => { throw new Error('No live worker in isolated proof') } }, root)
const productServer = createServer(async (req, res) => {
  try { if (await api.handle(req, res) || await mcp.handle(req, res)) return; res.writeHead(404); res.end() }
  catch { res.writeHead(500); res.end('Isolated product error') }
})
servers.push(productServer)
const url = await listen(productServer); seedOriginAllowlist(Number(new URL(url).port))
const headers = { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1', 'Tailscale-User-Login': 'preview-owner@example.test' }
const evidence: Record<string, unknown> = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), root, source_url: sourceUrl, product_url: url,
  isolated_source: true, source_request_delay_ms: fixture.controls.delayMs, source_writes: 'Disposable HTTP fixture source only; no live bridge or enrolled homes', samples: [], scenarios: [] }
const scenarios = evidence.scenarios as string[]
const client = new Client({ name: 'isolated-submit-proof', version: '1' })
async function call<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(`${url}/api/reconciliation/decision-desk/${path}`, { headers, ...(value === undefined ? {} : { method: 'POST', body: JSON.stringify(value) }) })
  const envelope = await response.json()
  assert.equal(response.status, 200, JSON.stringify(envelope))
  assert.equal(envelope.ok, true)
  return envelope.data as T
}
const inputFor = (held: PreparedClaimResult, operation: string) => ({ operation_id: operation, lease_token: held.lease_token,
  packet_id: held.packet!.id, packet_version: held.packet!.version, request_id: held.packet!.packet.binding.request_id,
  option_id: 'preview', next: { owner: 'Firstmate', status: 'Queued' } })
try {
  assert.equal((await fetch(`${url}/api/reconciliation/decision-desk/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
  scenarios.push('Owner authentication required for source submit')
  const session = await call<{ review_session_token: string }>('sessions', { operation_id: 'preview-session', label: 'Real isolated API session', device: 'desktop' })
  let held = await call<PreparedClaimResult>('claim', { operation_id: 'preview-claim', review_session_token: session.review_session_token })
  const firstInput = inputFor(held, 'preview-first-submit')
  fixture.controls.reject = true
  const failure = await call<PreparedSubmitResult>('submit', firstInput)
  assert.equal(failure.outcome, 'not-saved'); assert(backend.leases.status(held.lease!.card_id))
  const recovery = await call<{ submissions: unknown[] }>('submission-state', { review_session_token: session.review_session_token })
  assert.equal(recovery.submissions.length, 1)
  fixture.controls.reject = false
  const saved = await call<PreparedSubmitResult>('submit', firstInput)
  assert.equal(saved.outcome, 'recorded'); assert.equal(backend.leases.status(held.lease!.card_id), null)
  held = saved.next!
  scenarios.push('Definite source failure retains selection and lease; same-id retry records and advances; context recovery is durable')
  const samples = evidence.samples as Array<Record<string, number | string>>
  for (let i = 0; i < 30; i++) {
    assert(held.lease_token)
    const started = performance.now()
    const result = await call<PreparedSubmitResult>('submit', inputFor(held, `timed-submit-${i}`))
    const duration = performance.now() - started
    assert.equal(result.outcome, 'recorded')
    assert.equal(result.source_state, 'recorded-awaiting-worker-acknowledgment')
    samples.push({ index: i, outcome: result.outcome, submit_readback_to_next_ms: duration })
    held = result.next!
  }
  scenarios.push('30 filled-buffer source-write/readback-to-next samples; no worker acknowledgment in the critical path')
  const resumed = await call<PreparedClaimResult>('claim', { operation_id: 'resume-preview-session', review_session_token: session.review_session_token })
  assert.equal(resumed.lease!.card_id, held.lease!.card_id)
  const sessions = await Promise.all(Array.from({ length: 5 }, (_, i) => call<{ review_session_token: string }>('sessions', { operation_id: `parallel-${i}`, label: `Independent API context ${i}`, device: 'desktop' })))
  const claims = await Promise.all(sessions.map((s, i) => call<PreparedClaimResult>('claim', { operation_id: `parallel-claim-${i}`, review_session_token: s.review_session_token })))
  assert.equal(new Set(claims.map(c => c.lease!.card_id)).size, 5)
  scenarios.push('Five independent authenticated API contexts claim distinct cards; same-context claim resumes its hold')
  const before = fixture.writes.length
  const skipped = await call<{ outcome: string; next: PreparedClaimResult }>('release', { operation_id: 'skip-proof', lease_token: claims[0]!.lease_token, action: 'skip' })
  assert.equal(skipped.outcome, 'skipped'); assert.notEqual(skipped.next.lease?.card_id, claims[0]!.lease!.card_id)
  assert.equal(fixture.writes.length, before)
  const research = await call<{ outcome: string }>('release', { operation_id: 'research-proof', lease_token: claims[1]!.lease_token, action: 'research', reason: 'Need more isolated rollback evidence' })
  assert.equal(research.outcome, 'research-requested'); assert.equal(fixture.writes.length, before)
  scenarios.push('HTTP skip and research have no source effects; skip excludes current card and research withdraws its packet')
  // Real SDK/catalog path uses its own opaque context, never a browser scene.
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${installToken(root)}` } } }))
  const tools = await client.listTools()
  assert(tools.tools.some(tool => tool.name === 'submit_prepared_decision'))
  const textResult = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as Array<{ type: string; text: string }>).find(row => row.type === 'text')!.text)
  const mcpClaim = textResult(await client.callTool({ name: 'claim_next_prepared_decision', arguments: { operation_id: 'mcp-claim' } })) as PreparedClaimResult
  assert(mcpClaim.lease_token)
  const mcpResult = textResult(await client.callTool({ name: 'submit_prepared_decision', arguments: inputFor(mcpClaim, 'mcp-submit') })) as PreparedSubmitResult
  assert.equal(mcpResult.outcome, 'recorded')
  scenarios.push('Real MCP SDK submit uses the shared exact source answer path and advances with opaque lease capabilities')
  const metrics = await call('metrics')
  const times = samples.map(row => Number(row.submit_readback_to_next_ms)).sort((a, b) => a - b)
  evidence.timings = { samples: times.length, p50_ms: times[Math.ceil(times.length * 0.5) - 1], p95_ms: times[Math.ceil(times.length * 0.95) - 1], max_ms: times.at(-1),
    budget_ms: 3000, interpretation: 'Isolated HTTP source with 10ms synthetic delay per provider request and durable JSON source state; excludes research and real provider/network latency. P6 production-like acceptance remains.' }
  evidence.metrics = metrics; evidence.source_write_requests = fixture.writes.length
  evidence.answer_events = backend.leases.readStorage(db => db.prepare("SELECT type,at,detail FROM decision_packet_events WHERE type = 'answer-confirmed'").all())
  evidence.submit_events = backend.leases.events(0, 500).filter(row => row.type === 'prepared-submit-to-next')
  evidence.outcome = 'passed'
  await writeFile(join(output, 'api-proof.json'), JSON.stringify(evidence, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ outcome: 'passed', head: evidence.head, scenarios: scenarios.length, timings: evidence.timings, root }, null, 2) + '\n')
} catch (error) {
  evidence.outcome = 'failed'; evidence.failure = String(error)
  await writeFile(join(output, 'api-proof.json'), JSON.stringify(evidence, null, 2) + '\n')
  throw error
} finally {
  await client.close().catch(() => {})
  await Promise.all(servers.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
}
