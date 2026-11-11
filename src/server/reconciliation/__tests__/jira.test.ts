import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ReconciliationSources } from '..'
import { NotionApi } from '../notionApi'
import { WorkReader } from '../workReader'
import { WorkflowOperations } from '../workflow'
import { WorkflowContent, receiptMarker, sectionText } from '../workflowContent'
import { ImplementationContracts, implementationContract, digest } from '../implementationContract'
import { ReconciliationMcp } from '../mcp'
import { jiraPropertyKey, JIRA_SYNTHETIC_LABEL, jiraText } from '../jira'
import { jiraCardPrefix, cardIdSchema } from '../../../shared/workIdentity'
import { workerLinkRecord } from '../workerLinks'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import type { CreateWorkInput, SubmitHandoffInput } from '../../../shared/workflow'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'

const json = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status })
const jira = { url: 'https://fortresspower-jira.atlassian.net', projectId: '10638', email: 'fixture@example.test', token: 'fixture-only' } as const
const id = jiraCardPrefix + '60001'
const roots: string[] = [], servers: Server[] = [], clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  resetOriginAllowlistForTests()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jira-workflow-')); roots.push(root)
  const issues = new Map<string, any>(), notes = new Map<string, any[]>(), attachments = new Map<string, any>()
  const requests: Array<{ path: string; method: string; body: any }> = []
  const controls = { failReads: false, uncertainCreate: false, failEdit: false, failTransition: false, lostEdit: false, lostNote: false, failNote: false, lostAttachment: false, partialAttachment: false, omitField: '', missingStatus: '', truncatedSearch: false, foreign: false, unlabelled: false }
  let tick = 0, attachmentId = 1000
  const updated = () => new Date(Date.now() + tick++).toISOString()
  const statuses = ['To Do', 'In Progress', 'In Review', 'Done', 'Queued', 'Waiting For', 'Ready for Review', 'Backlog', 'Archived']
  const make = (issueId: string, fields: Record<string, any> = {}, properties: Record<string, any> = {}) => ({ id: issueId, key: `TSSPIKE-${issues.size + 1}`,
    fields: { project: { id: '10638', key: 'TSSPIKE' }, issuetype: { id: '10582', name: 'Task' }, status: { id: '10005', name: 'To Do' },
      updated: updated(), labels: [JIRA_SYNTHETIC_LABEL], summary: 'Synthetic card', description: jiraText('Original Jira description'), attachment: [], ...fields }, properties })
  const seed = make('60001', {}, Object.fromEntries(Object.entries({ Owner: ['select', 'Firstmate'], Area: ['select', 'Engineering'], 'Last touched by': ['rich_text', 'Fixture'],
    'Waiting For': ['rich_text', ''], 'Will action': ['multi_select', ['Merge']] }).map(([name, [type, value]]) => [jiraPropertyKey(name), { type, value }])))
  issues.set(seed.id, seed); notes.set(seed.id, [])
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const parsed = new URL(String(url)), path = parsed.pathname.replace('/rest/api/3/', ''), method = init?.method ?? 'GET'
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, method, body })
    if (controls.failReads && method === 'GET') throw new Error('private-token-must-not-leak')
    if (path === 'project/10638/statuses') return json([{ id: '10582', statuses: statuses.filter(name => name !== controls.missingStatus).map((name, index) => ({ id: String(index + 1), name })) }])
    if (path === 'project/10638') return json({ id: '10638', key: 'TSSPIKE', style: 'next-gen' })
    if (path === 'search/jql') return json({ issues: [...issues.values()], isLast: !controls.truncatedSearch, ...(controls.truncatedSearch ? { nextPageToken: 'next' } : {}) })
    if (path === 'issue' && method === 'POST') {
      if (controls.uncertainCreate) throw new Error('Connection lost during create')
      const newId = String(60001 + issues.size), raw = make(newId, body.fields, Object.fromEntries(body.properties.map((p: any) => [p.key, p.value])))
      raw.fields.project = { id: '10638', key: 'TSSPIKE' }; raw.fields.issuetype = { id: '10582', name: 'Task' }
      issues.set(newId, raw); notes.set(newId, [])
      return json({ id: newId, key: raw.key }, 201)
    }
    if (path.startsWith('attachment/content/')) return json(attachments.get(path.split('/')[2]!))
    const match = /^issue\/(\d+)(?:\/(.*))?$/.exec(path), issueId = match?.[1]!, part = match?.[2], raw = issues.get(issueId)
    if (!raw) return json({}, 404)
    if (!part && method === 'GET') {
      const copy = structuredClone(raw)
      if (controls.foreign) copy.fields.project = { id: '1', key: 'OTHER' }
      if (controls.unlabelled) copy.fields.labels = []
      return json(copy)
    }
    if (!part && method === 'PUT') {
      if (controls.failEdit) return json({}, 403)
      Object.assign(raw.fields, body.fields)
      for (const property of body.properties ?? []) if (property.key !== jiraPropertyKey(controls.omitField)) raw.properties[property.key] = property.value
      raw.fields.updated = updated()
      if (controls.lostEdit) { controls.lostEdit = false; throw new Error('lost update response') }
      return json({}, 204)
    }
    if (part === 'transitions' && method === 'GET') return json({ transitions: statuses.filter(name => name !== controls.missingStatus).map((name, index) => ({ id: String(index + 1), to: { id: String(index + 1), name } })) })
    if (part === 'transitions' && method === 'POST') {
      if (controls.failTransition) return json({}, 403)
      raw.fields.status = { id: body.transition.id, name: statuses[Number(body.transition.id) - 1] }; raw.fields.updated = updated()
      return json({}, 204)
    }
    if (part === 'comment' && method === 'GET') return json({ startAt: Number(parsed.searchParams.get('startAt')), total: notes.get(issueId)!.length, comments: notes.get(issueId) })
    if (part === 'comment' && method === 'POST') {
      if (controls.failNote) return json({}, 403)
      const note = { id: String(notes.get(issueId)!.length + 1), body: body.body, created: updated(), author: { accountId: 'fixture-actor' } }
      notes.get(issueId)!.push(note)
      if (controls.lostNote) { controls.lostNote = false; throw new Error('lost comment response') }
      return json(note, 201)
    }
    if (part === 'attachments' && method === 'POST') {
      const file = (body as FormData).get('file') as File, contents = JSON.parse(await file.text()), aid = String(attachmentId++)
      if (controls.partialAttachment) { controls.partialAttachment = false; contents.sections = contents.sections.slice(0, 1) }
      attachments.set(aid, contents); raw.fields.attachment.push({ id: aid, filename: file.name })
      if (controls.lostAttachment) { controls.lostAttachment = false; throw new Error('lost attachment response') }
      return json([{ id: aid }])
    }
    throw new Error(`Unexpected fixture request ${method} ${path}`)
  })
  const api = new NotionApi(fetcher, 0), reader = new WorkReader(undefined, api, jira)
  const fleet = fixtureSources().fleet
  const home = fleet.find(row => row.observation.data?.tasks.length)!, task = home.observation.data!.tasks[0]!
  home.observation.status = 'fresh'; home.observation.coverage = 'complete'; home.observation.expiresAt = new Date(Date.now() + 300_000).toISOString()
  task.kind = 'crewmate'; task.cardReferences = []; task.identity.task_id = 'synthetic-jira-worker'; task.identity.spawn_gen = 'synthetic-generation'
  task.current_state = { state: 'working', source: 'pane', detail: null, observed_at: new Date().toISOString(), freshness: 'fresh' }
  task.endpoint = { exists: true, agent_alive: true, status: 'alive', observed_at: null, freshness: 'fresh' }
  const workflow = new WorkflowOperations(reader, async () => fleet, root)
  const sources = new ReconciliationSources({ fleet: [], jira, warnings: [] }, fetcher, api, root)
  const worker = { kind: 'firstmate' as const, fm_home: home.source.home, task_id: task.identity.task_id!, first_observed_spawn_gen: task.identity.spawn_gen! }
  const { kind: _kind, ...link } = worker
  return { root, fetcher, reader, workflow, sources, seed, controls, notes, attachments, requests, worker, link, home, task }
}
const create: CreateWorkInput = { provider: 'jira', name: 'Synthetic Jira adapter workflow proof', owner: 'Firstmate', area: 'Engineering', operation_id: 'synthetic-create', status: 'Queued', content: { brief: 'Synthetic implementation brief', acceptance_criteria: 'All reads agree' } }

