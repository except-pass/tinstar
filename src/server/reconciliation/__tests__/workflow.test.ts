import { checkInReport } from '../checkInWatchdog'
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
import { NotionWriteError, receiptMarker, WorkflowContent } from '../workflowContent'
import { FirstmateUpdates } from '../firstmateUpdates'
import { inboxRequestId } from '../../../shared/ask'
import { handleReconciliationRequest, ReconciliationSources } from '..'
import { ReconciliationMcp } from '../mcp'
import { createTunnelFacade } from '../tunnel'
import { initialPresentation } from '../../../shared/reconciliationPresentation'
import { externalWorkers, type StartWorkInput, type UpdateWorkInput } from '../../../shared/workflow'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { workerLinkRecord } from '../workerLinks'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'
const id = 'a'.repeat(32), dataSourceId = 'b'.repeat(32)
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
function fixture(prose = { body: 'Acceptance: retain provenance', comment: 'Evidence note' }) {
  let raw = { object: 'page', id, parent: { data_source_id: dataSourceId }, url: `https://www.notion.so/${id}`, last_edited_time: new Date().toISOString(),
    properties: { Name: { type: 'title', title: [{ plain_text: 'Fixture start' }] }, Status: { type: 'status', status: { name: 'Queued' } },
      Owner: { type: 'select', select: { name: 'Firstmate' } }, Area: { type: 'select', select: { name: 'Engineering' } },
      'Last touched by': { type: 'rich_text', rich_text: [] }, 'First Mate tasks': { type: 'rich_text', rich_text: [] }, 'Delegated To': { type: 'rich_text', rich_text: [{ plain_text: 'Existing delegated consumer context' }] },
      'Will action': { type: 'multi_select', multi_select: [{ name: 'Merge' }, { name: 'Decision' }] },
      'Waiting For': { type: 'rich_text', rich_text: [{ plain_text: 'Preserve another request' }] },
      'Next check-in': { type: 'date', date: { start: '2026-11-12' } }, Initiative: { type: 'select', select: { name: 'Tin Star' } }, Epic: { type: 'rich_text', rich_text: [{ plain_text: 'Workflow' }] } } } as Record<string, any>
  let failedPatch = false, partialPatch = false, lostResponse = false, failReads = false, failNote = false, lostNote = false, lostCreate = false
  const comments: any[] = [{ id: 'comment-1', created_by: { id: 'author-1' }, created_time: '2026-11-10T00:00:00Z', rich_text: [{ plain_text: prose.comment }] }]
  const blocks: any[] = [{ id: 'body-1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: prose.body }] } }]
  const pages = new Map<string, any>([[id, raw]])
  let onRead: (() => void) | undefined
  const requests: Array<{ url: string; method: string; body?: any }> = []
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url: String(url), method, body })
    if (failReads && method === 'GET') throw new Error('secret_fake_failure')
    const pageId = path.split('/')[3], page = path.startsWith('/v1/pages/') ? pages.get(pageId!) : undefined
    if (path === '/v1/pages' && method === 'POST') {
      const createdId = 'c'.repeat(32), created = { ...structuredClone(raw), id: createdId, url: `https://www.notion.so/${createdId}`, properties: Object.fromEntries(Object.entries(body.properties).map(([name, value]) => [name, { type: raw.properties[name].type, ...(value as object) }])) }
      pages.set(createdId, created); blocks.push(...body.children.map((block: any, i: number) => ({ ...block, id: `created-${i}`, pageId: createdId })))
      if (lostCreate) { lostCreate = false; throw new Error('lost create response') }
      return json(created)
    }
    if (page && method === 'PATCH') {
      if (failedPatch) return json({}, 403)
      for (const [name, value] of Object.entries(body.properties)) {
        if (!partialPatch || name === 'Status') page.properties[name] = { ...page.properties[name], ...(value as object) }
      }
      raw.last_edited_time = new Date().toISOString()
      if (lostResponse) throw new Error('network response lost')
      return json(raw)
    }
    if (page && method === 'GET') { onRead?.(); return json(page) }
    if (path === `/v1/data_sources/${dataSourceId}`) return json({ object: 'data_source', properties: Object.fromEntries(Object.entries(raw.properties).map(([name, property]) => [name, { id: name, type: (property as any).type }])) })
    if (path.endsWith('/query')) {
      const matches = (filter: any, candidate = raw): boolean => {
        if (!filter) return true
        if (filter.and) return filter.and.every((f: any) => matches(f, candidate))
        if (filter.or) return filter.or.some((f: any) => matches(f, candidate))
        const prop = candidate.properties[filter.property], type = prop.type, test = filter[type]
        // Date values are objects, not rich-text arrays. Handle the supported
        // date filter before attempting the scalar/rich-text projection.
        if (type === 'relation') return [...prop.relation, ...(prop.hiddenRelations ?? [])].some((v: any) => v.id === test.contains)
        if (type === 'date') return Date.parse(prop.date.start) <= Date.parse(test.on_or_before)
        const value = prop[type]?.name ?? prop[type]?.map((v: any) => v.plain_text ?? v.text?.content ?? '').join('')
        if (test?.equals !== undefined) return value === test.equals
        if (test?.does_not_equal !== undefined) return value !== test.does_not_equal
        return true
      }
      return json({ results: [...pages.values()].filter(candidate => matches(body.filter, candidate)), has_more: false })
    }
    if (path === '/v1/comments' && method === 'POST') {
      if (failNote) return json({}, 503)
      const comment = { id: `comment-${comments.length + 1}`, rich_text: body.rich_text, created_by: { id: 'fixture-actor' }, created_time: new Date().toISOString() }
      comments.push(comment)
      if (lostNote) { lostNote = false; throw new Error('lost comment response') }
      return json(comment)
    }
    if (path === '/v1/comments') return json({ has_more: false, results: comments })
    if (path.includes('/blocks/') && path.endsWith('/children')) {
      const blockPage = path.split('/')[3]!
      if (method === 'PATCH') blocks.push(...body.children.map((block: any, i: number) => ({ ...block, id: `block-${blocks.length + i}`, pageId: blockPage })))
      return json({ has_more: false, results: blocks.filter(block => (block.pageId ?? id) === blockPage) })
    }
    if (path.includes('/blocks/') && method === 'PATCH') {
      const block = blocks.find(block => block.id === path.split('/')[3])
      Object.assign(block, body); return json(block)
    }
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
  return { fetcher, requests, api, reader, workflow, native, external, home, task, raw, blocks, comments, pages,
    sources: (receiptRoot?: string) => new ReconciliationSources({ fleet: [], notion: { token: 'fixture-token-only', dataSourceId }, warnings: [] }, fetcher, api, receiptRoot),
    controls: { failNote: (value = true) => { failNote = value }, lostNote: () => { lostNote = true }, lostCreate: () => { lostCreate = true }, failPatch: (value = true) => { failedPatch = value }, partial: (value = true) => { partialPatch = value }, lost: () => { lostResponse = true }, failReads: () => { failReads = true }, onRead: (fn: () => void) => { onRead = fn } } }
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
    f.task.cardReferences = [{ pageId: 'c'.repeat(32), source: 'task.body', strength: 'textual' } as any]
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
    expect((await f.reader.card(id)).properties['Delegated To']!.value).toContain('Existing delegated consumer context')
    const external = externalWorkers((await f.reader.card(id)).properties['Delegated To']!.value)
    expect(external).toMatchObject([{ run_id: 'run-123', reported_by: 'Consumer', verification: 'consumer-reported', freshness: 'current-report' }])
    expect(externalWorkers((await f.reader.card(id)).properties['Delegated To']!.value, Date.now() + 600_000)[0]!.freshness).toBe('unknown')
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
  it.each(['Initiative', 'Epic'])('retains unknown %s membership after a start while removing definite nonmatches', async classification => {
    const f = fixture(), target = 'c'.repeat(32), other = 'd'.repeat(32)
    f.raw.properties[classification] = { id: classification, type: 'relation', relation: [{ id: other }], has_more: true, hiddenRelations: [{ id: target }] }
    const scope = { [classification.toLowerCase()]: target }
    expect((await f.reader.query(scope)).data!.cards).toHaveLength(1)
    expect((await f.reader.query({ ...scope, statuses: ['Queued'] })).data!.cards).toHaveLength(1)
    expect((await f.reader.query({ ...scope, statuses: ['In Progress'] })).data!.cards).toHaveLength(0)
    expect(await f.workflow.start(f.native, 'Firstmate')).toMatchObject({ outcome: 'saved' })
    const retained = (await f.reader.query(scope)).data!.cards
    expect(retained).toMatchObject([{ id, properties: { Status: { value: 'In Progress' } } }])
    expect((await f.reader.query({ ...scope, statuses: ['Queued'] })).data!.cards).toHaveLength(0)
    const queryCount = f.requests.filter(request => request.method === 'POST').length
    expect((await f.reader.query({ ...scope, statuses: ['In Progress'] })).data!.cards).toMatchObject([{ id, properties: { Status: { value: 'In Progress' } } }])
    expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(queryCount + 1)
    f.raw.properties[classification].has_more = false
    f.reader.confirm(await f.reader.card(id, true))
    expect((await f.reader.query(scope)).data!.cards).toHaveLength(0)
    f.raw.properties[classification].relation.push({ id: target })
    f.reader.confirm(await f.reader.card(id, true))
    expect((await f.reader.query(scope)).data!.cards).toHaveLength(1)
    expect((await f.reader.query({ ...scope, statuses: ['In Progress'] })).data!.cards).toHaveLength(1)
  })
  it('redacts complete detail readbacks and cached prose without mutating authoritative properties', async () => {
    const secret = 'token=abcdefgh12345678', github = 'ghp_abcdefghijklmnopqrstuvwx'
    const f = fixture({ body: `Acceptance ${secret} ${github}`, comment: `Evidence ${secret} ${github}` }), sources = f.sources()
    f.raw.properties['Delegated To'].rich_text = [{ plain_text: `Keep exact ${secret} ${github}` }]
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await sources.getWork({ card_id: id })
      expect(result).toMatchObject({ outcome: 'available', context: { blocks: [
        expect.objectContaining({ id: 'body-1', text: 'Acceptance token=[credential omitted] [credential omitted]' }),
        expect.objectContaining({ id: 'comment-1', text: 'Evidence token=[credential omitted] [credential omitted]' }),
      ] } })
      expect(JSON.stringify(result)).not.toContain('abcdefgh12345678')
      expect(JSON.stringify(result)).not.toContain(github)
    }
    expect(f.requests.filter(request => request.url.includes('/comments'))).toHaveLength(1)
    expect(await sources.startWork(f.external, 'Consumer')).toMatchObject({ outcome: 'saved' })
    expect((await sources.currentCard(id)).properties['Delegated To']!.value).toContain(`Keep exact ${secret} ${github}`)
    expect(JSON.stringify(f.raw.properties['Delegated To'])).toContain(secret)
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
  const f = fixture({ body: 'Acceptance token=abcdefgh12345678', comment: 'Evidence ghp_abcdefghijklmnopqrstuvwx' })
  const root = await mkdtemp(join(tmpdir(), 'workflow-mcp-')); roots.push(root)
  const sources = f.sources(root)
  const mcp = new ReconciliationMcp(sources, root)
  const server = createServer((req, res) => { void mcp.handle(req, res) }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`
  seedOriginAllowlist(port)
  const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
  const client = new Client({ name: 'workflow-test', version: '1' }); clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Tinstar-Caller': 'Tin Star UI' } } }))
  const parse = (result: any) => JSON.parse(result.content[0].text)
  const window = mcp.sessions.register(initialPresentation())
  const context = parse(await client.callTool({ name: 'get_card_context', arguments: { scene_id: window.scene_id, card_id: id } })).context
  expect(context.blocks).toContainEqual(expect.objectContaining({ id: 'comment-1', text: 'Evidence [credential omitted]' }))
  expect(JSON.stringify(context)).not.toContain('ghp_abcdefghijklmnopqrstuvwx')
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
  const detailMcp = parse(await remote.callTool({ name: 'get_work', arguments: { card_id: id } }))
  const detailUi = await fetch(`${base}/api/reconciliation/workflow`, { method: 'POST', headers: { 'X-Tinstar-UI': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'get', input: { card_id: id } }) })
  expect((await detailUi.json()).data).toEqual(detailMcp)
  expect(detailMcp.context.blocks.map((block: any) => block.text)).toEqual(['Acceptance token=[credential omitted]', 'Evidence [credential omitted]'])
  expect((await remote.listTools()).tools.map(tool => tool.name)).toContain('start_work')
  expect((await remote.listTools()).tools.map(tool => tool.name)).not.toContain('present_view')
  expect(parse(await remote.callTool({ name: 'start_work', arguments: { ...f.external, operation_id: 'tunnel-start' } })).outcome).toBe('saved')
  expect(f.raw.properties['Last touched by'].rich_text[0].text.content).toBe('owner-chatgpt')
  for (const update of [
    { kind: 'edit', note: 'Fixture interface parity note', content: { brief: 'One shared application implementation' } },
    { kind: 'assign', owner: 'Firstmate', status: 'Queued' },
    { kind: 'checkpoint', checkpoint: { assessment: 'Verified the connected behavior', evidence: 'Fixture transport readback', next_action: 'Continue this test', next_check_in: new Date(Date.now() + 3600_000).toISOString(), confirmation: 'owner-confirmed' } },
    { kind: 'wait', dependency: 'Owner acceptance', unblocks_when: 'Acceptance received', follow_up_by: 'Consumer' },
    { kind: 'request_decision', request_id: 'parity-ask', question: 'Use this disposition?', requested_from: 'Will' },
    { kind: 'answer_decision', request_id: 'parity-ask', answer: 'Resume from the queue', next: { owner: 'Firstmate', status: 'Queued' } },
    { kind: 'complete', disposition: 'Accepted fixture behavior', evidence: 'Acceptance receipt fixture' },
    { kind: 'park', disposition: 'Parked fixture after explicit acceptance', status: 'Backlog' },
  ]) {
    const input = { card_id: id, operation_id: `parity-${update.kind}`, ...update }
    const throughUi = await fetch(`${base}/api/reconciliation/workflow`, { method: 'POST', headers: { 'X-Tinstar-UI': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'update', input }) })
    const ui = (await throughUi.json()).data
    expect(ui, JSON.stringify(input)).toMatchObject({ outcome: 'saved' })
    expect(parse(await client.callTool({ name: 'update_work', arguments: input }))).toEqual(ui)
  }
  const create = { operation_id: 'parity-create', name: 'Created across UI/MCP', owner: 'Firstmate', area: 'Engineering', content: { brief: 'Created with a fixture source' } }
  const createdUi = await fetch(`${base}/api/reconciliation/workflow`, { method: 'POST', headers: { 'X-Tinstar-UI': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'create', input: create }) })
  const created = (await createdUi.json()).data
  expect(created).toMatchObject({ outcome: 'saved' })
  expect(parse(await client.callTool({ name: 'create_work', arguments: create }))).toEqual(created)
  expect((await remote.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['create_work', 'update_work']))
  const noAuth = await fetch(`${base}/api/reconciliation/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'update_work', arguments: { card_id: id, operation_id: 'unauthorized', kind: 'complete', disposition: 'x', evidence: 'x' } } }) })
  expect(noAuth.status).toBe(401)
  const invalid = { ...f.external, operation_id: 'no-owner' }; f.raw.properties.Owner.select = null
  const errorMcp = parse(await remote.callTool({ name: 'start_work', arguments: invalid }))
  const errorUi = await fetch(`${base}/api/reconciliation/workflow`, { method: 'POST', headers: { 'X-Tinstar-UI': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'start', input: invalid }) })
  expect((await errorUi.json()).data).toEqual(errorMcp)
})

