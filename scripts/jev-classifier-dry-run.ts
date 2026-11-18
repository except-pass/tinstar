import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { getConfigRoot } from '../src/server/configRoot'
import { taxonomyNotes } from '../src/server/classification/catalog'
import { dryRunReport } from '../src/server/classification/report'
import { ClassificationService } from '../src/server/classification/service'
import { JevError } from '../src/server/classification/openRouter'
import { CardLeases } from '../src/server/reconciliation/cardLeases'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { NotionApi } from '../src/server/reconciliation/notionApi'

async function main() {
  const { values } = parseArgs({ options: {
    'config-home': { type: 'string' },
    'ledger-home': { type: 'string' },
    'historical-limit': { type: 'string', default: '2000' },
    'taxonomy-notes': { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('Usage: npx tsx scripts/jev-classifier-dry-run.ts [--config-home DIR] [--ledger-home DIR] [--historical-limit N] [--taxonomy-notes FILE] [--output FILE]\nReads the live Notion board and replays historical labels through OpenRouter. Writes only the local ledger and optional Markdown report.')
    return
  }
  const historicalLimit = Number(values['historical-limit'])
  if (!Number.isInteger(historicalLimit) || historicalLimit < 0 || historicalLimit > 2000) {
    console.error('--historical-limit must be an integer from 0 to 2000')
    process.exitCode = 1
    return
  }
  const configHome = values['config-home'] ?? getConfigRoot()
  const { notion } = loadReconciliationConfig(configHome)
  if (!notion) { console.error('The configured Tin Star board has no Notion credentials'); process.exitCode = 1; return }
  const notes = values['taxonomy-notes'] ? taxonomyNotes.parse(JSON.parse(await readFile(values['taxonomy-notes'], 'utf8'))) : {}
  const api = new NotionApi()
  const service = new ClassificationService(notion, api, new CardLeases(values['ledger-home'] ?? configHome), undefined, notes)
  const result = await service.dryRun(historicalLimit, (done, total) => {
    if (done === total || done % 10 === 0) console.error(`Examined ${done}/${total} cards`)
  })
  const report = dryRunReport(result, api.diagnostics)
  if (values.output) await writeFile(values.output, report, { mode: 0o600 })
  else process.stdout.write(report)
  if (result.rows.some(row => row.result.state === 'failed')) process.exitCode = 1
}

main().catch(error => {
  // Diagnostics from Clavis, provider responses and configuration may contain secrets.
  console.error(error instanceof JevError ? error.message : 'Jev dry run failed. Check local input files and Notion board coverage.')
  process.exitCode = 1
})