it('routes canonical identity to exactly one source, rejects other sites/projects and requires synthetic scope before writes', async () => {
  const f = await fixture()
  expect(cardIdSchema.safeParse(id).success).toBe(true)
  for (const bad of ['60001', 'TSSPIKE-1', id.replace('10638', '10639'), id.replace('fortresspower', 'other')]) expect(cardIdSchema.safeParse(bad).success).toBe(false)
  expect((await f.reader.card(id)).source).toMatchObject({ provider: 'jira', itemId: '60001', collectionId: '10638', synthetic: true })
  expect(await f.workflow.create({ ...create, provider: undefined }, 'Fixture')).toMatchObject({ outcome: 'not-saved' })
  for (const flag of ['foreign', 'unlabelled'] as const) {
    f.controls[flag] = true
    await expect(f.reader.card(id, true)).rejects.toThrow('scope')
    expect(await f.workflow.update({ card_id: id, operation_id: flag, kind: 'complete', disposition: 'Synthetic fixture only', evidence: 'Fixture readback' }, 'Fixture')).toMatchObject({ outcome: 'not-saved' })
    f.controls[flag] = false
  }
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})

it('creates, edits, queues, starts with exact synthetic provenance, retains two waits and answers only one decision before completion', async () => {
  const f = await fixture(), notify = vi.fn()
  f.workflow.onChange = notify
  const created = await f.workflow.create(create, 'Fixture')
  expect(created).toMatchObject({ outcome: 'saved', card: { properties: { Status: { value: 'Queued' } } } })
  const cardId = (created.card as any).id
  const update = (input: Record<string, unknown>) => f.workflow.update({ card_id: cardId, ...input } as any, 'Fixture')
  expect(await update({ kind: 'edit', operation_id: 'edit', properties: { Link: 'https://example.test/synthetic', Attention: 'Normal' }, content: { brief: 'Revised synthetic brief' }, note: 'Ordinary comment is not a decision' })).toMatchObject({ outcome: 'saved' })
  expect(await update({ kind: 'assign', operation_id: 'queue', owner: 'Firstmate', status: 'Todo' })).toMatchObject({ outcome: 'saved', card: { properties: { Status: { value: 'Queued' } } } })
  const wrong = await f.workflow.start({ card_id: cardId, operation_id: 'wrong-generation', worker: { ...f.worker, first_observed_spawn_gen: 'other' } }, 'Fixture')
  expect(wrong.outcome).toBe('not-saved')
  expect(await f.workflow.start({ card_id: cardId, operation_id: 'start', worker: f.worker }, 'Fixture')).toMatchObject({ outcome: 'saved', card: { properties: { Status: { value: 'In Progress' }, 'First Mate tasks': { value: workerLinkRecord([f.link]).json } } } })
  for (const request_id of ['request-a', 'request-b']) expect(await update({ kind: 'request_decision', operation_id: request_id, request_id, requested_from: 'Fixture owner', question: `Choose ${request_id}`, options: [{ id: 'yes', label: 'Proceed' }] })).toMatchObject({ outcome: 'saved' })
  for (const dependency of ['dependency-a', 'dependency-b']) expect(await update({ kind: 'wait', operation_id: dependency, dependency, unblocks_when: `${dependency} ready`, follow_up_by: 'Fixture owner' })).toMatchObject({ outcome: 'saved' })
  const before = await f.reader.card(cardId, true), wait = String(before.properties['Waiting For']!.value).split('\n')[0]!
  expect(await update({ kind: 'answer_decision', operation_id: 'answer', request_id: 'request-a', answer: 'Proceed', option_id: 'yes', next: { owner: 'Firstmate', status: 'Queued' }, resolve_wait: wait })).toMatchObject({ outcome: 'saved' })
  const answered = await f.reader.card(cardId, true)
  expect(answered.properties['Will action']!.value).toContain('Decision')
  expect(answered.properties['Waiting For']!.value).toContain('dependency-b')
  expect(answered.properties['Waiting For']!.value).not.toContain('dependency-a')
  expect(answered.properties['First Mate tasks']!.value).toBe(workerLinkRecord([f.link]).json)
  expect(await update({ kind: 'complete', operation_id: 'complete', disposition: 'Synthetic proof complete', evidence: 'Confirmed fixture reads' })).toMatchObject({ outcome: 'saved', card: { properties: { Status: { value: 'Done' } } } })
  expect(notify).not.toHaveBeenCalled()
  expect((await f.reader.query({}, true)).data!.cards.some(card => card.id === cardId)).toBe(false)
  expect((await f.reader.query({ history: true }, true)).data!.cards.some(card => card.id === cardId)).toBe(true)
  expect(f.requests.filter(request => request.method !== 'GET').every(request => request.path === 'search/jql' || request.path === 'issue' || /^issue\/\d+(?:\/(?:comment|transitions|attachments))?$/.test(request.path))).toBe(true)
})