it('keeps UI history explicit while ordinary work queries retain their own operational scope', async () => {
  const f = fixture(), sources = f.sources()
  f.raw.properties.Status.status.name = 'Done'
  expect((await sources.scene()).cards).toHaveLength(0)
  expect((await sources.scene(false, { history: true })).cards[0]!.id).toBe(id)
  expect((await sources.searchWork({})).records).toHaveLength(0)
  expect((await sources.searchWork({ history: true })).records[0]!.card!.id).toBe(id)
  expect(f.requests.filter(request => request.method === 'POST').map(request => !!request.body.filter)).toEqual([true, false])
})

it.each(['Queued', 'Done', 'Archived'])('authorizes Inspector body reads by configured board for %s cards', async status => {
  const credential = 'ghp_abcdefghijklmnopqrstuvwx'
  const f = fixture({ body: 'Acceptance: retain provenance', comment: `Evidence ${credential}` }), sources = f.sources()
  f.raw.properties.Status.status.name = status
  const server = createServer((req, res) => { void handleReconciliationRequest(sources, req, res) }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  seedOriginAllowlist(port)
  const url = `http://127.0.0.1:${port}/api/reconciliation/card-context?id=${id}`
  const allowed = await fetch(url)
  expect(allowed.status).toBe(200)
  const context = (await allowed.json()).data
  expect(context.blocks).toContainEqual(expect.objectContaining({ id: 'body-1', text: 'Acceptance: retain provenance' }))
  expect(context.blocks).toContainEqual(expect.objectContaining({ id: 'comment-1', text: 'Evidence [credential omitted]' }))
  expect(JSON.stringify(context)).not.toContain(credential)
  expect(f.comments[0].rich_text[0].plain_text).toContain(credential)
  expect(f.requests.some(request => request.method === 'POST')).toBe(false)
  expect((await fetch(url, { headers: { Origin: 'https://evil.example' } })).status).toBe(403)
  f.raw.parent.data_source_id = 'c'.repeat(32)
  const bodiesBefore = f.requests.filter(request => request.url.includes('/blocks/')).length
  expect((await fetch(url)).status).toBe(404)
  expect(f.requests.filter(request => request.url.includes('/blocks/'))).toHaveLength(bodiesBefore)
  expect((await fetch(`${url.slice(0, url.indexOf('?'))}?id=invalid`)).status).toBe(404)
})

it('uses the existing 9 AM Eastern date-only checkpoint semantics after Notion filtering', async () => {
  const f = fixture()
  expect((await f.reader.query({ checkpoint_before: '2026-11-12T13:00:00Z' })).data!.cards).toHaveLength(0)
  expect((await f.reader.query({ checkpoint_before: '2026-11-12T14:00:00Z' })).data!.cards).toHaveLength(1)
})

it('discovers an unlinked native worker without an open UI, and does not attribute it to a filtered owner', async () => {
  const f = fixture(), sources = f.sources()
  vi.spyOn(sources, 'fleetSnapshot').mockResolvedValue([f.home])
  const result = await sources.searchWork({ query: 'native-task' })
  expect(result.records).toHaveLength(0)
  expect(result.workers).toMatchObject([{ identity: { task_id: 'native-task', spawn_gen: 'native-gen' }, links: [] }])
  expect((await sources.searchWork({ owner: 'Firstmate', query: 'native-task' })).workers).toHaveLength(0)
})


describe('remaining shared workflow operations', () => {
  const input = (kind: string, extra = {}) => ({ card_id: id, operation_id: `op-${kind}`, kind, ...extra }) as UpdateWorkInput
  it('edits ordinary fields, brief/acceptance and notes without repairing imperfect existing workflow state', async () => {
    const f = fixture(); f.raw.properties.Owner.select = null; f.raw.properties.Status.status.name = 'In Progress'
    const edit = input('edit', { properties: { Priority: 'High' }, content: { brief: 'Implement bounded operations', acceptance_criteria: 'UI and MCP agree' }, note: 'Keep the unknown worker state unknown' })
    f.raw.properties.Priority = { type: 'select', select: { name: 'Low' } }
    expect(await f.workflow.update(edit, 'Consumer')).toMatchObject({ outcome: 'saved', saved_fields: ['Priority', 'Last touched by', 'brief', 'acceptance_criteria', 'note'] })
    expect(f.raw.properties.Owner.select).toBeNull()
    expect(f.raw.properties.Status.status.name).toBe('In Progress')
    expect(f.blocks.filter(block => block.id !== 'body-1')).toHaveLength(2)
    expect(f.comments).toHaveLength(2)
    expect(await f.workflow.update(edit, 'Consumer')).toMatchObject({ outcome: 'saved' })
    expect(f.comments).toHaveLength(2)
    expect(await f.workflow.update(input('edit', { operation_id: 'edit-brief', content: { brief: 'Revised implementation brief' } }), 'Consumer')).toMatchObject({ outcome: 'saved' })
    expect(f.blocks.filter(block => block.id !== 'body-1')).toHaveLength(2)
    expect(JSON.stringify(f.blocks)).toContain('Revised implementation brief')
    expect(await f.workflow.update(input('edit', { properties: { Status: 'In Progress' } }), 'Consumer')).toMatchObject({ code: 'invalid-input' })
  })
  it('queues Firstmate handoff and records structured waits without clearing unrelated waits/asks/checkpoints', async () => {
    const f = fixture(), before = structuredClone(f.raw.properties)
    expect(await f.workflow.update(input('assign', { owner: 'Firstmate', status: 'Todo', note: 'Ready to pick up' }), 'Owner')).toMatchObject({ outcome: 'saved' })
    expect(f.raw.properties.Status.status.name).toBe('Queued')
    expect(await f.workflow.update(input('wait', { dependency: 'Tariff acceptance', unblocks_when: 'Owner confirms tariff', follow_up_by: 'Consumer' }), 'Consumer')).toMatchObject({ outcome: 'saved' })
    expect(f.raw.properties.Status.status.name).toBe('Waiting For')
    const card = await f.reader.card(id, true)
    expect(card.properties['Waiting For']!.value).toContain('Preserve another request')
    expect(card.properties['Waiting For']!.value).toContain('Unblocks when: Owner confirms tariff')
    expect(f.raw.properties['Will action']).toEqual(before['Will action'])
    expect(f.raw.properties['Next check-in']).toEqual(before['Next check-in'])
    expect(await f.workflow.update(input('wait', { operation_id: 'invalid-wait', dependency: 'Unknown' }), 'Consumer')).toMatchObject({ code: 'invalid-input' })
  })
  it('answers one tracked decision, preserves another action and wait, and requires explicit next owner/status', async () => {
    const f = fixture(); f.raw.properties['Will action'].multi_select = [{ name: 'Merge' }]
    expect(await f.workflow.update(input('request_decision', { request_id: 'ask-1', question: 'Which tariff?', requested_from: 'Will' }), 'Consumer')).toMatchObject({ outcome: 'saved' })
    expect(await f.workflow.update(input('request_decision', { operation_id: 'ask-second', request_id: 'ask-2', question: 'Which version?', requested_from: 'Will' }), 'Consumer')).toMatchObject({ outcome: 'saved' })
    const answer = input('answer_decision', { request_id: 'ask-1', answer: 'Use tariff 3', next: { owner: 'Firstmate', status: 'Queued' } })
    expect(await f.workflow.update(answer, 'Owner')).toMatchObject({ outcome: 'saved' })
    expect((await f.reader.card(id, true)).properties['Will action']!.value).toEqual(['Merge', 'Decision'])
    expect((await f.reader.card(id)).properties['Waiting For']!.value).toBe('Preserve another request')
    const answer2 = input('answer_decision', { operation_id: 'answer-second', request_id: 'ask-2', answer: 'Use version 2', next: { owner: 'Firstmate', status: 'Queued' }, resolve_wait: 'Preserve another request' })
    expect(await f.workflow.update(answer2, 'Owner')).toMatchObject({ outcome: 'saved' })
    const saved = await f.reader.card(id, true)
    expect(saved.properties['Will action']!.value).toEqual(['Merge'])
    expect(saved.properties['Waiting For']!.value).toBe('')
    expect(saved.properties.Status!.value).toBe('Queued')
    expect(await f.workflow.update({ ...answer, operation_id: 'missing-next', next: undefined } as any, 'Owner')).toMatchObject({ code: 'invalid-input' })
  })
  it('answers an older Notion paragraph/comment by its exact source ID and clears only the caller-explicit legacy tag', async () => {
    const f = fixture()
    const answer = input('answer_decision', { request_id: 'body-1', answer: 'Owner accepts this specific original request', legacy_action: 'Decision', next: { owner: 'Firstmate', status: 'Queued' } })
    expect(await f.workflow.update(answer, 'Owner')).toMatchObject({ outcome: 'saved' })
    expect((await f.reader.card(id, true)).properties['Will action']!.value).toEqual(['Merge'])
    expect((await f.reader.card(id)).properties['Waiting For']!.value).toBe('Preserve another request')
    expect(await f.workflow.update({ ...answer, operation_id: 'duplicate-answer' } as any, 'Owner')).toMatchObject({ code: 'decision-not-open' })
  })
  it('requires fresh execution or a full wait when a decision answer enters those states', async () => {
    const f = fixture()
    await f.workflow.update(input('request_decision', { request_id: 'ask', question: 'Continue?', requested_from: 'Will' }), 'Consumer')
    const answer = input('answer_decision', { request_id: 'ask', answer: 'Continue with this run', next: { owner: 'Consumer', status: 'In Progress' } })
    expect(await f.workflow.update(answer, 'Owner')).toMatchObject({ code: 'worker-required' })
    expect(await f.workflow.update({ ...answer, next: { owner: 'Consumer', status: 'Waiting For' } } as any, 'Owner')).toMatchObject({ code: 'wait-required' })
    expect(await f.workflow.update({ ...answer, next: { owner: 'Consumer', status: 'In Progress', worker: f.external.worker } } as any, 'Owner')).toMatchObject({ outcome: 'saved' })
    expect((await f.reader.card(id, true)).properties.Status!.value).toBe('In Progress')
    expect((await f.reader.card(id)).properties['Delegated To']!.value).toContain('tinstar.external-worker.v1')
    expect(f.raw.properties['First Mate tasks'].rich_text).toEqual([])
  })
  it('validates appointment ceiling/date-only DST and records confirmation without advancing on ordinary edits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T23:00:00Z'))
    const f = fixture(); f.raw.properties.Status.status.name = 'In Progress'
    const cp = { assessment: 'Compiled and checked behavior', evidence: 'Fixture build and meaningful regression', next_action: 'Review output', confirmation: 'owner-confirmed', next_check_in: '2026-11-07' }
    expect(await f.workflow.update(input('checkpoint', { checkpoint: cp }), 'Owner')).toMatchObject({ code: 'checkpoint-ceiling' })
    cp.next_check_in = '2026-11-07T01:00:00Z'
    expect(await f.workflow.update(input('checkpoint', { checkpoint: cp }), 'Owner')).toMatchObject({ outcome: 'saved' })
    expect(f.comments.at(-1).rich_text.map((row: any) => row.text.content).join('')).toContain('Appointment: owner-confirmed')
    const before = structuredClone(f.raw.properties['Next check-in'])
    await f.workflow.update(input('edit', { note: 'Ordinary activity and checkpoint stay independent' }), 'Consumer')
    expect(f.raw.properties['Next check-in']).toEqual(before)
    vi.setSystemTime(new Date('2026-11-01T01:00:00Z'))
    const dst = fixture(); dst.raw.properties.Status.status.name = 'Waiting For'
    cp.next_check_in = '2026-11-01'
    expect(await dst.workflow.update(input('checkpoint', { operation_id: 'dst-day', checkpoint: { ...cp, confirmation: 'provisional' } }), 'Consumer')).toMatchObject({ outcome: 'saved' })
    expect(dst.raw.properties['Next check-in'].date.start).toBe('2026-11-01T14:00:00.000Z')
  })
  it('repairs only a missing note once on an unchanged card and preserves the partial result on a changed card', async () => {
    for (const changed of [false, true]) {
      const f = fixture(); f.controls.failNote()
      const assign = input('assign', { owner: 'Other consumer' })
      const partial = await f.workflow.update(assign, 'Owner')
      expect(partial).toMatchObject({ outcome: 'partially-saved', saved_fields: ['Owner', 'Status', 'Last touched by'] })
      f.controls.failNote(false)
      if (changed) f.raw.properties.Priority = { type: 'select', select: { name: 'High' } }
      const writes = f.requests.filter(r => ['PATCH', 'POST'].includes(r.method)).length
      const retry = await f.workflow.update(assign, 'Owner')
      if (changed) {
        expect(retry).toMatchObject({ outcome: 'partially-saved', code: 'card-changed', saved_fields: partial.saved_fields })
        expect(retry.message).toContain('re-issue')
        expect(f.requests.filter(r => ['PATCH', 'POST'].includes(r.method))).toHaveLength(writes)
        expect(f.comments).toHaveLength(1)
      } else {
        expect(retry).toMatchObject({ outcome: 'saved' })
        expect(f.requests.filter(r => ['PATCH', 'POST'].includes(r.method))).toHaveLength(writes + 1)
        await f.workflow.update(assign, 'Owner')
        expect(f.comments).toHaveLength(2)
      }
    }
  })
  it('preserves worker history/asks on explicit completion/parking and allows corrective closure on imperfect cards', async () => {
    const f = fixture(); await f.workflow.start(f.external, 'Consumer')
    const old = (await f.reader.card(id, true)).properties['Delegated To']!.value
    f.raw.properties.Area.select = null
    expect(await f.workflow.update(input('complete', { disposition: 'Owner accepted required output', evidence: 'Owner acceptance receipt' }), 'Consumer')).toMatchObject({ outcome: 'saved' })
    expect((await f.reader.card(id, true)).properties['Delegated To']!.value).toBe(old)
    expect((await f.reader.card(id)).properties['Will action']!.value).toEqual(['Merge', 'Decision'])
    expect(await f.workflow.update(input('park', { disposition: 'Owner deferred further work', status: 'Archived' }), 'Consumer')).toMatchObject({ outcome: 'saved' })
    expect((await f.reader.card(id, true)).properties.Status!.value).toBe('Archived')
  })
  it('preserves confirmed creation and its receipt after body verification rejection', async () => {
    for (const status of [403, 429]) {
      const f = fixture()
      const root = await mkdtemp(join(tmpdir(), 'workflow-create-readback-')); roots.push(root)
      const workflow = new WorkflowOperations(f.reader, async () => [], root)
      const create = { operation_id: `create-readback-${status}`, name: 'Created before read failure', owner: 'Firstmate', area: 'Engineering', content: { brief: 'Preserve this card' } }
      const request = WorkflowContent.prototype.request
      const spy = vi.spyOn(WorkflowContent.prototype, 'request').mockImplementation(function (this: WorkflowContent, path, method, body) {
        if (path.startsWith(`blocks/${'c'.repeat(32)}/children?`)) return Promise.reject(new NotionWriteError(status))
        return request.call(this, path, method, body)
      })
      try {
        expect(await workflow.create(create, 'Owner')).toMatchObject({
          outcome: 'partially-saved', code: 'create-unconfirmed', card: { id: 'c'.repeat(32) },
          saved_fields: expect.arrayContaining(['card', 'Name', 'Owner', 'Status', 'Area', 'Last touched by']),
        })
      } finally { spy.mockRestore() }
      f.pages.get('c'.repeat(32)).properties.Name.title = [{ plain_text: 'Human renamed the saved card' }]
      const restarted = new WorkflowOperations(f.reader, async () => [], root)
      expect(await restarted.create(create, 'Owner')).toMatchObject({ outcome: 'saved', code: 'already-saved', card: { id: 'c'.repeat(32) } })
      expect(f.requests.filter(request => request.method === 'POST' && request.url.endsWith('/pages'))).toHaveLength(1)
      expect(f.pages.size).toBe(2)
    }
  })
  it('creates a real card with required classification/content and recovers a lost create response across restart', async () => {
    const f = fixture(); f.controls.lostCreate()
    const create = { operation_id: 'create-once', name: 'New fixture card', owner: 'Firstmate', area: 'Engineering', status: 'Todo' as const, content: { brief: 'Implement the supported workflow', acceptance_criteria: 'Changes are visible in both interfaces' } }
    expect(await f.workflow.create(create, 'Owner')).toMatchObject({ outcome: 'partially-saved', code: 'create-unconfirmed' })
    const restarted = new WorkflowOperations(f.reader, async () => [])
    expect(await restarted.create(create, 'Owner')).toMatchObject({ outcome: 'saved', card: { id: 'c'.repeat(32), properties: { Status: { value: 'Queued' }, Area: { value: 'Engineering' } } } })
    expect(f.requests.filter(request => request.method === 'POST' && request.url.endsWith('/pages'))).toHaveLength(1)
    expect(f.pages.size).toBe(2)
    expect(await restarted.create({ ...create, owner: '' }, 'Owner')).toMatchObject({ code: 'invalid-input' })
  })
})

