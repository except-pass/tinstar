import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { NotionApi } from '../notionApi'
import { WorkReader } from '../workReader'
import { WorkflowOperations } from '../workflow'
import { ReconciliationSources } from '..'
import { ReconciliationMcp } from '../mcp'
import { createTunnelFacade } from '../tunnel'
import { externalWorkers, type StartWorkInput } from '../../../shared/workflow'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { workerLinkRecord } from '../workerLinks'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'
const id = 'a'.repeat(32), dataSourceId = 'b'.repeat(32)
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
function fixture() {
  let raw = { object: 'page', id, parent: { data_source_id: dataSourceId }, url: `https://www.notion.so/${id}`, last_edited_time: new Date().toISOString(),
    properties: { Name: { type: 'title', title: [{ plain_text: 'Fixture start' }] }, Status: { type: 'status', status: { name: 'Queued' } },
      Owner: { type: 'select', select: { name: 'Firstmate' } }, Area: { type: 'select', select: { name: 'Engineering' } },
      'Last touched by': { type: 'rich_text', rich_text: [] }, 'First Mate tasks': { type: 'rich_text', rich_text: [] }, Evidence: { type: 'rich_text', rich_text: [] },
      'Will action': { type: 'multi_select', multi_select: [{ name: 'Merge' }, { name: 'Decision' }] },
      'Waiting For': { type: 'rich_text', rich_text: [{ plain_text: 'Preserve another request' }] },
      'Next check-in': { type: 'date', date: { start: '2026-11-12' } }, Initiative: { type: 'select', select: { name: 'Tin Star' } }, Epic: { type: 'rich_text', rich_text: [{ plain_text: 'Workflow' }] } } } as Record<string, any>
  let failedPatch = false, partialPatch = false, lostResponse = false, failReads = false
  let onRead: (() => void) | undefined
  const requests: Array<{ url: string; method: string; body?: any }> = []
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url: String(url), method, body })
    if (failReads && method === 'GET') throw new Error('secret_fake_failure')
    if (path === `/v1/pages/${id}` && method === 'PATCH') {
      if (failedPatch) return json({}, 403)
      for (const [name, value] of Object.entries(body.properties)) {
        if (!partialPatch || name === 'Status') raw.properties[name] = { ...raw.properties[name], ...(value as object) }
      }
      raw.last_edited_time = new Date().toISOString()
      if (lostResponse) throw new Error('network response lost')
      return json(raw)
    }
    if (path === `/v1/pages/${id}`) { onRead?.(); return json(raw) }
    if (path === `/v1/data_sources/${dataSourceId}`) return json({ object: 'data_source', properties: Object.fromEntries(Object.entries(raw.properties).map(([name, property]) => [name, { id: name, type: (property as any).type }])) })
    if (path.endsWith('/query')) {
      const matches = (filter: any): boolean => {
        if (!filter) return true
        if (filter.and) return filter.and.every(matches)
        if (filter.or) return filter.or.some(matches)
        const prop = raw.properties[filter.property], type = prop.type, test = filter[type], value = prop[type]?.name ?? prop[type]?.map((v: any) => v.plain_text).join('')
        if (test?.equals !== undefined) return value === test.equals
        if (test?.does_not_equal !== undefined) return value !== test.does_not_equal
        if (type === 'date') return Date.parse(prop.date.start) <= Date.parse(test.on_or_before)
        return true
      }
      return json({ results: matches(body.filter) ? [raw] : [], has_more: false })
    }
    if (path === '/v1/comments') return json({ has_more: false, results: [{ id: 'comment-1', created_by: { id: 'author-1' }, created_time: '2026-11-10T00:00:00Z', rich_text: [{ plain_text: 'Evidence note' }] }] })
    if (path.includes('/blocks/')) return json({ has_more: false, results: [{ id: 'body-1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Acceptance: retain provenance' }] } }] })
    return json({}, 404)
  })
  const api = new NotionApi(fetcher, 0), reader = new WorkReader({ token: 'fixture-token-only', dataSourceId }, api)
  const fleet = fixtureSources().fleet
  const home = fleet.find(row => row.observation.data?.tasks.length)!, task = home.observation.data!.tasks[0]!
  home.observation.status = 'fresh'; home.observation.coverage = 'complete'; home.observation.expiresAt = new Date(Date.now() + 300_000).toISOString()
  task.kind = 'crewmate'; task.identity.spawn_gen = 'native-gen'; task.identity.task_id = 'native-task'; task.cardReferences = []
  task.current_state = { state: 'working', source: 'pane', detail: null, observed_at: new Date().toISOString(), freshness: 'fresh' }
  task.endpoint = { exists: true, agent_alive: true, status: 'alive', observed_at: null, freshness: 'fresh' }
  const workflow = new WorkflowOperations(reader, async () => fleet)
  const native: StartWorkInput = { card_id: id, operation_id: 'native-start', worker: { kind: 'firstmate', fm_home: home.source.home, task_id: 'native-task', first_observed_spawn_gen: 'native-gen' } }
  const external: StartWorkInput = { card_id: id, operation_id: 'external-start', worker: { kind: 'external', system: 'Build runner', run_id: 'run-123', reference: 'https://runner.example/runs/123', card_id: id, observed_at: new Date().toISOString(), state: 'running', evidence: 'Runner reports executing step compile for this card' } }
  return { fetcher, requests, api, reader, workflow, native, external, home, task, raw,
    sources: () => new ReconciliationSources({ fleet: [], notion: { token: 'fixture-token-only', dataSourceId }, warnings: [] }, fetcher, api),
    controls: { failPatch: () => { failedPatch = true }, partial: (value = true) => { partialPatch = value }, lost: () => { lostResponse = true }, failReads: () => { failReads = true }, onRead: (fn: () => void) => { onRead = fn } } }
}
const roots: string[] = [], servers: Server[] = [], clients: Client[] = []
afterEach(async () => {
  vi.useRealTimers(); resetOriginAllowlistForTests()
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('shared policy-aware start work', () => {
  it('merges exact native provenance and coupled fields, preserves appointments/asks, and deduplicates concurrent retries', async () => {
    const f = fixture()
    Object.assign(f.raw.properties['First Mate tasks'], workerLinkRecord([{ fm_home: '/other', task_id: 'retained', first_observed_spawn_gen: 'old-gen' }]).properties['First Mate tasks'])
    const before = structuredClone(f.raw.properties)
    const [one, two] = await Promise.all([f.workflow.start(f.native, 'Firstmate'), f.workflow.start(f.native, 'Firstmate')])
    expect(one).toEqual(two); expect(one).toMatchObject({ outcome: 'saved', saved_fields: ['Status', 'Last touched by', 'First Mate tasks'] })
    const card = (one.card as any)
    expect(card.properties['First Mate tasks'].workerLinks.tasks).toEqual([{ fm_home: '/other', task_id: 'retained', first_observed_spawn_gen: 'old-gen' }, { fm_home: f.home.source.home, task_id: 'native-task', first_observed_spawn_gen: 'native-gen' }])
    expect(f.raw.properties['Next check-in']).toEqual(before['Next check-in']); expect(f.raw.properties['Will action']).toEqual(before['Will action']); expect(f.raw.properties['Waiting For']).toEqual(before['Waiting For'])
    expect(f.requests.filter(request => request.method === 'PATCH')).toHaveLength(1)
    expect(await f.workflow.start({ ...f.native, worker: { ...f.native.worker, task_id: 'different' } as any }, 'Firstmate')).toMatchObject({ code: 'operation-conflict' })
  })
  it.each(['stale', 'partial', 'unknown', 'historical', 'generation', 'dead', 'missing-owner', 'missing-area', 'conflict'] as const)('rejects %s for the requested transition without altering the card', async kind => {
    const f = fixture()
    if (kind === 'stale') f.home.observation.expiresAt = new Date(Date.now() - 1).toISOString()
    if (kind === 'partial') f.home.observation.coverage = 'partial'
    if (kind === 'unknown') f.task.current_state.state = 'unknown'
    if (kind === 'historical') { f.task.current_state.source = 'status-log'; f.task.lastEventText = 'working [at=1]: old report' }
    if (kind === 'generation') f.task.identity.spawn_gen = 'other'
    if (kind === 'dead') f.task.endpoint.exists = false
    if (kind === 'missing-owner') f.raw.properties.Owner.select = null
    if (kind === 'missing-area') f.raw.properties.Area.select = null
    if (kind === 'conflict') f.native.expected = { owner: 'someone-else', status: 'Queued', worker_links: '' }
    expect(await f.workflow.start(f.native, 'Firstmate')).toMatchObject({ outcome: 'not-saved' })
    expect(f.requests.some(request => request.method === 'PATCH')).toBe(false)
  })
  it('records external evidence honestly with authenticated attribution and rejects bare or stale claims', async () => {
    const f = fixture()
    expect(await f.workflow.start({ ...f.external, worker: { kind: 'external', system: 'Owner' } } as any, 'Consumer')).toMatchObject({ code: 'invalid-input' })
    const stale = { ...f.external, worker: { ...f.external.worker, observed_at: new Date(Date.now() - 600_000).toISOString() } } as StartWorkInput
    expect(await f.workflow.start(stale, 'Consumer')).toMatchObject({ code: 'external-evidence-stale' })
    expect(await f.workflow.start(f.external, 'Consumer')).toMatchObject({ outcome: 'saved' })
    expect(f.raw.properties['First Mate tasks'].rich_text).toEqual([])
    const external = externalWorkers((await f.reader.card(id)).properties.Evidence!.value)
    expect(external).toMatchObject([{ run_id: 'run-123', reported_by: 'Consumer', verification: 'consumer-reported', freshness: 'current-report' }])
    expect(externalWorkers((await f.reader.card(id)).properties.Evidence!.value, Date.now() + 600_000)[0]!.freshness).toBe('unknown')
  })
  it('compares relevant preconditions while preserving concurrent unrelated edits', async () => {
    const f = fixture(); let count = 0
    f.controls.onRead(() => { if (++count === 2) f.raw.properties.Priority = { type: 'select', select: { name: 'High' } } })
    expect(await f.workflow.start(f.native, 'Firstmate')).toMatchObject({ outcome: 'saved' })
    expect(f.raw.properties.Priority.select.name).toBe('High')
    const other = fixture(); let reads = 0
    other.controls.onRead(() => { if (++reads === 2) other.raw.properties.Owner.select.name = 'Changed' })
    expect(await other.workflow.start(other.native, 'Firstmate')).toMatchObject({ outcome: 'not-saved', code: 'conflict' })
  })
  it('reports partial fields and repairs a retry without duplicating effects', async () => {
    const f = fixture(); f.controls.partial()
    expect(await f.workflow.start(f.native, 'Firstmate')).toMatchObject({ outcome: 'partially-saved', saved_fields: ['Status'] })
    f.controls.partial(false)
    expect(await f.workflow.start(f.native, 'Firstmate')).toMatchObject({ outcome: 'saved' })
    expect((await f.reader.card(id)).properties['First Mate tasks']!.workerLinks).toMatchObject({ status: 'valid', tasks: [expect.objectContaining({ task_id: 'native-task' })] })
    expect(f.requests.some(request => request.url.includes('/comments'))).toBe(false)
  })
  it('keeps a lost patch response unconfirmed and reconciles its retry without another write', async () => {
    const f = fixture(); f.controls.lost()
    expect(await f.workflow.start(f.native, 'Firstmate')).toMatchObject({ outcome: 'partially-saved', code: 'save-unconfirmed', saved_fields: [] })
    expect(await f.workflow.start(f.native, 'Firstmate')).toMatchObject({ outcome: 'saved', code: 'already-saved' })
    expect(f.requests.filter(request => request.method === 'PATCH')).toHaveLength(1)
  })
  it('fails visibly when Notion rejects the write or is unavailable', async () => {
    const f = fixture(); f.controls.failPatch()
    expect(await f.workflow.start(f.native, 'Firstmate')).toMatchObject({ outcome: 'not-saved', code: 'notion-rejected' })
    f.controls.failReads()
    expect(await f.workflow.start(f.native, 'Firstmate')).toMatchObject({ outcome: 'not-saved', code: 'source-unavailable' })
  })
})

describe('shared status-aware work reads', () => {
  it('filters at Notion, coalesces/cache hits across consumers, avoids routine detail reads and updates cached query membership on a confirmed start', async () => {
    const f = fixture()
    const [one, two] = await Promise.all([f.reader.query({ owner: 'Firstmate', statuses: ['Queued'], initiative: 'Tin Star', epic: 'Workflow' }), f.reader.query({ owner: 'Firstmate', statuses: ['Queued'], initiative: 'Tin Star', epic: 'Workflow' })])
    expect(one).toEqual(two); expect(one.data!.cards).toHaveLength(1)
    expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(f.requests.some(request => /blocks|comments/.test(request.url))).toBe(false)
    expect(f.requests.find(request => request.method === 'POST')!.body.filter).toMatchObject({ and: expect.arrayContaining([{ property: 'Owner', select: { equals: 'Firstmate' } }, { or: [{ property: 'Status', status: { equals: 'Queued' } }] }, { property: 'Initiative', select: { equals: 'Tin Star' } }, { property: 'Epic', rich_text: { equals: 'Workflow' } }]) })
    await f.reader.query({ statuses: ['In Progress'] })
    expect(await f.workflow.start(f.native, 'Firstmate')).toMatchObject({ outcome: 'saved' })
    expect((await f.reader.query({ owner: 'Firstmate', statuses: ['Queued'], initiative: 'Tin Star', epic: 'Workflow' })).data!.cards).toHaveLength(0)
    expect((await f.reader.query({ statuses: ['In Progress'] })).data!.cards).toHaveLength(1)
    expect(f.requests.filter(request => request.url.endsWith(`/data_sources/${dataSourceId}`))).toHaveLength(1)
    expect(f.api.diagnostics.cacheHits).toBeGreaterThan(0)
  })
  it('shares Smart Search Blocked semantics with the UI, reads exact history outside active scope, and caches body/comments without duplication', async () => {
    const f = fixture(), sources = f.sources()
    f.raw.properties.Status.status.name = 'Waiting For'
    const result = await sources.searchWork({ owner: 'Firstmate', patterns: ['blocked'] })
    expect(result.records[0]!.health.patterns.blocked.outcome).toBe('match')
    expect(result.records[0]!.card!.id).toBe(id)
    f.raw.properties.Status.status.name = 'Done'
    const get = await sources.getWork({ card_id: id })
    expect(get).toMatchObject({ outcome: 'available', card: { source: { properties: { Status: { value: 'Done' } } } }, context: { blocks: [expect.objectContaining({ id: 'body-1' }), expect.objectContaining({ id: 'comment-1', author: 'author-1' })] } })
    await sources.getWork({ card_id: id })
    expect(f.requests.filter(request => request.url.includes('/comments'))).toHaveLength(1)
    f.controls.failReads()
    expect(await sources.getWork({ card_id: id, refresh: true })).toMatchObject({ outcome: 'stale', coverage: 'unknown', card: { id } })
  })
})

it('honors Retry-After across all operations and measures request counts and latency', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } })).mockResolvedValue(json({}))
  const api = new NotionApi(fetcher, 0)
  await api.fetch('https://api.notion.com/v1/pages/fixture')
  const next = api.fetch('https://api.notion.com/v1/comments')
  await vi.advanceTimersByTimeAsync(1999); expect(fetcher).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1); await next
  expect(fetcher).toHaveBeenCalledTimes(2); expect(api.diagnostics.rateLimits).toBe(1); expect(api.diagnostics.latencyMs).toBeGreaterThanOrEqual(2000)
})