it('uses only the two explicitly approved spelling aliases', async () => {
  const f = await fixture()
  expect((await f.reader.card(id)).properties.Status!.value).toBe('Todo')
  f.seed.fields.status.name = 'In Review'
  expect((await f.reader.card(id, true)).properties.Status!.value).toBe('In review')
  f.seed.fields.status.name = 'Ready for Review'
  expect((await f.reader.card(id, true)).properties.Status!.value).toBe('Ready for Review')
  f.controls.missingStatus = 'Queued'
  expect(await f.workflow.update({ card_id: id, kind: 'assign', operation_id: 'missing-queued', owner: 'Firstmate', status: 'Queued' }, 'Fixture')).toMatchObject({ outcome: 'not-saved', code: 'jira-incompatible' })
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})

it('reports confirmed partial fields and keeps ambiguous writes unknown', async () => {
  const f = await fixture()
  f.controls.omitField = 'Area'
  expect(await f.workflow.update({ card_id: id, kind: 'edit', operation_id: 'partial', properties: { Area: 'Product', Attention: 'High' } }, 'Fixture')).toMatchObject({ outcome: 'partially-saved', code: 'readback-mismatch', saved_fields: expect.arrayContaining(['Attention']) })
  f.controls.omitField = ''; f.controls.failTransition = true
  const partial = await f.workflow.update({ card_id: id, kind: 'assign', operation_id: 'transition-rejected', owner: 'Fixture coordinator', status: 'Queued' }, 'Fixture')
  expect(partial).toMatchObject({ outcome: 'partially-saved', saved_fields: expect.arrayContaining(['Owner']), card: { properties: { Status: { value: 'Todo' } } } })
  f.controls.failTransition = false; f.controls.lostEdit = true
  expect(await f.workflow.update({ card_id: id, kind: 'edit', operation_id: 'lost', properties: { Area: 'Product' } }, 'Fixture')).toMatchObject({ outcome: 'partially-saved', code: 'save-unconfirmed' })
  f.controls.failReads = true
  expect(await f.workflow.update({ card_id: id, kind: 'edit', operation_id: 'offline', note: 'Cannot silently succeed' }, 'Fixture')).toMatchObject({ outcome: 'not-saved', code: 'source-unavailable' })
  expect(JSON.stringify(await f.sources.getWork({ card_id: id }))).not.toContain('private-token')
  const observation = await f.reader.query({}, true)
  expect(observation).toMatchObject({ coverage: 'unknown', data: null })
})