it('rejects partial wait cleanup and removes only the complete selected entry', async () => {
  const f = fixture()
  f.raw.properties['Waiting For'].rich_text = [{ plain_text: 'Wait for security approval\nWait for legal approval' }]
  const answer = { card_id: id, operation_id: 'wait-partial', kind: 'answer_decision', request_id: 'body-1', answer: 'Security approved', next: { owner: 'Firstmate', status: 'Queued' }, resolve_wait: 'security approval' } as UpdateWorkInput
  expect(await f.workflow.update(answer, 'Owner')).toMatchObject({ code: 'wait-conflict' })
  expect(await f.workflow.update({ ...answer, operation_id: 'wait-full', resolve_wait: 'Wait for security approval' } as UpdateWorkInput, 'Owner')).toMatchObject({ outcome: 'saved' })
  expect((await f.reader.card(id, true)).properties['Waiting For']!.value).toBe('Wait for legal approval')
})

it('keeps multiline wait inputs within one deduplicated, exactly removable entry', async () => {
  const f = fixture()
  const wait = { card_id: id, operation_id: 'multiline-wait', kind: 'wait', dependency: 'Security approval\nLegal approval', unblocks_when: 'Both approve\nRecord evidence', follow_up_by: 'Owner' } as UpdateWorkInput
  expect(await f.workflow.update(wait, 'Owner')).toMatchObject({ outcome: 'saved' })
  const first = String((await f.reader.card(id, true)).properties['Waiting For']!.value)
  expect(await f.workflow.update({ ...wait, operation_id: 'dedupe-wait' }, 'Owner')).toMatchObject({ outcome: 'saved' })
  expect((await f.reader.card(id, true)).properties['Waiting For']!.value).toBe(first)
  const entry = first.split('\n')[1]!
  const answer = { card_id: id, operation_id: 'resolve-multiline', kind: 'answer_decision', request_id: 'body-1', answer: 'Both approvals received', next: { owner: 'Firstmate', status: 'Queued' }, resolve_wait: entry } as UpdateWorkInput
  expect(await f.workflow.update({ ...answer, operation_id: 'partial-multiline', resolve_wait: 'Legal approval' } as UpdateWorkInput, 'Owner')).toMatchObject({ code: 'wait-conflict' })
  expect(await f.workflow.update(answer, 'Owner')).toMatchObject({ outcome: 'saved' })
  expect((await f.reader.card(id, true)).properties['Waiting For']!.value).toBe('Preserve another request')
})
it('keeps cached broader declarations separate from watchdog eligibility without a new broad scan', async () => {
  const f = fixture(); f.raw.properties.Status.status.name = 'In Progress'
  const other = structuredClone(f.raw); other.id = 'd'.repeat(32); other.properties.Owner.select.name = 'Other'; other.properties.Status.status.name = 'Queued'
  f.pages.set(other.id, other)
  const sources = f.sources()
  expect((await sources.checkInSnapshot()).intentions.coverage).toBe('unknown')
  await sources.snapshot()
  const queries = f.requests.filter(r => r.url.endsWith('/query')).length
  const snapshot = await sources.checkInSnapshot()
  expect(snapshot.intentions.data!.cards.map(c => c.id)).toContain(other.id)
  expect(snapshot.checkIns!.data!.cards.map(c => c.id)).toEqual([id])
  expect(f.requests.filter(r => r.url.endsWith('/query'))).toHaveLength(queries)
})


