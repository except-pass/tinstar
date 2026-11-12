/** Focused local proof server: production workflow handlers + built client.
 * No dispatcher, terminal lifecycle, telemetry receiver, or background writer. */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve, extname, join, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { ReconciliationSources, handleReconciliationRequest } from '../src/server/reconciliation'
import { ReconciliationMcp } from '../src/server/reconciliation/mcp'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { getConfigRoot } from '../src/server/configRoot'
import { seedOriginAllowlist } from '../src/server/api/originAllowlist'
import { CockpitFleet, handleCockpitRequest } from '../src/server/fleet/cockpit'

async function main() {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '5293' } } })
  const port = Number(values.port), root = getConfigRoot(), config = loadReconciliationConfig(root)
  if (![5293, 5294, 5295, 5296].includes(port) || !config.jira || config.notion) throw new Error('Use an isolated Jira-only config and authorized preview port 5293–5296')
  if (config.fleet.some(source => source.home !== join(root, 'jira-synthetic-home') || source.snapshotFile !== join(root, 'jira-synthetic-fleet.json'))) throw new Error('Only the prepared synthetic fleet snapshot is allowed in this proof server')
  const sources = new ReconciliationSources(config), mcp = new ReconciliationMcp(sources, root), fleet = new CockpitFleet()
  const client = resolve('dist/client')
  await stat(join(client, 'index.html'))
  seedOriginAllowlist(port)
  const server = createServer((req, res) => { void (async () => {
    if (req.method === 'GET' && req.url === '/api/fleet' && await handleCockpitRequest(fleet, req, res)) return
    if (await mcp.handle(req, res)) return
    if (await handleReconciliationRequest(sources, req, res)) return
    if (req.url?.startsWith('/api/')) { res.writeHead(404); res.end(); return }
    const path = resolve(client, '.' + new URL(req.url ?? '/', 'http://localhost').pathname)
    if (path !== client && !path.startsWith(client + sep)) { res.writeHead(404); res.end(); return }
    const file = extname(path) ? path : join(client, 'index.html')
    try { if (!(await stat(file)).isFile()) throw new Error('Not a file') }
    catch { res.writeHead(404); res.end(); return }
    const mime = ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime }); createReadStream(file).pipe(res)
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end('Preview request failed') }) })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done) })
  console.log(`Synthetic Jira proof preview: http://127.0.0.1:${port}`)
  process.once('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
  process.once('SIGINT', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
}
main().catch(() => { console.error('Jira proof preview could not start; check isolated config, build and preview port'); process.exitCode = 1 })