it('does not repeat a lost history POST, and rejects decisions on another card', async () => {
  const f = await fixture(), input = { card_id: id, kind: 'edit' as const, operation_id: 'lost-note', note: 'Synthetic history proof' }
  f.controls.lostNote = true
  expect(await f.workflow.update(input, 'Fixture')).toMatchObject({ outcome: 'partially-saved' })
  expect(await f.workflow.update(input, 'Fixture')).toMatchObject({ outcome: 'saved' })
  expect(f.notes.get('60001')).toHaveLength(1)
  expect(await f.workflow.update({ card_id: id, kind: 'answer_decision', operation_id: 'wrong-card-request', request_id: 'no-such-request', answer: 'Proceed', next: { owner: 'Firstmate', status: 'Queued' } }, 'Fixture')).toMatchObject({ outcome: 'not-saved' })
})

it('retains exact large contract versions in native attachments with the existing uncertain-batch/readback protocol', async () => {
  const f = await fixture(), content = new WorkflowContent(f.reader), contracts = new ImplementationContracts(content)
  const spec = '| Unicode | whitespace |\n| 日本語🚀 |  tabs\t  |\n```ts\nconst x = `literal ${value}`\n```\n'.repeat(1200)
  const input: SubmitHandoffInput = { submission_id: 'synthetic-contract', target: { card_id: id }, title: 'Synthetic contract', owner: 'Firstmate', area: 'Engineering', objective: 'Preserve approved text', spec_markdown: spec,
    acceptance_criteria: ['Exact readback and history retained'], decisions: [], forbidden_approaches: ['No truncation or dispatch'], references: [] }
  const contract = implementationContract(input, 'Fixture'), state = {}, save = vi.fn(async () => {})
  f.controls.lostAttachment = true
  await expect(contracts.write(id, contract, state, save)).rejects.toThrow()
  const uploads = f.requests.filter(request => request.path.endsWith('/attachments')).length
  expect(await contracts.write(id, contract, state, save)).toMatchObject({ outcome: 'available', verified: true })
  expect(f.requests.filter(request => request.path.endsWith('/attachments')).length).toBeGreaterThan(uploads)
  const read = await contracts.read(id, { offset: 0, limit: 1000 }) as any
  expect(read.chunks.map((chunk: any) => chunk.text).join('')).toBe(contract.text)
  expect(digest(read.chunks.map((chunk: any) => chunk.text).join(''))).toBe(contract.manifest.hash)
  expect(read.chunks.map((chunk: any) => chunk.text).join('').slice(read.manifest.spec_offset, read.manifest.spec_offset + read.manifest.spec_length)).toBe(spec)
  const revision = implementationContract({ ...input, revision_id: 'amendment', expected_contract_hash: contract.manifest.hash, spec_markdown: spec + '\nApproved amendment\n' }, 'Fixture')
  expect(await contracts.write(id, revision, {}, save)).toMatchObject({ outcome: 'available', verified: true })
  expect(await contracts.read(id, { revision: contract.manifest.version, offset: 0, limit: 1 })).toMatchObject({ outcome: 'available', verified: true, complete_response: false })
  expect((await f.sources.getWork({ card_id: id, details: true }) as any).implementation_contract.outcome).toBe('not-requested')
  expect((await content.sections(id)).map(section => section.text)).not.toContain(spec)
  const first = [...f.attachments.values()].find(batch => batch.sections.some((section: any) => section.text.includes('Tin Star contract chunk:')))
  first.sections.find((section: any) => section.text.includes('Tin Star contract chunk:')).text += 'tampered'
  await expect(contracts.read(id, { revision: contract.manifest.version, offset: 0, limit: 1 })).rejects.toThrow('differs')
})

