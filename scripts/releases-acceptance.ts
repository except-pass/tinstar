import { parseArgs } from 'node:util'
import { ReconciliationSources } from '../src/server/reconciliation'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { getConfigRoot } from '../src/server/configRoot'
import { ReleasesApi } from '../src/server/releases/routes'
import { ReleaseAcceptanceRunner } from '../src/server/releases/acceptance'
import type { AcceptanceOutcome } from '../src/shared/releaseAcceptance'

const { values } = parseArgs({ options: {
  'config-root': { type: 'string' }, execute: { type: 'boolean', default: false }, actor: { type: 'string' },
  key: { type: 'string' }, action: { type: 'string' }, reason: { type: 'string' }, evidence: { type: 'string' },
  outcome: { type: 'string' }, 'run-id': { type: 'string' },
} })
if (values.action && !['retry', 'manual', 'skip', 'attach'].includes(values.action)) throw new Error('Use retry, manual, skip or attach')
const root = values['config-root'] ?? getConfigRoot()
const readOnlyFetch: typeof fetch = (input, init) => {
  const method = init?.method ?? 'GET'
  if (method !== 'GET' && !(method === 'POST' && String(input).endsWith('/query'))) throw new Error('Acceptance transport forbids Notion writes')
  return fetch(input, init)
}
const sources = new ReconciliationSources(loadReconciliationConfig(root), readOnlyFetch, undefined, root)
const api = new ReleasesApi(sources, root)
const runner = new ReleaseAcceptanceRunner(root, async () => ({ data: await api.read(false, true), scene: await sources.scene(false, { history: true }) }))
if (!values.execute) console.log(JSON.stringify(await runner.plan(), null, 2))
else {
  if (!values.actor) throw new Error('--execute requires --actor')
  console.log(JSON.stringify(await runner.perform({ actor: values.actor, key: values.key,
    action: values.action as 'retry' | 'manual' | 'skip' | 'attach' | undefined, reason: values.reason,
    evidence: values.evidence, outcome: values.outcome as AcceptanceOutcome | undefined, runId: values['run-id'] ? Number(values['run-id']) : undefined }), null, 2))
}
