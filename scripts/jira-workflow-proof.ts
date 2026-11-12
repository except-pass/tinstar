/** Explicit operator-run synthetic proof. Never starts a worker or configures Jira. */
import { parseArgs } from 'node:util'
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { JiraAdapter } from '../src/server/reconciliation/jira'
import { digest } from '../src/server/reconciliation/implementationContract'

async function main() {
  const { values } = parseArgs({ options: { server: { type: 'string' }, 'config-home': { type: 'string' }, output: { type: 'string' },
    'operation-prefix': { type: 'string' }, prepare: { type: 'boolean' }, preflight: { type: 'boolean' }, help: { type: 'boolean' } } })
  if (values.help) {
    console.log('Usage: tsx scripts/jira-workflow-proof.ts --config-home DIR --prepare\nThen start an isolated Tin Star preview with that config and runtime Jira env credentials.\ntsx scripts/jira-workflow-proof.ts --config-home DIR --server http://127.0.0.1:5293 --output FILE --operation-prefix UNIQUE [--preflight]\n--preflight reads native project/status metadata only. The full run creates ONE synthetic Jira issue and exercises shared MCP/UI workflow paths. Never use a live config root.')
    return
  }
  if (!values['config-home']) throw new Error('Explicit isolated --config-home required')
  const root = resolve(values['config-home']), home = join(root, 'jira-synthetic-home'), snapshotFile = join(root, 'jira-synthetic-fleet.json')
  const prefix = values['operation-prefix'] ?? `synthetic-${Date.now()}`, task = 'synthetic-jira-proof', generation = 'synthetic-fixture-generation'
  if (prefix.length > 70 || !/^[\w-]+$/.test(prefix)) throw new Error('Use a stable operation prefix of at most 70 letters/digits/dashes')
  async function snapshot() {
    const at = new Date().toISOString()
    await writeFile(snapshotFile, JSON.stringify({ schema: 'fm-fleet-snapshot.v1', fm_home: home, generated: at,
      main_inventory: { valid: true }, backlog: { present: true, records: [] }, tasks: [{ id: task, kind: 'crewmate', spawn_gen: generation,
        title: 'SYNTHETIC Jira proof: no real worker', current_state: { state: 'working', source: 'pane', observed_at: at, freshness: 'fresh' },
        endpoint: { exists: true, agent_alive: true, status: 'alive', observed_at: at, freshness: 'fresh' }, paths: {} }] }), { mode: 0o600 })
  }
  if (values.prepare) {
    const configFile = join(root, 'config.json')
    let exists = false
    try { await access(configFile); exists = true } catch { /* New isolated root. */ }
    if (exists) throw new Error('Prepare requires a new config root; existing configuration was preserved')
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeFile(configFile, JSON.stringify({ reconciliation: { fleet: [{ home, snapshotFile, label: 'Synthetic Jira proof (no worker)' }],
      jira: { url: 'https://fortresspower-jira.atlassian.net', projectId: '10638' } } }, null, 2), { mode: 0o600, flag: 'wx' })
    await snapshot()
    console.log(JSON.stringify({ prepared: root, synthetic_home: home, next: 'Start a preview on 5293–5296 with this TINSTAR_CONFIG_HOME and runtime TINSTAR_JIRA_EMAIL/TINSTAR_JIRA_TOKEN. No Jira requests or worker dispatch performed.' }))
    return
  }
  const config = loadReconciliationConfig(root)
  if (!config.jira || config.notion || config.fleet.length !== 1 || config.fleet[0]?.home !== home || config.fleet[0].snapshotFile !== snapshotFile) throw new Error('Proof requires its prepared isolated Jira-only config and synthetic snapshot')
  const adapter = new JiraAdapter(config.jira)
  const project = await adapter.project(), statuses = await adapter.statuses()
  const required = ['Queued', 'Waiting For', 'Todo', 'In review', 'In Progress', 'Done']
  const missing = required.filter(name => !statuses.some(status => status.name === name))
  if (missing.length) throw new Error(`Native TSSPIKE Task statuses missing: ${missing.join(', ')}. No Jira writes submitted.`)
  if (values.preflight) { console.log(JSON.stringify({ project: { id: project.id, key: project.key }, statuses, writes: 0 }, null, 2)); return }
  if (!values.server || !values.output) throw new Error('Full proof needs --server and --output')
  const server = new URL(values.server)
  if (!['127.0.0.1', 'localhost'].includes(server.hostname) || server.protocol !== 'http:' || !['5293', '5294', '5295', '5296'].includes(server.port)) throw new Error('Use an authorized local preview on 5293–5296')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Commit the proof head first; this preserves one identifiable tested revision')
  const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
  const client = new Client({ name: 'synthetic-jira-proof', version: '1' })
  const receipts: Array<{ operation: string; result: any }> = []
  const record = async (operation: string, result: any) => {
    receipts.push({ operation, result })
    await writeFile(resolve(values.output!), JSON.stringify({ head, server: server.origin, mode: 'synthetic-only; no worker dispatch or inbox delivery', project: { id: project.id, key: project.key }, statuses, receipts }, null, 2), { mode: 0o600 })
    return result
  }
  try {
    await snapshot()
    await client.connect(new StreamableHTTPClientTransport(new URL('/api/reconciliation/mcp', server), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    async function call(name: string, input: Record<string, unknown>) {
      await snapshot()
      const result = await client.callTool({ name, arguments: input }) as { content: Array<{ type: string; text?: string }> }
      const value = JSON.parse(result.content.find(content => content.type === 'text')?.text ?? '{}')
      await record(name, value)
      if (name === 'create_work' || name === 'start_work' || name === 'update_work' || name === 'submit_handoff') {
        if (value.outcome !== 'saved') throw new Error(`${name} was not confirmed saved; inspect the proof receipt before any retry`)
      }
      return value
    }
    const created = await call('create_work', { provider: 'jira', operation_id: `${prefix}-create`, name: `SYNTHETIC Jira adapter proof ${prefix}`, owner: 'Firstmate', area: 'Engineering', status: 'Queued', content: { brief: 'Synthetic fixture only. No real dispatch.', acceptance_criteria: 'UI/MCP state and native Jira readback agree.' } })
    const id = created.card.id
    const update = (kind: string, step: string, input: Record<string, unknown>) => call('update_work', { card_id: id, operation_id: `${prefix}-${step}`, kind, ...input })
    const read = await call('get_work', { card_id: id, refresh: true, details: true })
    const editResponse = await fetch(new URL('/api/reconciliation/workflow', server), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify({ operation: 'update', input: { card_id: id, kind: 'edit', operation_id: `${prefix}-ui-comment`, properties: { Attention: 'Normal' }, note: 'Synthetic UI endpoint comment; this is not a decision.' } }) })
    const edit = await record('UI update_work', await editResponse.json())
    if (!edit.ok || edit.data.outcome !== 'saved') throw new Error('UI update was not confirmed')
    await update('assign', 'assign', { owner: 'Firstmate', status: 'Todo', note: 'Synthetic queue only; no inbox delivery.' })
    await call('start_work', { card_id: id, operation_id: `${prefix}-start`, worker: { kind: 'firstmate', fm_home: home, task_id: task, first_observed_spawn_gen: generation } })
    for (const request of ['a', 'b']) await update('request_decision', `request-${request}`, { request_id: `${prefix}-${request}`, question: `SYNTHETIC decision ${request}: proceed?`, requested_from: 'Will', options: [{ id: 'yes', label: 'Proceed with synthetic proof' }] })
    for (const dependency of ['a', 'b']) await update('wait', `wait-${dependency}`, { dependency: `Synthetic dependency ${dependency}`, unblocks_when: `Synthetic ${dependency} proof recorded`, follow_up_by: 'Synthetic proof operator' })
    const waiting = await call('get_work', { card_id: id, refresh: true, details: true })
    const waits = String(waiting.card.source.properties['Waiting For'].value).split('\n')
    for (const [index, request] of ['a', 'b'].entries()) await update('answer_decision', `answer-${request}`, { request_id: `${prefix}-${request}`, answer: 'Proceed with synthetic proof', option_id: 'yes', resolve_wait: waits[index], next: { owner: 'Firstmate', status: 'Queued' } })
    const spec = '# SYNTHETIC approved contract\n\n| Exact | Unicode |\n|---|---|\n|  spaces\t | 日本語 🚀 |\n```ts\nconst sample = `literal ${value}`\n```\n'.repeat(400)
    const handoff = await call('submit_handoff', { submission_id: `${prefix}-contract`, target: { card_id: id }, title: created.card.properties.Name.value, owner: 'Firstmate', area: 'Engineering', objective: 'Retain synthetic contract bytes and versions', spec_markdown: spec, acceptance_criteria: ['Exact full source text retained; no dispatch'], decisions: [], forbidden_approaches: ['No real work or dispatch'], references: [] })
    const chunks: string[] = []; let offset: number | null = 0
    while (offset !== null) {
      const result = await call('get_work', { card_id: id, details: false, implementation_contract: { revision: handoff.record.spec_version, offset, limit: 20 } })
      if (!result.implementation_contract.verified) throw new Error('Exact contract readback unverified')
      chunks.push(...result.implementation_contract.chunks.map((chunk: any) => chunk.text)); offset = result.implementation_contract.next_offset
    }
    if (digest(chunks.join('')) !== handoff.record.spec_hash || !chunks.join('').includes(spec)) throw new Error('Exact synthetic contract bytes differ')
    await update('complete', 'complete', { disposition: 'Synthetic adapter proof completed; retained for owner review', evidence: `UI/MCP receipts at head ${head}; exact contract hash ${handoff.record.spec_hash}` })
    const final = await call('get_work', { card_id: id, refresh: true, details: true })
    const native = await adapter.read(id)
    await record('independent Jira REST readback', native)
    if (final.card.source.properties.Status.value !== 'Done' || native.properties.Status?.value !== 'Done' || JSON.stringify(final.card.source.properties) !== JSON.stringify(native.properties)) throw new Error('Final MCP and native Jira state differ')
    console.log(JSON.stringify({ head, card_id: id, url: native.url, output: resolve(values.output), outcome: 'confirmed synthetic end-to-end', initial_status: read.card.source.properties.Status.value, final_status: native.properties.Status.value, worker: 'Synthetic file identity only; no actual execution or dispatch' }, null, 2))
  } finally { await client.close() }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Synthetic Jira proof failed; inspect receipt'); process.exitCode = 1 })