it('never calls an incomplete native create saved on retry', async () => {
  const f = await fixture()
  f.controls.failTransition = true
  expect(await f.workflow.create(create, 'Fixture')).toMatchObject({ outcome: 'partially-saved' })
  f.controls.failTransition = false
  const retry = new WorkflowOperations(f.reader, async () => [], f.root)
  expect(await retry.create(create, 'Fixture')).toMatchObject({ outcome: 'partially-saved', code: 'readback-mismatch', card: { properties: { Status: { value: 'Todo' } } } })
  expect(f.requests.filter(request => request.path === 'issue' && request.method === 'POST')).toHaveLength(1)
})

it('shares UI and authenticated MCP operations/readback for the same Jira state', async () => {
  const f = await fixture()
  const mcp = new ReconciliationMcp(f.sources, f.root)
  const server = createServer((req, res) => { void mcp.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`
  seedOriginAllowlist(address.port)
  const client = new Client({ name: 'synthetic-jira-proof', version: '1' }); clients.push(client)
  const { installToken } = await import('../mcp')
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${installToken(f.root)}` } } }))
  const created = JSON.parse((await client.callTool({ name: 'create_work', arguments: create }) as any).content[0].text)
  expect(created.outcome).toBe('saved')
  const cardId = created.card.id
  const ui = await (await fetch(`${base}/api/reconciliation/workflow`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify({ operation: 'update', input: { kind: 'edit', card_id: cardId, operation_id: 'ui-edit', properties: { Area: 'Product' }, note: 'UI and MCP agreement proof' } }) })).json()
  expect(ui).toMatchObject({ ok: true, data: { outcome: 'saved' } })
  const mcpRead = JSON.parse((await client.callTool({ name: 'get_work', arguments: { card_id: cardId, details: true, refresh: true } }) as any).content[0].text)
  const uiRead = await (await fetch(`${base}/api/reconciliation/workflow`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify({ operation: 'get', input: { card_id: cardId, details: true, refresh: true } }) })).json()
  expect(uiRead.data.card.source).toEqual(mcpRead.card.source)
  expect(uiRead.data.card.source.properties).toEqual(mcpRead.card.source.properties)
  expect(mcpRead.card.source.properties.Area.value).toBe('Product')
  expect((await new WorkflowContent(f.reader).notes(cardId)).some(note => note.text.includes(receiptMarker('Tin Star UI', 'ui-edit')))).toBe(true)
  expect(sectionText('brief', 'Synthetic implementation brief')).toBeTruthy()
})