it.each(['conflict', 'card-changed', 'readback-mismatch'])('marks definite %s results for a fresh operation and retains the flag on cached partials', async code => {
  const f = fixture()
  const input = { card_id: id, operation_id: `reissue-${code}`, kind: 'assign', owner: 'Other consumer' } as UpdateWorkInput
  if (code === 'conflict') input.expected = { Owner: 'Changed owner' }
  else if (code === 'card-changed') {
    f.controls.failNote()
    const uncertain = await f.workflow.update(input, 'Owner')
    expect(uncertain.outcome).toBe('partially-saved')
    expect(uncertain.requires_new_operation_id).not.toBe(true)
    f.controls.failNote(false)
    f.raw.properties.Priority = { type: 'select', select: { name: 'High' } }
  } else f.controls.partial()
  const result = await f.workflow.update(input, 'Owner')
  expect(result).toMatchObject({ code, requires_new_operation_id: true })
  const writes = f.requests.filter(r => ['POST', 'PATCH'].includes(r.method)).length
  expect(await f.workflow.update(input, 'Owner')).toEqual(result)
  expect(f.requests.filter(r => ['POST', 'PATCH'].includes(r.method))).toHaveLength(writes)
})

it.each(['\n', '\r\n', '\r'])('saves multiline checkpoint prose that round-trips through the watchdog verifier (%j)', async newline => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T15:00:00Z'))
  const f = fixture()
  f.raw.properties['Next action'] = { type: 'rich_text', rich_text: [] }
  const requestId = '11111111-1111-4111-8111-111111111111'
  const checkpoint = {
    request_id: requestId, assessment: `Done${newline}Build and tests passed`, evidence: `None${newline}Fixture build and test receipts`,
    blocker: `None${newline}Owner acceptance pending`, next_action: `Review${newline}Confirm output`,
    next_check_in: '2026-11-10T17:00:00Z', confirmation: 'owner-confirmed',
  }
  expect(await f.workflow.update({ card_id: id, operation_id: 'multiline-checkpoint', kind: 'checkpoint', checkpoint } as UpdateWorkInput, 'Firstmate')).toMatchObject({ outcome: 'saved' })
  const savedNote = f.comments.at(-1).rich_text.map((part: any) => part.text.content).join('')
  expect(checkInReport(savedNote, requestId)).toEqual({
    'Check-in request': requestId, Date: '2026-11-10T15:00:00.000Z', By: 'Firstmate',
    Progress: 'Done Build and tests passed', Evidence: 'None Fixture build and test receipts',
    'Blocker/owner': 'None Owner acceptance pending', 'Next action': 'Review Confirm output', 'Next check-in': '2026-11-10T17:00:00.000Z',
  })
  expect((await f.reader.card(id, true)).properties['Next action']!.value).toBe(checkpoint.next_action)
  expect(checkInReport(savedNote, '22222222-2222-4222-8222-222222222222')).toBeNull()
})

