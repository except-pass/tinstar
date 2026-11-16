/** Isolated Decision Desk preparation preview. Build the client first
 * (`npm run build:all` or `vite build --outDir dist/client`).
 * node --import tsx scripts/decision-desk-prep-preview.ts /absolute/proof-directory
 *
 * Binds only 127.0.0.1:5293 (UI), :5294 (stub webhook) and :5295 (MCP).
 * Uses a fresh config copy and a disposable sender value that is never written
 * to disk. Does not call a live webhook or the floor. */
import { createServer, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { extname, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { preparedDecisionFixture } from '../test-fixtures/reconciliation/preparedDecision'
import { DecisionDeskApi } from '../src/server/reconciliation/decisionDeskApi'
import { DecisionPackets } from '../src/server/reconciliation/decisionPackets'
import { DecisionPreparation, prepSecretName, type PrepCandidate } from '../src/server/reconciliation/decisionPrep'
import { PreparedReviews } from '../src/server/reconciliation/preparedReviews'
import { PreparedSubmissions, type PreparedAnswerSource } from '../src/server/reconciliation/preparedSubmissions'
import { CardLeases } from '../src/server/reconciliation/cardLeases'
import { ReconciliationMcp } from '../src/server/reconciliation/mcp'
import { SceneReconciler } from '../src/server/reconciliation/scene'
import { buildQueue } from '../src/server/reconciliation/queue'
import { needsWill } from '../src/server/reconciliation/needsWill'
import { seedOriginAllowlist } from '../src/server/api/originAllowlist'
import { boundSearchDocuments, sceneSearchDocuments } from '../src/shared/searchDocuments'
import type { DecisionEvidence } from '../src/shared/decisionPacket'

const uiPort = 5293, stubPort = 5294, mcpPort = 5295
const output = resolve(process.argv[2] ?? '')
if (!output) throw new Error('Proof directory required')
const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
if (output === toplevel || output.startsWith(`${toplevel}/`)) throw new Error('Proof directory must stay outside the worktree')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'isolated-prep-'))
process.env.TINSTAR_CONFIG_HOME = root
await writeFile(join(root, 'config.json'), JSON.stringify({
  ask: { ownerLogins: ['preview-owner@example.test'], bridgeToken: 'isolated-p4-preview-not-live-bridge-token' },
  reconciliation: { fleet: [] },
}), { mode: 0o600 })

