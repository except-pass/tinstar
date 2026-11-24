import { open, readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { getConfigRoot } from '../src/server/configRoot'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { ReconciliationSources } from '../src/server/reconciliation'
import { notionLinkTransport, runWorkerLinkAdapter } from '../src/coordinator/workerLinkAdapter'
import { runTswStatusSync } from '../src/coordinator/tswStatusSync'
import { tswKey, tswProjectId } from '../src/server/reconciliation/tswSnapshot'
import { notionPageId } from '../src/server/reconciliation/notion'

async function main() {
  const { values } = parseArgs({ options: {
    'config-home': { type: 'string' }, 'write-token-file': { type: 'string' }, 'audit-file': { type: 'string' },
    apply: { type: 'boolean', default: false }, 'max-cards': { type: 'string' }, card: { type: 'string', multiple: true }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log([
      'Usage with Notion: npm run --silent worker-links:adapter -- --audit-file FILE [--config-home DIR] [--card ID ...] [--apply --max-cards 1..5 --write-token-file FILE]',
      'Usage for TSW only: npm run --silent worker-links:adapter -- --audit-file FILE [--config-home DIR] --card TSW-n [--card TSW-n ...] [--apply --max-cards 1..5]',
      'Defaults to report-only. Jira writes require --apply and an explicit TSW --card and use the configured Jira work service account. Keep the audit file and its adjacent TSW checkpoint across runs.',
    ].join('\n'))
    return
  }
  const maxCards = values['max-cards'] === undefined ? undefined : Number(values['max-cards'])
  const auditFile = values['audit-file']
  if (!auditFile || values.apply && (!Number.isInteger(maxCards) || maxCards! < 1 || maxCards! > 5)) {
    throw new Error('Audit path and explicit apply bounds required')
  }
  if (values.card?.some(key => !tswKey(key) && !notionPageId(key))) throw new Error('Invalid --card id')
  const notionCards = values.card?.filter(card => !tswKey(card))
  const tswCards = values.card?.filter(card => !!tswKey(card))
  if (values.apply && notionCards?.length && tswCards?.length) {
    console.error('--apply cannot mix Notion page IDs and TSW keys in --card. Run each board separately.')
    process.exitCode = 1
    return
  }
  const root = values['config-home'] ?? getConfigRoot()
  const config = loadReconciliationConfig(root)
  const runNotion = !notionCards || notionCards.length > 0
  const runTsw = !tswCards || tswCards.length > 0
  const sources = new ReconciliationSources(config, fetch, undefined, root)
  if (values.apply && runNotion && (!config.notion || !values['write-token-file'])) throw new Error('Notion write-token file and board required')
  const file = await open(auditFile, 'a', 0o600)
  try {
    await file.chmod(0o600)
    const audit = async (entry: unknown) => { await file.writeFile(`${JSON.stringify(entry)}\n`); await file.sync() }
    const input = runNotion ? await sources.workerLinkSnapshot(runTsw) : null
    const transport = runNotion && values.apply && config.notion
      ? notionLinkTransport((await readFile(values['write-token-file']!, 'utf8')).trim(), config.notion.dataSourceId) : undefined
    const result = input ? await runWorkerLinkAdapter(input, { apply: values.apply, maxCards, cards: notionCards, transport, audit }) : null
    const tsw = runTsw ? await runTswStatusSync(input?.fleet ?? await sources.fleetSnapshot(), {
      jira: config.jiraWork?.projectId === tswProjectId ? sources.jiraWork : undefined,
      apply: values.apply && !!tswCards?.length, maxCards, cards: tswCards, audit, stateFile: `${auditFile}.tsw-state.json`,
    }) : undefined
    console.log(JSON.stringify({ ...result, ...(!result ? { mode: values.apply ? 'apply' : 'report-only' } : {}),
      stopped: !!(result?.stopped || tsw?.stopped), ...(tsw && { tsw: tsw.audits.map(({ cardId, result }) => ({ cardId, result })) }) }, null, 2))
    if (result?.stopped || tsw?.stopped) process.exitCode = 1
  } finally { await file.close() }
}

main().catch(() => { console.error('Worker-link adapter failed; check arguments, audit path, source coverage and credential access.'); process.exitCode = 1 })