it.each([
  { field: 'assessment', value: 'Done\nBuild and tests passed', accepted: true },
  { field: 'assessment', value: 'Tests passed', accepted: true },
  { field: 'evidence', value: 'Receipt1', accepted: true },
  { field: 'blocker', value: 'none', accepted: true },
  { field: 'evidence', value: 'still working', accepted: false },
  { field: 'evidence', value: 'still\nworking', accepted: false },
  { field: 'assessment', value: 'Tests\n\n\npass', accepted: false },
  { field: 'evidence', value: 'PR\n\n\n1234', accepted: false },
  { field: 'assessment', value: '<complete update>', accepted: false },
  { field: 'evidence', value: '<evidence>', accepted: false },
  { field: 'blocker', value: '<owner\nname>', accepted: false },
  { field: 'next_action', value: '<next\nstep>', accepted: false },
])('uses verifier policy before writing serialized $field=$value', async ({ field, value, accepted }) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T15:00:00Z'))
  for (const correlated of [true, false]) {
    const f = fixture()
    const requestId = '11111111-1111-4111-8111-111111111111'
    const checkpoint = { assessment: 'Build and tests passed', evidence: 'Successful fixture receipt', blocker: 'none', next_action: 'Review output',
      next_check_in: '2026-11-10T17:00:00Z', confirmation: 'provisional', ...(correlated ? { request_id: requestId } : {}), [field]: value }
    const normalized = (text: string) => text.trim().split(/\s+/).join(' ')
    const candidate = `Check-in request: ${requestId}\nDate: 2026-11-10T15:00:00.000Z\nBy: Firstmate\nProgress: ${normalized(checkpoint.assessment)}\nEvidence: ${normalized(checkpoint.evidence)}\nBlocker/owner: ${normalized(checkpoint.blocker)}\nNext action: ${normalized(checkpoint.next_action)}\nNext check-in: 2026-11-10T17:00:00.000Z`
    expect(checkInReport(candidate, requestId) !== null).toBe(accepted)
    const result = await f.workflow.update({ card_id: id, operation_id: 'verifier-policy', kind: 'checkpoint', checkpoint } as UpdateWorkInput, 'Firstmate')
    if (accepted) {
      expect(result.outcome).toBe('saved')
      const note = f.comments.at(-1).rich_text.map((part: any) => part.text.content).join('')
      expect(checkInReport(correlated ? note : `Check-in request: ${requestId}\n${note}`, requestId)).not.toBeNull()
      if (!correlated) expect(note).not.toContain('Check-in request:')
    } else {
      expect(result).toMatchObject({ outcome: 'not-saved', code: 'invalid-checkpoint', saved_fields: [] })
      expect(f.requests.filter(r => ['PATCH', 'POST'].includes(r.method))).toHaveLength(0)
      expect(f.comments).toHaveLength(1)
    }
  }
})


