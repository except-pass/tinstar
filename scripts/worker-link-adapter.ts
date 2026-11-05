import { open, readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { getConfigRoot } from '../src/server/configRoot'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { ReconciliationSources } from '../src/server/reconciliation'
import { notionLinkTransport, runWorkerLinkAdapter } from '../src/coordinator/workerLinkAdapter'

async function main() {
  const { values } = parseArgs({ options: {
    'config-home': { type: 'string' }, 'write-token-file': { type: 'string' }, 'audit-file': { type: 'string' },
    apply: { type: 'boolean', default: false }, 'max-cards': { type: 'string' }, card: { type: 'string', multiple: true }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('Usage: npm run --silent worker-links:adapter -- --audit-file FILE [--config-home DIR] [--card ID ...] [--apply --max-cards 1..5 --write-token-file FILE]\nDefaults to report-only; configured read sources are shared with worker-links:report. Only --apply reads the write-token file. Run one coordinator invocation per board at a time. Never pass a token value or use an environment variable for it.')
    return
  }
  const maxCards = values['max-cards'] === undefined ? undefined : Number(values['max-cards'])
  if (!values['audit-file'] || values.apply && (!values['write-token-file'] || !Number.isInteger(maxCards) || maxCards! < 1 || maxCards! > 5)) {
    throw new Error('Audit path and explicit apply bounds required')
  }
  const config = loadReconciliationConfig(values['config-home'] ?? getConfigRoot())
  const file = await open(values['audit-file'], 'a', 0o600)
  try {
    const input = await new ReconciliationSources(config).snapshot()
    const transport = values.apply && config.notion
      ? notionLinkTransport((await readFile(values['write-token-file']!, 'utf8')).trim(), config.notion.dataSourceId) : undefined
    const result = await runWorkerLinkAdapter(input, { apply: values.apply, maxCards, cards: values.card, transport,
      audit: async entry => { await file.writeFile(`${JSON.stringify(entry)}\n`); await file.sync() } })
    console.log(JSON.stringify(result, null, 2))
    if (result.stopped) process.exitCode = 1
  } finally { await file.close() }
}

main().catch(() => { console.error('Worker-link adapter failed; check arguments, audit path, source coverage and credential access.'); process.exitCode = 1 })