it('retains known cards as stale on provider failure and exposes incomplete pagination', async () => {
  const f = await fixture()
  expect(await f.reader.query({}, true)).toMatchObject({ status: 'fresh', coverage: 'complete', data: { cards: [expect.objectContaining({ id })] } })
  f.controls.failReads = true
  expect(await f.reader.query({}, true)).toMatchObject({ status: 'stale', coverage: 'unknown', data: { cards: [expect.objectContaining({ id })] } })
  f.controls.failReads = false; f.controls.truncatedSearch = true
  expect(await f.reader.query({}, true)).toMatchObject({ status: 'stale', coverage: 'unknown' })
})

it('does not replay a partial contract attachment or bypass provider-specific input limits', async () => {
  const f = await fixture(), content = new WorkflowContent(f.reader), contracts = new ImplementationContracts(content)
  const input: SubmitHandoffInput = { submission_id: 'partial-synthetic-contract', target: { card_id: id }, title: 'Synthetic', owner: 'Firstmate', area: 'Engineering', objective: 'Exact bytes', spec_markdown: 'SYNTHETIC 日本語🚀\n'.repeat(4000), acceptance_criteria: ['Exact bytes'], decisions: [], forbidden_approaches: [], references: [] }
  const contract = implementationContract(input, 'Fixture'), state = {}, save = async () => {}
  // First batch is the executive brief. Interrupt a later multi-section batch.
  let uploads = 0
  const append = f.reader.jira!.appendContract.bind(f.reader.jira)
  vi.spyOn(f.reader.jira!, 'appendContract').mockImplementation(async (...args) => {
    if (++uploads === 2) { f.controls.partialAttachment = true; f.controls.lostAttachment = true }
    return append(...args)
  })
  await expect(contracts.write(id, contract, state, save)).rejects.toThrow()
  const submitted = uploads
  await expect(contracts.write(id, contract, state, save)).rejects.toThrow('earlier append remains uncertain')
  expect(uploads).toBe(submitted)
  expect(await f.workflow.update({ card_id: id, operation_id: 'timestamp', kind: 'edit', properties: { 'Start Date': '2026-11-12T09:00:00Z' } }, 'Fixture')).toMatchObject({ outcome: 'not-saved', code: 'jira-incompatible' })
  expect(await f.workflow.update({ card_id: id, operation_id: 'property-limit', kind: 'wait', dependency: '漢'.repeat(11500), unblocks_when: 'Synthetic ready', follow_up_by: 'Fixture' }, 'Fixture')).toMatchObject({ outcome: 'not-saved', code: 'jira-incompatible' })
})

it('records an approved handoff on the existing Jira card without offering pickup or a live source answer', async () => {
  const f = await fixture(), notify = vi.fn(), deliver = vi.fn()
  f.workflow.onChange = notify; f.workflow.decisionDelivery = deliver as any
  const input: SubmitHandoffInput = { submission_id: 'synthetic-approved-handoff', target: { card_id: id }, title: 'Synthetic amended title', owner: 'Firstmate', area: 'Engineering', objective: 'Retain exact approved handoff', spec_markdown: 'SYNTHETIC only\n', acceptance_criteria: ['No dispatch'], decisions: [], forbidden_approaches: ['No real work'], references: [] }
  expect(await f.workflow.submitHandoff(input, 'Fixture')).toMatchObject({ outcome: 'saved', record: { state: 'updated', full_spec_readback: 'verified' }, delivery: { state: 'disabled' } })
  expect(notify).not.toHaveBeenCalled()
  expect(deliver).not.toHaveBeenCalled()
  const card = await f.reader.card(id, true)
  expect(card.properties.Owner!.value).toBe('Firstmate')
  expect(card.properties.Status!.value).toBe('Todo')
  expect(card.properties.Name!.value).toBe('Synthetic amended title')
  expect((await f.sources.checkInSnapshot(true)).checkIns?.data?.cards).toEqual([])
})