it.each(['brief', 'acceptance_criteria'] as const)('distinguishes definite %s conflicts from uncertain section writes', async name => {
  for (const failure of ['changed', 'duplicate', 'uncertain'] as const) {
    const f = fixture()
    const original = `Tin Star section: ${name}\nOriginal content`
    f.blocks.push({ id: 'managed', type: 'paragraph', paragraph: { rich_text: [{ plain_text: original }] } })
    let reads = 0
    f.controls.onRead(() => {
      if (++reads !== 2) return
      if (failure === 'changed') f.blocks[1].paragraph.rich_text = [{ plain_text: `Tin Star section: ${name}\nHuman edit` }]
      if (failure === 'duplicate') f.blocks.push({ ...structuredClone(f.blocks[1]), id: 'duplicate' })
    })
    const request = WorkflowContent.prototype.request
    const spy = vi.spyOn(WorkflowContent.prototype, 'request').mockImplementation(function (this: WorkflowContent, path, method, body) {
      if (failure === 'uncertain' && path === 'blocks/managed' && method === 'PATCH') return Promise.reject(new Error('Lost API response'))
      return request.call(this, path, method, body)
    })
    try {
      const input = { card_id: id, operation_id: `section-${name}-${failure}`, kind: 'edit', content: { [name]: 'Replacement content' } } as UpdateWorkInput
      const result = await f.workflow.update(input, 'Consumer')
      expect(result).toMatchObject({ outcome: 'partially-saved', code: failure === 'uncertain' ? 'save-unconfirmed' : 'conflict', saved_fields: ['Last touched by'] })
      expect(result.requires_new_operation_id).toBe(failure === 'uncertain' ? undefined : true)
      expect(f.comments).toHaveLength(1)
      expect(f.blocks[1].paragraph.rich_text[0].plain_text).toBe(failure === 'changed' ? `Tin Star section: ${name}\nHuman edit` : original)
      const calls = f.requests.length
      expect(await f.workflow.update(input, 'Consumer')).toEqual(result)
      expect(f.requests).toHaveLength(calls)
      if (failure !== 'uncertain') {
        f.blocks.splice(2)
        expect(await f.workflow.update({ ...input, operation_id: `${input.operation_id}-fresh` }, 'Consumer')).toMatchObject({ outcome: 'saved', saved_fields: ['Last touched by', name, 'note'] })
      }
    } finally { spy.mockRestore() }
  }
})