it('uses one policy through authenticated UI, MCP and the existing tunnel, without a browser or scene', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = fixture(), sources = f.sources()
  const root = await mkdtemp(join(tmpdir(), 'workflow-mcp-')); roots.push(root)
  const mcp = new ReconciliationMcp(sources, root)
  const server = createServer((req, res) => { void mcp.handle(req, res) }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`
  seedOriginAllowlist(port)
  const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
  const client = new Client({ name: 'workflow-test', version: '1' }); clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Tinstar-Caller': 'Tin Star UI' } } }))
  const parse = (result: any) => JSON.parse(result.content[0].text)
  expect(parse(await client.callTool({ name: 'search_work', arguments: { owner: 'Firstmate' } })).records[0].card.id).toBe(id)
  expect(parse(await client.callTool({ name: 'get_workflow_rules', arguments: {} })).enforced).toEqual(expect.arrayContaining([expect.stringContaining('External runs')]))
  const request = { operation: 'start', input: f.external }
  expect((await fetch(`${base}/api/reconciliation/workflow`, { method: 'POST', body: JSON.stringify(request) })).status).toBe(403)
  expect((await fetch(`${base}/api/reconciliation/workflow`, { method: 'POST', headers: { 'X-Tinstar-UI': '1', Origin: 'https://evil.example' }, body: JSON.stringify(request) })).status).toBe(403)
  const ui = await fetch(`${base}/api/reconciliation/workflow`, { method: 'POST', headers: { 'X-Tinstar-UI': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
  const uiResult = (await ui.json()).data
  const mcpResult = parse(await client.callTool({ name: 'start_work', arguments: f.external }))
  expect(uiResult).toMatchObject({ outcome: 'saved' }); expect(mcpResult).toEqual(uiResult)
  const get = parse(await client.callTool({ name: 'get_work', arguments: { card_id: id, details: false } }))
  expect(get.card.source.properties.Status.value).toBe('In Progress')
  expect(get.external_workers[0]).toMatchObject({ run_id: 'run-123', reported_by: 'Tin Star UI', verification: 'consumer-reported' })
  const facade = createTunnelFacade({ upstreamPort: port, installToken: token, caller: { id: 'owner-chatgpt', token: 'test-facade-token-'.repeat(3), allowView: false } }); servers.push(facade.server)
  await facade.listen(0)
  const remote = new Client({ name: 'facade-workflow-test', version: '1' }); clients.push(remote)
  await remote.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(facade.server.address() as { port: number }).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${'test-facade-token-'.repeat(3)}` } } }))
  expect((await remote.listTools()).tools.map(tool => tool.name)).toContain('start_work')
  expect((await remote.listTools()).tools.map(tool => tool.name)).not.toContain('present_view')
  expect(parse(await remote.callTool({ name: 'start_work', arguments: { ...f.external, operation_id: 'tunnel-start' } })).outcome).toBe('saved')
  expect(f.raw.properties['Last touched by'].rich_text[0].text.content).toBe('owner-chatgpt')
  const invalid = { ...f.external, operation_id: 'no-owner' }; f.raw.properties.Owner.select = null
  const errorMcp = parse(await remote.callTool({ name: 'start_work', arguments: invalid }))
  const errorUi = await fetch(`${base}/api/reconciliation/workflow`, { method: 'POST', headers: { 'X-Tinstar-UI': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'start', input: invalid }) })
  expect((await errorUi.json()).data).toEqual(errorMcp)
})