it.each([
  { status: 'Backlog' as const, properties: {}, missingStatus: 'Backlog', message: 'TSSPIKE Task lacks native status Backlog' },
  { status: 'Todo' as const, properties: { 'Start Date': '2026-11-12T09:00:00Z' }, missingStatus: '', message: "Start Date: Jira's native date field requires YYYY-MM-DD; a timestamp cannot be silently truncated" },
  { status: 'Todo' as const, properties: { 'Due Date': '2026-11-12T09:00:00Z' }, missingStatus: '', message: "Due Date: Jira's native date field requires YYYY-MM-DD; a timestamp cannot be silently truncated" },
])('keeps proven pre-write creation incompatibilities retryable: $message', async ({ status, properties, missingStatus, message }) => {
  const f = await fixture()
  f.controls.missingStatus = missingStatus
  const input = { ...create, owner: 'Fixture', status, properties }
  for (let retry = 0; retry < 2; retry++) {
    const workflow = new WorkflowOperations(f.reader, async () => [], f.root)
    expect(await workflow.create(input, 'Fixture')).toMatchObject({ outcome: 'not-saved', code: 'jira-incompatible', message })
  }
  expect(f.requests.filter(request => request.path === 'issue' && request.method === 'POST')).toHaveLength(0)
  f.controls.missingStatus = ''
  const workflow = new WorkflowOperations(f.reader, async () => [], f.root)
  expect(await workflow.create({ ...input, properties: {} }, 'Fixture')).toMatchObject({ outcome: 'saved' })
  expect(f.requests.filter(request => request.path === 'issue' && request.method === 'POST')).toHaveLength(1)
})

it('retains the durable duplicate guard after a potentially submitted Jira creation', async () => {
  const f = await fixture()
  f.controls.uncertainCreate = true
  expect(await f.workflow.create(create, 'Fixture')).toMatchObject({ outcome: 'partially-saved', code: 'create-unconfirmed' })
  f.controls.uncertainCreate = false
  const workflow = new WorkflowOperations(f.reader, async () => [], f.root)
  expect(await workflow.create(create, 'Fixture')).toMatchObject({ outcome: 'partially-saved', code: 'create-unconfirmed' })
  expect(f.requests.filter(request => request.path === 'issue' && request.method === 'POST')).toHaveLength(1)
})

it('renders provider-aware parent references while preserving Notion contract bytes', () => {
  const input: SubmitHandoffInput = { submission_id: 'parent-contract', target: { card_id: id }, title: 'Synthetic', owner: 'Firstmate', area: 'Engineering', objective: 'Objective', spec_markdown: 'Spec', acceptance_criteria: ['Accept'], decisions: [], forbidden_approaches: [], references: [] }
  const prefix = '# Objective\nObjective\n\n# Approved specification\nSpec\n\n# Acceptance criteria\n1. Accept\n\n# Approved decisions\n\n\n# Forbidden approaches\n\n\n# Durable references\n\n'
  const notionId = '41550ce6d42281c791f8ca0f471c52b5'
  const notion = implementationContract({ ...input, parent_card_id: notionId }, 'Fixture')
  expect(notion.text).toBe(prefix + `\nParent card: https://www.notion.so/${notionId}\n`)
  expect(notion.manifest.hash).toBe(digest(notion.text))
  const jira = implementationContract({ ...input, parent_card_id: id }, 'Fixture')
  expect(jira.text).toBe(prefix + '\nParent card: https://fortresspower-jira.atlassian.net/secure/IssueNavigator.jspa?jql=id%20%3D%2060001\n')
  expect(jira.manifest.hash).toBe(digest(jira.text))
})