it.each(['property', 'body', 'comment'] as const)('preserves an unobserved human %s edit across the real workflow self-write callbacks', async kind => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T15:00:00Z'))
  const f = fixture(); f.raw.properties.Status.status.name = 'In Progress'
  const root = await mkdtemp(join(tmpdir(), 'workflow-self-update-')); roots.push(root)
  const sources = f.sources(root)
  const feed = new FirstmateUpdates({
    firstmateWork: async () => ({ status: 'fresh', coverage: 'complete', data: { cards: [await f.reader.card(id, true)] } }) as any,
    currentCard: cardId => f.reader.card(cardId, true), updateComments: (cardId, force) => sources.updateComments(cardId, force), updateContext: cardId => sources.updateContext(cardId),
  }, root, async () => ({ deliveryEnabled: true }))
  f.workflow.onChange = change => feed.confirmed(change)
  await feed.sweep(true)
  const initial = await f.reader.card(id, true)
  await feed.confirmed({ before: initial, card: initial, properties: {}, actor: 'Firstmate', operationId: 'baseline' })
  vi.setSystemTime(new Date('2026-11-10T15:01:00Z'))
  f.raw.last_edited_time = new Date().toISOString()
  if (kind === 'property') f.raw.properties['Waiting For'].rich_text = [{ plain_text: 'Human dependency' }]
  if (kind === 'body') f.blocks[0].paragraph.rich_text = [{ plain_text: 'Human revised body' }]
  if (kind === 'comment') f.comments.push({ id: 'human', created_by: { id: 'human-author' }, created_time: new Date().toISOString(), rich_text: [{ plain_text: 'Human evidence' }] })
  expect(await f.workflow.update({ kind: 'edit', card_id: id, operation_id: 'self-note', note: 'Unrelated self note' }, 'Firstmate')).toMatchObject({ outcome: 'saved' })
  vi.setSystemTime(new Date('2026-11-10T15:02:00Z'))
  const notices = (await feed.bridgeWork()).pending
  expect(notices).toHaveLength(1)
  const batch = JSON.parse(notices[0]!.body.split('\n').slice(1).join('\n'))
  expect(batch.actor).toBe('Notion actor unknown')
  const change = batch.changes[0]
  if (kind === 'property') expect(change.properties['Waiting For'].after).toBe('Human dependency')
  if (kind === 'body') expect(change.body_sections).toEqual(['body-1'])
  if (kind === 'comment') expect(change.comments).toEqual([{ id: 'human', text: 'Human evidence', author: 'human-author' }])
  expect(change.comments.some((comment: { text: string }) => comment.text.includes('Unrelated self note'))).toBe(false)
  await feed.ingest({ request_id: notices[0]!.request_id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', saved: true, acknowledged: false, announced: true, id: 'fixture-note', request_id: inboxRequestId(notices[0]!.request_id) } })
  const persisted = JSON.parse(await readFile(feed.path, 'utf8'))
  expect(persisted.batches).toHaveLength(1)
  expect(await f.workflow.update({ kind: 'edit', card_id: id, operation_id: 'another-self-note', note: 'Self-only follow-up' }, 'Firstmate')).toMatchObject({ outcome: 'saved' })
  expect(JSON.parse(await readFile(feed.path, 'utf8')).batches).toHaveLength(1)
})


it.each(['brief', 'acceptance_criteria'] as const)('observes confirmed %s before a failed note and repairs only the note without self-waking', async name => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T15:00:00Z'))
  const f = fixture(); f.raw.properties.Status.status.name = 'In Progress'
  const root = await mkdtemp(join(tmpdir(), 'workflow-section-repair-')); roots.push(root)
  const sources = f.sources(root)
  const feed = new FirstmateUpdates({
    firstmateWork: async () => ({ status: 'fresh', coverage: 'complete', data: { cards: [await f.reader.card(id, true)] } }) as any,
    currentCard: cardId => f.reader.card(cardId, true), updateComments: (cardId, force) => sources.updateComments(cardId, force), updateContext: cardId => sources.updateContext(cardId),
  }, root, async () => ({ deliveryEnabled: true }))
  const changes: Array<{ sections?: string[]; notes?: string[] }> = []
  f.workflow.onChange = async change => { changes.push(change); await feed.confirmed(change) }
  await feed.sweep(true)
  const initial = await f.reader.card(id, true)
  await feed.confirmed({ before: initial, card: initial, properties: {}, actor: 'Firstmate', operationId: 'baseline' })
  const input = { kind: 'edit', card_id: id, operation_id: 'section-repair', content: { [name]: 'Confirmed self section' }, note: 'History for section' } as UpdateWorkInput
  f.controls.failNote()
  expect(await f.workflow.update(input, 'Firstmate')).toMatchObject({ outcome: 'partially-saved', saved_fields: ['Last touched by', name] })
  expect(changes.filter(change => change.sections?.includes(name))).toHaveLength(1)
  vi.setSystemTime(new Date('2026-11-10T15:01:00Z'))
  expect((await feed.bridgeWork()).pending).toEqual([])
  const sectionWrites = () => f.requests.filter(request => request.method === 'PATCH' && request.url.includes('/blocks/')).length
  const writes = sectionWrites()
  f.controls.failNote(false)
  expect(await f.workflow.update(input, 'Firstmate')).toMatchObject({ outcome: 'saved', saved_fields: ['Last touched by', name, 'note'] })
  expect(sectionWrites()).toBe(writes)
  expect(changes.filter(change => change.sections?.includes(name))).toHaveLength(1)
  expect(changes.filter(change => change.notes?.length)).toHaveLength(1)
  await feed.sweep(true)
  vi.setSystemTime(new Date('2026-11-10T15:02:00Z'))
  expect((await feed.bridgeWork()).pending).toEqual([])
  f.raw.last_edited_time = new Date().toISOString()
  f.raw.properties['Waiting For'].rich_text = [{ plain_text: 'Unrelated human dependency' }]
  await feed.sweep(true)
  vi.setSystemTime(new Date('2026-11-10T15:03:00Z'))
  const notices = (await feed.bridgeWork()).pending
  expect(notices).toHaveLength(1)
  const batch = JSON.parse(notices[0]!.body.split('\n').slice(1).join('\n'))
  expect(batch.actor).toBe('Notion actor unknown')
  expect(batch.changes[0].properties['Waiting For'].after).toBe('Unrelated human dependency')
})

