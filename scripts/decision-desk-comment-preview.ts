/** Isolated sample-comment proof. Build the client first, then run:
 * node --import tsx scripts/decision-desk-comment-preview.ts /absolute/proof-dir
 * Real source readers use stub Notion and task-owned storage only. No webhook,
 * live board, live config, or MCP listener. The HTTP port is chosen by the OS. */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { commentPacketHistoryFixture } from '../test-fixtures/reconciliation/commentPacketHistory'
import { DecisionDeskApi } from '../src/server/reconciliation/decisionDeskApi'
import { seedOriginAllowlist } from '../src/server/api/originAllowlist'
import { buildQueue } from '../src/server/reconciliation/queue'

const output = resolve(process.argv[2] ?? '')
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
if (!process.argv[2] || output === repo || output.startsWith(`${repo}/`)) throw new Error('External proof directory required')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'isolated-comments-'))
process.env.TINSTAR_CONFIG_HOME = root
const fixture = await commentPacketHistoryFixture(root)
const { sources } = fixture
await writeFile(join(root, 'config.json'), JSON.stringify({ reconciliation: fixture.config, ask: { ownerLogins: ['preview-owner@example.test'], bridgeToken: 'fixture-only-no-live-bridge-token' } }))
const api = new DecisionDeskApi(sources.decisionPackets, 'f'.repeat(32), id => sources.preparationEvidence(id), async () => true, sources.preparedReviews, undefined, sources.preparedSubmissions, sources.preparation)
const clientDir = resolve('dist/client')
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://preview').pathname
    if (path.startsWith('/api/reconciliation/decision-desk/')) {
      req.headers['tailscale-user-login'] = 'preview-owner@example.test'
      if (await api.handle(req, res)) return
    }
    let data: unknown
    if (path === '/__preview/evidence') data = { snapshot: await sources.preparedReviews.snapshot(), packet_ids: await sources.decisionPackets.ids(), reads: fixture.reads, lease: sources.leases.status(fixture.cardId) }
    else if (path === '/api/reconciliation/scene') data = await sources.scene()
    else if (path === '/api/reconciliation/queue') data = { ...buildQueue(await sources.snapshot()), needsWill: [] }
    else if (path === '/api/fleet') data = { ready: true, workers: [], attention: [], messages: [], errors: [] }
    else if (path === '/api/ask/requests') data = []
    else if (path.startsWith('/api/')) { res.writeHead(404); res.end(); return }
    if (data !== undefined) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); return }
    const file = path.startsWith('/assets/') ? resolve(clientDir, `.${path}`) : join(clientDir, 'index.html')
    if (!file.startsWith(`${clientDir}/`)) { res.writeHead(403); res.end(); return }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream')
    const stream = createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res)
  } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)) }
})
await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const port = (server.address() as { port: number }).port
seedOriginAllowlist(port)
const manifest = { url: `http://127.0.0.1:${port}/?view=decisions`, config_root: root, card_id: fixture.cardId, request_id: fixture.requestId, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), source: 'Stub Notion card with sample prepared-packet comment; no publish tool invoked' }
await writeFile(join(output, 'comment-preview.json'), JSON.stringify(manifest, null, 2))
process.stdout.write(JSON.stringify(manifest) + '\n')
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
process.on('SIGINT', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
