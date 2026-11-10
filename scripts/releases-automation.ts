import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { ReconciliationSources } from '../src/server/reconciliation'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { getConfigRoot } from '../src/server/configRoot'
import { ReleasesApi } from '../src/server/releases/routes'
import { ReleaseAutomationWriter } from '../src/server/releases/writer'

const { values } = parseArgs({ options: {
  'config-root': { type: 'string' }, output: { type: 'string' },
  passes: { type: 'string', default: '1' },
  skip: { type: 'string' }, resume: { type: 'string' }, actor: { type: 'string' }, reason: { type: 'string' },
  'recover-receipts': { type: 'boolean', default: false },
} })
const root = values['config-root'] ?? getConfigRoot()
const config = loadReconciliationConfig(root)
// This command cannot write to Notion, even if automation is enabled. The only
// mutation option is an explicit audited disposition of a local retry receipt.
const readOnlyFetch: typeof fetch = (input, init) => {
  const method = init?.method ?? 'GET'
  if (method !== 'GET' && !(method === 'POST' && String(input).endsWith('/query'))) throw new Error('Dry-run transport forbids board writes')
  return fetch(input, init)
}
const sources = new ReconciliationSources(config, readOnlyFetch, undefined, root)
const api = new ReleasesApi(sources, root)
if (values['recover-receipts']) {
  if (values.skip || values.resume || !values.actor || !values.reason) throw new Error('--recover-receipts requires --actor and --reason, without skip/resume')
  const writer = new ReleaseAutomationWriter(root, sources.releaseTransport(), () => api.read())
  console.log(JSON.stringify(await writer.recoverReceipts(values.actor, values.reason), null, 2))
} else if (values.skip || values.resume) {
  if (values.skip && values.resume || !values.actor || !values.reason) throw new Error('Choose --skip or --resume and supply --actor and --reason')
  const writer = new ReleaseAutomationWriter(root, sources.releaseTransport(), () => api.read())
  console.log(JSON.stringify(await writer.disposition((values.skip ?? values.resume)!, values.skip ? 'skip' : 'resume', values.actor, values.reason), null, 2))
} else {
  const passes = Number(values.passes)
  if (!Number.isInteger(passes) || passes < 1) throw new Error('--passes must be a positive integer; each pass reads at most four uncached PRs and eight ancestry pairs')
  let result = await api.read()
  for (let pass = 1; pass < passes; pass++) {
    const pending = result.pulls.some(pull => pull.freshness === 'unknown' && !pull.readError || pull.exceptions.some(message => message.includes('Ancestry read pending')))
    if (!pending) break
    result = await api.read()
  }
  const output = JSON.stringify({ mode: 'dry-run', zeroWrites: true, result }, null, 2)
  if (values.output) await writeFile(values.output, output)
  else console.log(output)
}
