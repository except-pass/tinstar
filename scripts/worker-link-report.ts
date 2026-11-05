import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { getConfigRoot } from '../src/server/configRoot'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { ReconciliationSources } from '../src/server/reconciliation'

/** Read from a running server, or collect the configured read-only sources once. */
async function main() {
  const { values } = parseArgs({ options: {
    server: { type: 'string' }, 'config-home': { type: 'string' }, 'token-file': { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('Usage: npm run --silent worker-links:report -- [--config-home DIR] [--server URL] [--token-file FILE]\nWithout --server, reads configured homes and Notion directly. With --server, authenticates using the config home mcp-token (or --token-file). Prints report JSON; never writes links.')
    return
  }
  const root = values['config-home'] ?? getConfigRoot()
  let report: unknown
  if (values.server) {
    const token = (await readFile(values['token-file'] ?? join(root, 'mcp-token'), 'utf8')).trim()
    const response = await fetch(new URL('/api/reconciliation/worker-links/report', values.server), {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) throw new Error(`Report request failed (HTTP ${response.status})`)
    const envelope = await response.json() as { ok: boolean; data?: unknown }
    if (!envelope.ok || !envelope.data) throw new Error('Report response unavailable')
    report = envelope.data
  } else {
    if (values['token-file']) throw new Error('--token-file requires --server')
    report = await new ReconciliationSources(loadReconciliationConfig(root)).workerLinkReport()
  }
  console.log(JSON.stringify(report, null, 2))
}

main().catch(() => { console.error('Worker-link report failed; check arguments, source configuration and server authentication.'); process.exitCode = 1 })