it('observes comment-only edits through rotating and explicit refreshes without routine body reads or self wakes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T15:00:00Z'))
  const f = fixture(); f.raw.properties.Status.status.name = 'In Progress'
  const cardIds = [id, ...Array.from({ length: 8 }, (_, index) => (index + 1).toString(16).padStart(32, '0'))]
  for (const [index, cardId] of cardIds.entries()) {
    if (cardId === id) continue
    const page = { ...structuredClone(f.raw), id: cardId }
    page.properties.Status.status.name = index % 2 ? 'Waiting For' : 'In Progress'
    f.pages.set(cardId, page)
  }
  const comments = new Map(cardIds.map(cardId => [cardId, [] as any[]]))
  const fetcher = f.fetcher.getMockImplementation()!
  f.fetcher.mockImplementation(async (url, init) => {
    const parsed = new URL(String(url))
    if (parsed.pathname === '/v1/comments') return json({ has_more: false, results: comments.get(parsed.searchParams.get('block_id')!) ?? [] })
    return fetcher(url, init)
  })
  const root = await mkdtemp(join(tmpdir(), 'workflow-comment-rotation-')); roots.push(root)
  const sources = f.sources(root), feed = new FirstmateUpdates(sources, root, async () => ({ deliveryEnabled: true }))
  sources.onWorkRefresh = async cards => { for (const card of cards) await feed.refreshComments(card) }
  const comment = (commentId: string, text: string) => ({ id: commentId, created_by: { id: 'human-author' }, created_time: new Date().toISOString(), rich_text: [{ plain_text: text }] })
  await feed.sweep(true)
  expect(f.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/comments')).toHaveLength(9)
  expect(f.requests.filter(request => request.url.includes('/blocks/'))).toHaveLength(0)
  const self = `Confirmed self note\n${receiptMarker('Firstmate', 'self-comment')}`
  comments.get(id)!.push(comment('self-comment-id', self))
  const current = await sources.currentCard(id)
  await feed.confirmed({ before: current, card: current, actor: 'Firstmate', operationId: 'self-comment', properties: {}, notes: ['Confirmed self note'] })
  expect((await feed.bridgeWork()).pending).toEqual([])
  for (const cardId of cardIds) comments.get(cardId)!.push(comment(`human-${cardId}`, 'Human comment without property edits'))
  const bodyReads = f.requests.filter(request => request.url.includes('/blocks/')).length
  const observed = new Set<string>()
  for (let cycle = 0; cycle < 3; cycle++) {
    vi.setSystemTime(new Date(Date.now() + 60_001))
    f.fetcher.mockClear()
    await feed.sweep()
    expect(f.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/comments').length).toBeLessThanOrEqual(4)
    expect(f.requests.filter(request => request.url.includes('/blocks/'))).toHaveLength(bodyReads)
    vi.setSystemTime(new Date(Date.now() + 10_001))
    const notices = (await feed.bridgeWork()).pending
    for (const notice of notices) {
      const changes = JSON.parse(notice.body.split('\n').slice(1).join('')).changes
      for (const change of changes) {
        expect(change).toMatchObject({ kind: 'update', body_sections: [], comments: [{ id: `human-${change.card_id}`, author: 'human-author' }] })
        expect(observed.has(change.card_id)).toBe(false)
        observed.add(change.card_id)
      }
      await feed.ingest({ request_id: notice.request_id, error: 'wake-failed' })
    }
    expect((await feed.bridgeWork()).pending).toEqual(notices)
    for (const notice of notices) await feed.ingest({ request_id: notice.request_id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', saved: true, acknowledged: false, announced: true, id: notice.request_id, request_id: inboxRequestId(notice.request_id) } })
  }
  expect([...observed].sort()).toEqual([...cardIds].sort())
  comments.get(id)!.push(comment('forced-comment', 'Forced refresh human input'))
  f.fetcher.mockClear()
  await feed.sweep(true)
  expect(f.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/comments')).toHaveLength(9)
  vi.setSystemTime(new Date(Date.now() + 10_001))
  const forced = (await feed.bridgeWork()).pending
  expect(forced).toHaveLength(1)
  expect(JSON.parse(forced[0]!.body.split('\n').slice(1).join('')).changes[0].comments).toEqual([{ id: 'forced-comment', text: 'Forced refresh human input', author: 'human-author' }])
  await feed.ingest({ request_id: forced[0]!.request_id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', saved: true, acknowledged: false, announced: true, id: forced[0]!.request_id, request_id: inboxRequestId(forced[0]!.request_id) } })
  comments.get(id)!.push(comment('explicit-comment', 'Immediate human input'))
  await sources.getWork({ card_id: id, refresh: true, details: false })
  vi.setSystemTime(new Date(Date.now() + 10_001))
  const explicit = (await feed.bridgeWork()).pending
  expect(explicit).toHaveLength(1)
  expect(JSON.parse(explicit[0]!.body.split('\n').slice(1).join('')).changes[0]).toMatchObject({ kind: 'update', comments: [{ id: 'explicit-comment', text: 'Immediate human input', author: 'human-author' }] })
})

it('does not wake for successful Firstmate notes when unsupported body blocks leave context partial', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T15:00:00Z'))
  const f = fixture(); f.raw.properties.Status.status.name = 'In Progress'
  f.blocks.push({ id: 'unsupported-image', type: 'image', image: { type: 'external', external: { url: 'https://fixture.example/image.png' } } })
  const root = await mkdtemp(join(tmpdir(), 'workflow-self-comment-partial-body-')); roots.push(root)
  const sources = f.sources(root), feed = new FirstmateUpdates(sources, root, async () => ({ deliveryEnabled: true }))
  sources.workflow.onChange = change => feed.confirmed(change)
  await feed.sweep(true)
  expect(await sources.updateContext(id)).toMatchObject({ outcome: 'partial', commentsOutcome: 'available' })
  for (let round = 0; round < 2; round++) {
    vi.setSystemTime(new Date(Date.now() + 60_001))
    expect(await sources.updateWork({ card_id: id, operation_id: `self-note-${round}`, kind: 'edit', note: `Confirmed Firstmate note ${round}` }, 'Firstmate')).toMatchObject({ outcome: 'saved' })
    const note = f.comments.at(-1).rich_text.map((part: any) => part.text.content).join('')
    expect(note).toContain(receiptMarker('Firstmate', `self-note-${round}`))
    vi.setSystemTime(new Date(Date.now() + 60_001))
    await feed.sweep()
    vi.setSystemTime(new Date(Date.now() + 10_001))
    expect((await feed.bridgeWork()).pending).toEqual([])
  }
  f.comments.push({ id: 'human-after-self', created_by: { id: 'human-author' }, created_time: new Date().toISOString(), rich_text: [{ plain_text: 'Human comment remains actionable' }] })
  vi.setSystemTime(new Date(Date.now() + 60_001))
  await feed.sweep()
  vi.setSystemTime(new Date(Date.now() + 10_001))
  const notices = (await feed.bridgeWork()).pending
  expect(notices).toHaveLength(1)
  expect(JSON.parse(notices[0]!.body.split('\n').slice(1).join('')).changes[0]).toMatchObject({ kind: 'update', comments: [{ id: 'human-after-self', text: 'Human comment remains actionable', author: 'human-author' }] })
})

it.each(['brief', 'acceptance_criteria', 'both-sections', 'note', 'comment', 'property'] as const)('retains confirmed %s effects across successful callbacks with partial body context', async effect => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T15:00:00Z'))
  const f = fixture(); f.raw.properties.Status.status.name = 'In Progress'
  for (const name of ['brief', 'acceptance_criteria']) f.blocks.push({ id: name, type: 'paragraph', paragraph: { rich_text: [{ plain_text: `Tin Star section: ${name}\nOriginal ${name}` }] } })
  const root = await mkdtemp(join(tmpdir(), 'workflow-confirmed-effects-')); roots.push(root)
  const sources = f.sources(root), feed = new FirstmateUpdates(sources, root, async () => ({ deliveryEnabled: true }))
  sources.workflow.onChange = change => feed.confirmed(change)
  await feed.sweep(true)
  const initial = await sources.currentCard(id)
  await feed.confirmed({ before: initial, card: initial, actor: 'Firstmate', operationId: 'baseline', properties: {} })
  f.blocks.push({ id: 'unsupported-image', type: 'image', image: {} })
  vi.setSystemTime(new Date(Date.now() + 60_001)); f.raw.last_edited_time = new Date().toISOString()
  await feed.sweep(true)
  vi.setSystemTime(new Date(Date.now() + 10_001))
  for (const notice of (await feed.bridgeWork()).pending) await feed.ingest({ request_id: notice.request_id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', saved: true, acknowledged: false, announced: true, id: notice.request_id, request_id: inboxRequestId(notice.request_id) } })
  const content = effect === 'both-sections' ? { brief: 'Confirmed brief', acceptance_criteria: 'Confirmed acceptance' }
    : effect === 'brief' || effect === 'acceptance_criteria' ? { [effect]: `Confirmed ${effect}` } : undefined
  for (let round = 0; round < 2; round++) {
    vi.setSystemTime(new Date(Date.now() + 60_001))
    expect(await sources.updateWork({ card_id: id, operation_id: `confirmed-${effect}-${round}`, kind: 'edit',
      ...(round === 0 && content ? { content } : {}), ...(round === 0 && effect === 'property' ? { properties: { Name: 'Confirmed name' } } : {}),
      note: `Confirmed history ${round}` }, 'Firstmate')).toMatchObject({ outcome: 'saved' })
    vi.setSystemTime(new Date(Date.now() + 60_001))
    await feed.sweep()
    vi.setSystemTime(new Date(Date.now() + 10_001))
    expect((await feed.bridgeWork()).pending).toEqual([])
  }
  f.blocks[0].paragraph.rich_text = [{ plain_text: 'Human changed an unrelated paragraph' }]
  vi.setSystemTime(new Date(Date.now() + 60_001)); f.raw.last_edited_time = new Date().toISOString()
  await feed.sweep(true)
  vi.setSystemTime(new Date(Date.now() + 10_001))
  const human = (await feed.bridgeWork()).pending
  expect(human).toHaveLength(1)
  expect(JSON.parse(human[0]!.body.split('\n').slice(1).join('')).changes[0].body_sections).toEqual(['body-1'])
})
