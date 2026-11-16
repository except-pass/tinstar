/** Isolated 64-card history/claim proof. All Notion and webhook traffic is local.
 * Build client first, then run with an absolute output directory outside repo.
 * Ports: UI 5293, webhook 5294, Notion stub 5295, MCP 5296. */
import { createServer, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { preparationHistoryFixture } from '../test-fixtures/reconciliation/preparationHistory'
import { DecisionDeskApi } from '../src/server/reconciliation/decisionDeskApi'
import { ReconciliationMcp } from '../src/server/reconciliation/mcp'
import { seedOriginAllowlist } from '../src/server/api/originAllowlist'

const output = resolve(process.argv[2] ?? '')
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
if (!process.argv[2] || output === repo || output.startsWith(`${repo}/`)) throw new Error('External proof directory required')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'isolated-history-'))
process.env.TINSTAR_CONFIG_HOME = root
let released = false, release!: () => void
const gate = new Promise<void>(resolveGate => { release = resolveGate })
let syntheticNotion!: typeof fetch
const posts: unknown[] = []
const webhook = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (req.headers.authorization !== 'Bearer preview-only-sender') { res.writeHead(403); res.end(); return }
  posts.push(JSON.parse(Buffer.concat(chunks).toString()))
  res.writeHead(202); res.end()
})
const notion = createServer(async (req, res) => {
  try {
    const path = req.url ?? '/'
    if (path.includes('/blocks/') || path.startsWith('/v1/comments')) await gate
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const response = await syntheticNotion(`https://api.notion.com${path}`, { method: req.method, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) })
    res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text())
  } catch { res.writeHead(500); res.end('Synthetic Notion failure') }
})
const listen = (server: ReturnType<typeof createServer>, port: number) => new Promise<void>((resolveListen, reject) => {
  server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen)
})
await listen(webhook, 5294)
await listen(notion, 5295)
const secret = async () => JSON.stringify({ url: 'http://127.0.0.1:5294/job', key: 'preview-only-sender' })
const fixture = await preparationHistoryFixture(root, secret, { cards: 64, intervalMs: Number(process.env.PREVIEW_NOTION_INTERVAL_MS ?? 350),
  wrapFetch: fixtureFetch => {
    syntheticNotion = fixtureFetch
    return (input, init) => { const url = new URL(String(input)); return fetch(`http://127.0.0.1:5295${url.pathname}${url.search}`, init) }
  },
})
const { sources } = fixture
await writeFile(join(root, 'config.json'), JSON.stringify({ reconciliation: fixture.config,
  ask: { ownerLogins: ['preview-owner@example.test'], bridgeToken: 'preview-only-bridge-token' } }), { mode: 0o600 })
const api = new DecisionDeskApi(sources.decisionPackets, 'f'.repeat(32), id => sources.preparationEvidence(id), async () => true,
  sources.preparedReviews, undefined, sources.preparedSubmissions, sources.preparation)
const mcp = new ReconciliationMcp(sources, root)
const mcpServer = createServer((req, res) => { void mcp.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }) })
await listen(mcpServer, 5296)
const clientDir = resolve('dist/client')
const send = (res: ServerResponse, data: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
const measurements: unknown[] = []
async function claimProof() {
  const client = new Client({ name: 'history-claim-proof', version: '1' })
  const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:5296/api/reconciliation/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  try {
    const started = performance.now()
    const raw = await client.callTool({ name: 'claim_next_card', arguments: { operation_id: `history-claim-${Date.now()}` } })
    const value = JSON.parse((raw.content as Array<{ text: string }>)[0]!.text)
    const record = { operation: 'claim_next_card', elapsed_ms: performance.now() - started, outcome: value.outcome, card_id: value.lease?.card_id, readiness: value.readiness }
    measurements.push(record)
    await writeFile(join(output, 'timings.json'), JSON.stringify(measurements, null, 2))
    return record
  } finally { await client.close() }
}
const ui = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://preview').pathname
    if (path === '/__preview/release' && req.method === 'POST') { released = true; release(); send(res, { released }); return }
    if (path === '/__preview/claim' && req.method === 'POST') { send(res, await claimProof()); return }
    if (path === '/__preview/state') { send(res, { released, posts, reads: fixture.reads, measurements }); return }
    if (path.startsWith('/api/reconciliation/decision-desk/')) {
      req.headers['tailscale-user-login'] = 'preview-owner@example.test'
      const started = performance.now()
      if (await api.handle(req, res)) {
        if (path.endsWith('/snapshot')) {
          measurements.push({ operation: 'snapshot', released, elapsed_ms: performance.now() - started })
          await writeFile(join(output, 'timings.json'), JSON.stringify(measurements, null, 2))
        }
        return
      }
    }
    let data: unknown
    if (path === '/api/reconciliation/scene') data = await sources.scene()
    else if (path === '/api/reconciliation/queue') data = { ...await import('../src/server/reconciliation/queue').then(({ buildQueue }) => sources.snapshot().then(snapshot => buildQueue(snapshot))), needsWill: [] }
    else if (path === '/api/fleet') data = { ready: true, workers: [], attention: [], messages: [], errors: [] }
    else if (path === '/api/ask/requests') data = []
    else if (path.startsWith('/api/')) { res.writeHead(404); res.end(); return }
    if (data !== undefined) { send(res, { ok: true, data }); return }
    const file = path.startsWith('/assets/') ? resolve(clientDir, `.${path}`) : join(clientDir, 'index.html')
    if (!file.startsWith(`${clientDir}/`)) { res.writeHead(403); res.end(); return }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream')
    const stream = createReadStream(file); stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end() }); stream.pipe(res)
  } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(error instanceof Error ? error.message : 'Preview error') }
})
seedOriginAllowlist(5293)
await listen(ui, 5293)
const manifest = { url: 'http://127.0.0.1:5293/?view=decisions', config_root: root, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), ports: [5293, 5294, 5295, 5296], cards: 64, notion_interval_ms: Number(process.env.PREVIEW_NOTION_INTERVAL_MS ?? 350) }
await writeFile(join(output, 'preview.json'), JSON.stringify(manifest, null, 2))
process.stdout.write(`${JSON.stringify(manifest)}\n`)
function stop() {
  release()
  for (const server of [ui, mcpServer, notion, webhook]) { server.closeAllConnections(); server.close() }
  process.exit(0)
}
process.on('SIGTERM', stop); process.on('SIGINT', stop)
