import { parseArgs } from 'node:util'
import { ReconciliationSources } from '../src/server/reconciliation'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { getConfigRoot } from '../src/server/configRoot'
import { ReleasesApi } from '../src/server/releases/routes'
import { ReleaseNotesPublisher } from '../src/server/releases/notes'

const { values } = parseArgs({ options: {
  'config-root': { type: 'string' }, 'release-id': { type: 'string' }, audience: { type: 'string', default: 'customer' },
  execute: { type: 'boolean', default: false }, actor: { type: 'string' }, reason: { type: 'string' },
} })
if (!values['release-id'] || !['internal', 'customer'].includes(values.audience)) throw new Error('Supply --release-id and --audience internal|customer')
const root = values['config-root'] ?? getConfigRoot()
const readOnlyFetch: typeof fetch = (input, init) => {
  const method = init?.method ?? 'GET'
  if (method !== 'GET' && !(method === 'POST' && String(input).endsWith('/query'))) throw new Error('Release notes transport forbids Notion writes')
  return fetch(input, init)
}
const sources = new ReconciliationSources(loadReconciliationConfig(root), readOnlyFetch, undefined, root)
const api = new ReleasesApi(sources, root)
const publisher = new ReleaseNotesPublisher(root, async () => ({ data: await api.read(false, true), scene: await sources.scene(false, { history: true }) }))
const audience = values.audience as 'internal' | 'customer'
console.log(JSON.stringify(values.execute
  ? await publisher.publish(values['release-id'], audience, values.actor ?? '', values.reason ?? '')
  : await publisher.plan(values['release-id'], audience), null, 2))