const now = Date.now()
const fixture = preparedDecisionFixture(now)
const failureId = 'b'.repeat(32)
const failureRequest = 'failure-question'
function extend(value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'expiresAt' || key === 'expires_at') && typeof item === 'string') (value as Record<string, unknown>)[key] = new Date(now + 7_200_000).toISOString()
    else extend(item)
  }
}
extend(fixture.evidence)
const failureEvidence: DecisionEvidence = structuredClone(fixture.evidence)
failureEvidence.card_id = failureId
failureEvidence.requests = failureEvidence.requests.map(request => ({
  ...request,
  question: 'Record a failed preparation attempt?',
  binding: request.binding ? { ...request.binding, card_id: failureId, request_id: failureRequest } : null,
}))
if (fixture.evidence.reasons.length || fixture.evidence.requests.some(request => request.answered || request.reasons.length || !request.binding)) throw new Error('Success fixture is not a queued request')
const successRequest = fixture.packet.binding.request_id
const candidates: PrepCandidate[] = [
  { card_id: fixture.cardId, request_id: successRequest, source_revision: fixture.packet.binding.source_revision, card_url: `https://www.notion.so/${fixture.cardId}`, card_status: 'Waiting For', answered: false, leased: false, reasons: [], rank: 0 },
  { card_id: failureId, request_id: failureRequest, source_revision: failureEvidence.requests[0]!.binding!.source_revision, card_url: `https://www.notion.so/${failureId}`, card_status: 'Waiting For', answered: false, leased: false, reasons: [], rank: 1 },
]
const evidenceFor = (card: string) => card === failureId ? failureEvidence : fixture.evidence
const senderKey = 'isolated-p4-preview-sender'
let mode: 'off' | 'running' = 'off'
let clock = now
const posts: Array<{ request_id: string; card_url: string; tool: string; job_id: string; authorized: boolean; status: number }> = []
const stub = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(Buffer.from(chunk)))
  req.on('end', () => {
    let body: { request_id?: string; card_url?: string; publish?: { tool?: string; job_id?: string } } = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { body = {} }
    const status = body.request_id === failureRequest ? 500 : 202
    posts.push({ request_id: String(body.request_id ?? ''), card_url: String(body.card_url ?? ''), tool: String(body.publish?.tool ?? ''), job_id: String(body.publish?.job_id ?? ''), authorized: req.headers.authorization === `Bearer ${senderKey}`, status })
    res.writeHead(status); res.end(status === 202 ? 'accepted' : 'stub failure')
  })
})
const leases = new CardLeases(root)
const packets = new DecisionPackets(leases)
const preparation = new DecisionPreparation(packets, 'isolated-prep-board', { candidates: () => candidates, coverage: () => 'complete' }, evidenceFor, async name => {
  if (mode !== 'running' || name !== prepSecretName) return null
  return JSON.stringify({ url: `http://127.0.0.1:${stubPort}/job`, key: senderKey })
}, () => clock)
const reviews = new PreparedReviews(packets, 'isolated-prep-board', evidenceFor, () => ({ card_ids: [fixture.cardId, failureId], coverage: 'complete', requests: 2 }))
reviews.reportPreparation = () => preparation.status()
const source: PreparedAnswerSource = {
  observe: async () => { throw new Error('Isolated preview does not write source answers') },
  evidence: async () => { throw new Error('Isolated preview does not write source answers') },
  write: async () => { throw new Error('Isolated preview does not write source answers') },
}
const submissions = new PreparedSubmissions(reviews, source)
const api = new DecisionDeskApi(packets, 'isolated-prep-board', evidenceFor, async () => true, reviews, undefined, submissions, preparation)
const mcp = new ReconciliationMcp({
  leases, preparation,
  scene: async () => { throw new Error('publish must not read a scene') },
  card: async () => { throw new Error('publish must not read a card') },
  queue: async () => { throw new Error('publish must not read the queue') },
  workerLinkReport: async () => { throw new Error('unused') },
}, root)
const scene = () => {
  const value = new SceneReconciler().reconcile(fixture.snapshot)
  return { ...value, searchIndex: boundSearchDocuments(sceneSearchDocuments(value)) }
}
const clientDir = resolve('dist/client')
function send(res: ServerResponse, data: unknown) {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}
async function publishViaTool() {
  const job = posts.find(post => post.request_id === successRequest && post.status === 202)
  if (!job?.job_id) throw new Error('Stub has not accepted the success job')
  const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
  const client = new Client({ name: 'isolated-prep-preview', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  try {
    const raw = await client.callTool({ name: 'publish_prepared_packet', arguments: { job_id: job.job_id, operation_id: 'preview-valid-packet', packet: fixture.packet } })
    const parsed = JSON.parse((raw as { content: Array<{ text: string }> }).content[0]!.text) as { outcome?: string; ready?: boolean; packet_id?: string; replayed?: boolean }
    const lease = leases.status(fixture.cardId)
    const record = { outcome: parsed.outcome ?? null, ready: parsed.ready ?? false, packet_id: parsed.packet_id ?? null, replayed: parsed.replayed ?? false, job_id: job.job_id, lease: lease ? 'held' : null }
    await writeFile(join(output, 'publish-result.json'), JSON.stringify(record, null, 2))
    return record
  } finally { await client.close() }
}
const ui = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://preview').pathname
    if (path === '/__preview/mode' && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { name?: string }
      if (body.name !== 'off' && body.name !== 'running') throw new Error('Unknown mode')
      mode = body.name
      clock += 31_000
      send(res, { mode }); return
    }
    if (path === '/__preview/state' && req.method === 'GET') { send(res, { mode, posts, automatic_replenishment: (await packets.readPolicy('isolated-prep-board')).values.automatic_replenishment }); return }
    if (path === '/__preview/publish' && req.method === 'POST') { send(res, await publishViaTool()); return }
    if (path.startsWith('/api/reconciliation/decision-desk/')) {
      req.headers['tailscale-user-login'] = 'preview-owner@example.test'
      if (await api.handle(req, res)) return
    }
    let data: unknown
    if (req.method === 'GET' && path === '/api/reconciliation/scene') data = scene()
    else if (req.method === 'GET' && path === '/api/reconciliation/queue') {
      const queue = buildQueue(fixture.snapshot)
      queue.needsWill = needsWill(queue, scene(), new Map([[fixture.cardId, fixture.history.context]]), null, new Map(), false)
      data = queue
    } else if (req.method === 'GET' && path === '/api/reconciliation/card-context') data = fixture.history.context
    else if (req.method === 'GET' && path === '/api/fleet') data = { ready: true, workers: [], attention: [], messages: [], errors: [] }
    else if (req.method === 'GET' && path === '/api/ask/requests') data = []
    else if (path.startsWith('/api/')) { res.writeHead(404); res.end('Unsupported in isolated preparation preview'); return }
    if (data !== undefined) { send(res, { ok: true, data }); return }
    const file = path.startsWith('/assets/') ? resolve(clientDir, `.${path}`) : join(clientDir, 'index.html')
    if (!file.startsWith(`${clientDir}/`)) { res.writeHead(403); res.end(); return }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream')
    const stream = createReadStream(file); stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end() }); stream.pipe(res)
  } catch (error) {
    if (!res.headersSent) res.writeHead(500)
    res.end(error instanceof Error ? error.message : 'Isolated preparation preview error')
  }
})
const mcpServer = createServer((req, res) => { void mcp.handle(req, res).then(handled => { if (!handled && !res.headersSent) { res.writeHead(404); res.end() } }) })
function listen(server: ReturnType<typeof createServer>, port: number) {
  return new Promise<void>((resolveListen, reject) => {
    const fail = (error: Error) => reject(error)
    server.once('error', fail)
    server.listen(port, '127.0.0.1', () => { server.off('error', fail); resolveListen() })
  })
}
await listen(stub, stubPort)
await listen(mcpServer, mcpPort)
await listen(ui, uiPort)
seedOriginAllowlist(uiPort)
const manifest = {
  url: `http://127.0.0.1:${uiPort}/?view=decisions`,
  stub: `http://127.0.0.1:${stubPort}/job`,
  mcp: `http://127.0.0.1:${mcpPort}/api/reconciliation/mcp`,
  config_root: root,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  mode: 'off',
  ports: [uiPort, stubPort, mcpPort],
}
await writeFile(join(output, 'prep-preview.json'), JSON.stringify(manifest, null, 2))
process.stdout.write(`${JSON.stringify(manifest)}\n`)
function shutdown() {
  stub.closeAllConnections(); mcpServer.closeAllConnections(); ui.closeAllConnections()
  stub.close(); mcpServer.close(); ui.close(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
