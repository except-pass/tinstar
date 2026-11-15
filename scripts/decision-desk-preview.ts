/** Isolated P1 storage/API and unchanged-UI proof harness. Explicit fixtures,
 * never a production service or preparer. Build client first, then:
 * node --import tsx scripts/decision-desk-preview.ts /absolute/task-proof-dir
 * Creates its own fresh config root, enrolls no home, uses no live credentials.
 * SIGTERM stops this preview only. Browser proof must use the task's AXI session. */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'
import { CardLeases } from '../src/server/reconciliation/cardLeases'
import { DecisionPackets } from '../src/server/reconciliation/decisionPackets'
import { DecisionDeskApi } from '../src/server/reconciliation/decisionDeskApi'
import { ReconciliationMcp } from '../src/server/reconciliation/mcp'
import { PullsApi } from '../src/server/pulls/routes'
import { AssociationStore } from '../src/server/releases/associations'
import { SceneReconciler } from '../src/server/reconciliation/scene'
import { buildQueue } from '../src/server/reconciliation/queue'
import { needsWill } from '../src/server/reconciliation/needsWill'
import { seedOriginAllowlist } from '../src/server/api/originAllowlist'
import { preparedDecisionFixture } from '../test-fixtures/reconciliation/preparedDecision'
import { boundSearchDocuments, sceneSearchDocuments } from '../src/shared/searchDocuments'

if (!process.argv[2]) throw new Error('Provide a task proof directory')
const output = resolve(process.argv[2]); await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'isolated-preview-'))
process.env.TINSTAR_CONFIG_HOME = root
await writeFile(join(root, 'config.json'), JSON.stringify({ ask: { ownerLogins: ['preview-owner@example.test'], bridgeToken: 'synthetic-preview-only-not-live-12345678' }, reconciliation: { fleet: [] } }), { mode: 0o600 })
const packets = new DecisionPackets(new CardLeases(root))
const fixture = () => preparedDecisionFixture()
const readScene = async () => {
  const scene = new SceneReconciler().reconcile(fixture().snapshot)
  return { ...scene, searchIndex: boundSearchDocuments(sceneSearchDocuments(scene)) }
}
const auth = new PullsApi({ scene: readScene }, new AssociationStore(root), root)
const initial = fixture()
const published = await packets.publish(initial.packet, initial.evidence, 'isolated-preview-fixture', 'initial-fixture')
const api = new DecisionDeskApi(packets, 'isolated-fixture-board', () => fixture().evidence, req => auth.authorized(req))
const queue = async () => {
  const f = fixture(), scene = new SceneReconciler().reconcile(f.snapshot), result = buildQueue(f.snapshot)
  result.needsWill = needsWill(result, scene, new Map([[f.cardId, f.history.context]]), null, new Map(), false)
  return result
}
const mcp = new ReconciliationMcp({ scene: readScene, card: async () => fixture().history.context, queue, workerLinkReport: async () => ({ outcome: 'unavailable', reason: 'No live worker scope in this isolated fixture' }) }, root)
const clientDir = resolve('dist/client')
const server = createServer(async (req, res) => {
  try {
    if (await api.handle(req, res) || await mcp.handle(req, res)) return
    const path = new URL(req.url ?? '/', 'http://preview').pathname
    let data: unknown
    if (req.method === 'GET' && path === '/api/reconciliation/scene') data = await readScene()
    else if (req.method === 'GET' && path === '/api/reconciliation/queue') data = await queue()
    else if (req.method === 'GET' && path === '/api/reconciliation/card-context') data = fixture().history.context
    else if (req.method === 'GET' && path === '/api/fleet') data = { ready: true, workers: [], attention: [], messages: [], errors: [] }
    else if (req.method === 'GET' && path === '/api/ask/requests') data = []
    else if (path.startsWith('/api/')) { res.writeHead(404); res.end('Unsupported in isolated preview'); return }
    if (data !== undefined) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); return }
    const file = path.startsWith('/assets/') ? resolve(clientDir, `.${path}`) : join(clientDir, 'index.html')
    if (!file.startsWith(`${clientDir}/`)) { res.writeHead(403); res.end(); return }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream')
    const stream = createReadStream(file); stream.on('error', () => { res.destroy() }); stream.pipe(res)
  } catch { if (!res.headersSent) res.writeHead(500); res.end('Isolated preview error') }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
seedOriginAllowlist(port)
const manifest = { url: `http://127.0.0.1:${port}`, config_root: root, packet_id: published.id, card_id: initial.cardId, fixtures: true, source_writes: 'No live source transport or worker dispatch is enrolled', baseline: 'Current Decisions UI, P1 makes no screen changes' }
await writeFile(join(output, 'p1-preview.json'), JSON.stringify(manifest, null, 2) + '\n')
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
